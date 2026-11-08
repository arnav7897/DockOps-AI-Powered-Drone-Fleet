const mqtt = require('mqtt');
const { randomUUID } = require('node:crypto');
const { createSimulatorCommands } = require('./commands');
const { simulatorState } = require('./state');

const { MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD, DEVICE_ID } = process.env;
if (!MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD || !DEVICE_ID || MQTT_USERNAME !== DEVICE_ID || !/^[a-zA-Z0-9_-]{1,64}$/.test(DEVICE_ID) || DEVICE_ID === 'backend') {
  throw new Error('Set MQTT_URL, MQTT_PASSWORD and matching MQTT_USERNAME/DEVICE_ID (not backend)');
}
const commands = createSimulatorCommands(DEVICE_ID, simulatorState(process.env.DEVICE_STATE_DIR || '.simulator-state', DEVICE_ID));
let client, sessionId, stopped = false, reconnectTimer;
function publish(connectivity) {
  const message = { schemaVersion: 1, messageId: randomUUID(), deviceId: DEVICE_ID, sessionId, timestamp: new Date().toISOString(), type: 'STATUS_UPDATE', payload: { connectivity, operationalState: commands.state() ? 'busy' : 'idle' } };
  client.publish(`devices/${DEVICE_ID}/status`, JSON.stringify(message), { qos: 0 });
}
function connect() {
  sessionId = randomUUID();
  const will = { schemaVersion: 1, messageId: randomUUID(), deviceId: DEVICE_ID, sessionId, type: 'DEVICE_DISCONNECTED' };
  client = mqtt.connect(MQTT_URL, { clientId: `droneops-${DEVICE_ID}`, username: MQTT_USERNAME, password: MQTT_PASSWORD, reconnectPeriod: 0,
    will: { topic: `devices/${DEVICE_ID}/events`, payload: JSON.stringify(will), qos: 1, retain: false } });
  client.on('connect', () => client.subscribe(`devices/${DEVICE_ID}/commands`, { qos: 1 }, (err, grants) => {
    if (err || grants?.[0]?.qos === 128) return console.error('Command subscription failed');
    publish('online');
    for (const ack of commands.acknowledgements()) client.publish(`devices/${DEVICE_ID}/ack`, JSON.stringify(ack), { qos: 1 });
  }));
  client.on('message', (topic, raw) => {
    if (topic !== `devices/${DEVICE_ID}/commands`) return;
    const ack = commands.handle(raw);
    if (!ack) return;
    client.publish(`devices/${DEVICE_ID}/ack`, JSON.stringify(ack), { qos: 1 });
    publish('online');
  });
  client.on('error', (err) => console.error('MQTT error:', err.message));
  client.on('close', () => { if (!stopped) reconnectTimer = setTimeout(connect, 1000); });
}
connect();
const interval = setInterval(() => { if (client.connected) { publish('online'); for (const ack of commands.acknowledgements()) client.publish(`devices/${DEVICE_ID}/ack`, JSON.stringify(ack), { qos: 1 }); } }, 30000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  stopped = true;
  clearTimeout(reconnectTimer);
  clearInterval(interval);
  if (client.connected) publish('offline');
  client.end(false, () => process.exit(0));
});
