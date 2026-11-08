const mongoose = require('mongoose');
const { createApp } = require('./app');
const mqtt = require('mqtt');
const { ingestStatus, ingestDisconnect } = require('./ingestion');
const { createMissionModel, createMissionStore } = require('./missions');
const { createCommandModel, createCommandService } = require('./commands');
const { createHistory } = require('./history');
const { createAuditModel } = require('./audit');
const { createAiTools } = require('./ai-tools');
const { createAssistant } = require('./assistant');
const { createConfiguredModel } = require('./llm');

async function main() {
  const { MONGODB_URI, JWT_SECRET } = process.env;
  const port = Number(process.env.PORT || 3000);
  const staleAfterMs = Number(process.env.STALE_AFTER_MS || 60000);
  const complete = createConfiguredModel();
  if (!MONGODB_URI || !JWT_SECRET || JWT_SECRET.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1000) {
    throw new Error('Set MONGODB_URI, JWT_SECRET (at least 32 characters), a valid PORT and STALE_AFTER_MS (at least 1000)');
  }
  await mongoose.connect(MONGODB_URI);
  const schema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    capabilities: { type: [String], default: [] },
    connectivityState: { type: String, default: 'offline' },
    operationalState: { type: String, default: 'unknown' },
    lastSeenAt: { type: Date, default: null },
    activeMissionId: { type: String, default: null },
    sessionId: { type: String, default: null },
    disconnectedSessionId: { type: String, default: null },
  }, { timestamps: true, versionKey: false });
  const Device = mongoose.model('Device', schema);
  await Device.init();
  const eventSchema = new mongoose.Schema({
    deviceId: { type: String, required: true },
    messageId: { type: String, required: true },
    timestamp: { type: Date, required: true },
    type: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    sessionId: String,
  }, { versionKey: false });
  eventSchema.index({ deviceId: 1, messageId: 1 }, { unique: true });
  const Event = mongoose.model('Event', eventSchema);
  await Event.init();
  const Mission = createMissionModel(mongoose);
  await Mission.init();
  const Audit = createAuditModel(mongoose);
  await Audit.init();
  const missions = createMissionStore(Mission, Device, mongoose.connection, staleAfterMs, Audit);
  const Command = createCommandModel(mongoose);
  await Command.init();
  const history = createHistory({ Device, Event, Command, Audit, Mission, staleAfterMs });
  const devices = {
    create: async (input) => (await Device.create(input)).toObject(),
    async list({ limit } = {}) {
      const now = Date.now();
      let query = Device.find();
      if (Number.isInteger(limit) && limit > 0) query = query.limit(limit);
      return (await query.lean()).map((device) => ({ ...device, stale: !device.lastSeenAt || now - device.lastSeenAt.getTime() > staleAfterMs }));
    },
    async get(deviceId) { const device = await Device.findOne({ deviceId }).lean(); return device ? { ...device, stale: !device.lastSeenAt || Date.now() - device.lastSeenAt.getTime() > staleAfterMs } : null; },
    events: (deviceId) => Event.find({ deviceId }).sort({ timestamp: -1 }).limit(100).lean(),
  };
  let broker;
  let commands;
  if (process.env.MQTT_URL) {
    if (!process.env.MQTT_USERNAME || !process.env.MQTT_PASSWORD) throw new Error('MQTT credentials required');
    broker = mqtt.connect(process.env.MQTT_URL, { clientId: process.env.MQTT_CLIENT_ID || 'droneops-backend', clean: false, username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD });
    commands = createCommandService({ Command, Mission, Device, connection: mongoose.connection, broker, staleAfterMs, Audit });
    broker.on('connect', () => broker.subscribe(['devices/+/status', 'devices/+/ack', 'devices/+/events'], { qos: 1 }, (err, grants) => {
      broker.readyForCommands = !err && grants?.length === 3 && grants.every((grant) => grant.qos !== 128);
      if (!broker.readyForCommands) console.error('MQTT subscribe failed', err?.message || 'subscription rejected');
    }));
    broker.on('close', () => { broker.readyForCommands = false; });
    broker.on('error', (err) => console.error('MQTT error:', err.message));
    broker.handleMessage = (packet, callback) => {
      const { topic, payload } = packet;
      (async () => {
      if (topic.endsWith('/ack')) {
        await commands.acknowledge(topic, payload);
        return;
      }
      if (topic.endsWith('/events')) {
        await ingestDisconnect(topic, payload, {
          async recordDisconnect(message) {
            return mongoose.connection.transaction(async (session) => {
              const changed = await Device.findOneAndUpdate({ deviceId: message.deviceId, sessionId: message.sessionId, disconnectedSessionId: { $ne: message.sessionId } },
                { $set: { connectivityState: 'offline', disconnectedSessionId: message.sessionId } }, { session, returnDocument: 'after' }).lean();
              if (!changed) return false;
              await Event.updateOne({ deviceId: message.deviceId, messageId: message.messageId }, { $setOnInsert: { deviceId: message.deviceId, messageId: message.messageId, sessionId: message.sessionId, type: message.type, timestamp: new Date(), payload: {} } }, { upsert: true, session });
              return true;
            });
          },
        }, packet.retain);
        return;
      }
      await ingestStatus(topic, payload, {
        async recordStatus(message) {
          const device = await Device.exists({ deviceId: message.deviceId });
          if (!device) return false;
          const key = { deviceId: message.deviceId, messageId: message.messageId };
          let event;
          try {
            event = await Event.findOneAndUpdate(key, { $setOnInsert: { ...message, timestamp: new Date(message.timestamp) } }, { upsert: true, returnDocument: 'after' }).lean();
          } catch (err) {
            if (err.code !== 11000) throw err;
            event = await Event.findOne(key).lean();
          }
          await Device.updateOne({ deviceId: event.deviceId, ...(event.sessionId ? { disconnectedSessionId: { $ne: event.sessionId } } : {}), $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: event.timestamp } }] }, {
            $set: { connectivityState: event.payload.connectivity, operationalState: event.payload.operationalState, lastSeenAt: event.timestamp, sessionId: event.sessionId || null },
          });
          return true;
        },
      }, Date.now(), packet.retain);
      })().then(() => callback(), (err) => {
        console.error('MQTT message processing failed:', err.message);
        broker.stream.destroy();
        callback(err);
      });
    };
  }
  // Expire pending commands even if the broker is temporarily disconnected.
  commands ||= createCommandService({ Command, Mission, Device, connection: mongoose.connection, broker, staleAfterMs, Audit });
  const timer = setInterval(() => commands.expire().catch((err) => console.error('Command expiry failed:', err.message)), 1000);
  const assistant = complete ? createAssistant({ tools: createAiTools({ devices, missions, history }), complete }) : null;
  const server = createApp({ devices, missions, commands, history, assistant, jwtSecret: JWT_SECRET }).listen(port, () => console.log(`Listening on ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { clearInterval(timer); if (broker) broker.end(true); mongoose.disconnect().then(() => process.exit(0)); }));
}

main().catch((err) => { console.error(err); process.exit(1); });
