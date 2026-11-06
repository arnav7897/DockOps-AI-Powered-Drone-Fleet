const mqtt = require('mqtt');
const { randomUUID } = require('node:crypto');
const { createSimulatorCommands } = require('./commands');

const { MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD, DEVICE_ID } = process.env;
if (!MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD || !DEVICE_ID || MQTT_USERNAME !== DEVICE_ID || !/^[a-zA-Z0-9_-]{1,64}$/.test(DEVICE_ID) || DEVICE_ID === 'backend') {
  throw new Error('Set MQTT_URL, MQTT_PASSWORD and matching MQTT_USERNAME/DEVICE_ID (not backend)');
}
const client = mqtt.connect(MQTT_URL, { username: MQTT_USERNAME, password: MQTT_PASSWORD });
const commands = createSimulatorCommands(DEVICE_ID);
function publish(connectivity) {
  const message = { schemaVersion: 1, messageId: randomUUID(), deviceId: DEVICE_ID, timestamp: new Date().toISOString(), type: 'STATUS_UPDATE', payload: { connectivity, operationalState: commands.state() ? 'busy' : 'idle' } };
  client.publish(`devices/${DEVICE_ID}/status`, JSON.stringify(message), { qos: 0 });
}
client.on('connect', () => client.subscribe(`devices/${DEVICE_ID}/commands`, { qos: 1 }, (err, grants) => {
  if (err || grants?.[0]?.qos === 128) return console.error('Command subscription failed');
  publish('online');
}));
client.on('message', (topic, raw) => {
  if (topic !== `devices/${DEVICE_ID}/commands`) return;
  const ack = commands.handle(raw);
  if (!ack) return;
  client.publish(`devices/${DEVICE_ID}/ack`, JSON.stringify(ack), { qos: 1 });
  publish('online');
});
client.on('error', (err) => console.error('MQTT error:', err.message));
const interval = setInterval(() => { if (client.connected) publish('online'); }, 30000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  clearInterval(interval);
  if (client.connected) {
    publish('offline');
    client.end(false, () => process.exit(0));
  } else client.end(true, () => process.exit(0));
});
