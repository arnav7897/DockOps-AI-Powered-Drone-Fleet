const mongoose = require('mongoose');
const { createApp } = require('./app');
const mqtt = require('mqtt');
const { ingestStatus } = require('./ingestion');

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
  const devices = {
    create: async (input) => (await Device.create(input)).toObject(),
    list: () => Device.find().lean(),
    events: (deviceId) => Event.find({ deviceId }).sort({ timestamp: -1 }).limit(100).lean(),
  };
  let broker;
  if (process.env.MQTT_URL) {
    if (!process.env.MQTT_USERNAME || !process.env.MQTT_PASSWORD) throw new Error('MQTT credentials required');
    broker = mqtt.connect(process.env.MQTT_URL, { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD });
    broker.on('connect', () => broker.subscribe('devices/+/status', { qos: 1 }, (err) => { if (err) console.error('MQTT subscribe failed', err.message); }));
    broker.on('error', (err) => console.error('MQTT error:', err.message));
    broker.on('message', (topic, payload) => {
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
  const server = createApp({ devices, jwtSecret: JWT_SECRET }).listen(port, () => console.log(`Listening on ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => { if (broker) broker.end(true); mongoose.disconnect().then(() => process.exit(0)); }));
}

main().catch((err) => { console.error(err); process.exit(1); });
