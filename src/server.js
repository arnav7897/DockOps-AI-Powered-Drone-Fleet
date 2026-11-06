const mongoose = require('mongoose');
const { createApp } = require('./app');
const mqtt = require('mqtt');
const { ingestStatus } = require('./ingestion');
const { createMissionModel, createMissionStore } = require('./missions');
const { createCommandModel, createCommandService } = require('./commands');

async function main() {
  const { MONGODB_URI, JWT_SECRET } = process.env;
  const port = Number(process.env.PORT || 3000);
  if (!MONGODB_URI || !JWT_SECRET || JWT_SECRET.length < 32 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Set MONGODB_URI, JWT_SECRET (at least 32 characters), and a valid PORT');
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
  }, { timestamps: true, versionKey: false });
  const Device = mongoose.model('Device', schema);
  await Device.init();
  const eventSchema = new mongoose.Schema({
    deviceId: { type: String, required: true },
    messageId: { type: String, required: true },
    timestamp: { type: Date, required: true },
    type: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
  }, { versionKey: false });
  eventSchema.index({ deviceId: 1, messageId: 1 }, { unique: true });
  const Event = mongoose.model('Event', eventSchema);
  await Event.init();
  const Mission = createMissionModel(mongoose);
  await Mission.init();
  const missions = createMissionStore(Mission, Device, mongoose.connection);
  const Command = createCommandModel(mongoose);
  await Command.init();
  const devices = {
    create: async (input) => (await Device.create(input)).toObject(),
    list: () => Device.find().lean(),
    events: (deviceId) => Event.find({ deviceId }).sort({ timestamp: -1 }).limit(100).lean(),
  };
  let broker;
  let commands;
  if (process.env.MQTT_URL) {
    if (!process.env.MQTT_USERNAME || !process.env.MQTT_PASSWORD) throw new Error('MQTT credentials required');
    broker = mqtt.connect(process.env.MQTT_URL, { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD });
    commands = createCommandService({ Command, Mission, Device, connection: mongoose.connection, broker });
    broker.on('connect', () => broker.subscribe(['devices/+/status', 'devices/+/ack'], { qos: 1 }, (err, grants) => {
      broker.readyForCommands = !err && grants?.length === 2 && grants.every((grant) => grant.qos !== 128);
      if (!broker.readyForCommands) console.error('MQTT subscribe failed', err?.message || 'subscription rejected');
    }));
    broker.on('close', () => { broker.readyForCommands = false; });
    broker.on('error', (err) => console.error('MQTT error:', err.message));
    broker.on('message', (topic, payload) => {
      if (topic.endsWith('/ack')) {
        commands.acknowledge(topic, payload).catch((err) => console.error('Acknowledgement failed:', err.message));
        return;
      }
      ingestStatus(topic, payload, {
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
          await Device.updateOne({ deviceId: event.deviceId, $or: [{ lastSeenAt: null }, { lastSeenAt: { $lt: event.timestamp } }] }, {
            $set: { connectivityState: event.payload.connectivity, operationalState: event.payload.operationalState, lastSeenAt: event.timestamp },
          });
          return true;
        },
      }).catch((err) => console.error('Status ingestion failed:', err.message));
    });
  }
  // Expire pending commands even if the broker is temporarily disconnected.
  commands ||= createCommandService({ Command, Mission, Device, connection: mongoose.connection, broker });
  const timer = setInterval(() => commands.expire().catch((err) => console.error('Command expiry failed:', err.message)), 1000);
  const server = createApp({ devices, missions, commands, jwtSecret: JWT_SECRET }).listen(port, () => console.log(`Listening on ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { clearInterval(timer); if (broker) broker.end(true); mongoose.disconnect().then(() => process.exit(0)); }));
}

main().catch((err) => { console.error(err); process.exit(1); });
