const mongoose = require('mongoose');
const { createApp } = require('./app');

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
  const devices = {
    create: async (input) => (await Device.create(input)).toObject(),
    list: () => Device.find().lean(),
  };
  const server = createApp({ devices, jwtSecret: JWT_SECRET }).listen(port, () => console.log(`Listening on ${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => mongoose.disconnect().then(() => process.exit(0))));
}

main().catch((err) => { console.error(err); process.exit(1); });
