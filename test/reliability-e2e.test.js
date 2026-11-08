const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const net = require('node:net');
const jwt = require('jsonwebtoken');
const mqtt = require('mqtt');
const mongoose = require('mongoose');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const enabled = process.env.TEST_MONGODB_URI && process.env.TEST_MQTT_URL && process.env.TEST_MQTT_BACKEND_PASSWORD && process.env.TEST_MQTT_DEVICE_PASSWORD;
test('broker will, reconnect and read-only replay preserve the current session', { skip: !enabled, timeout: 30000 }, async () => {
  const dbName = `droneops_reliability_${process.pid}`;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'droneops-e2e-'));
  const secret = 'integration-secret-at-least-32-characters';
  const clientIds = [`droneops-test-${randomUUID()}`];
  const portServer = net.createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}/api/v1`;
  const token = jwt.sign({ role: 'admin' }, secret, { subject: 'integration', issuer: 'droneops', audience: 'droneops-api', expiresIn: '1h' });
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function eventually(fn) {
    for (let n = 0; n < 100; n++) { try { const value = await fn(); if (value) return value; } catch {} await sleep(100); }
    throw new Error('Timed out waiting for expected state');
  }
  const apiEnv = { ...process.env, MONGODB_URI: process.env.TEST_MONGODB_URI, JWT_SECRET: secret, PORT: String(port), STALE_AFTER_MS: '3000', MQTT_URL: process.env.TEST_MQTT_URL,
    MQTT_USERNAME: 'backend', MQTT_PASSWORD: process.env.TEST_MQTT_BACKEND_PASSWORD, MQTT_CLIENT_ID: clientIds[0] };
  const deviceEnv = { ...process.env, MQTT_URL: process.env.TEST_MQTT_URL, MQTT_USERNAME: 'drone1', DEVICE_ID: 'drone1', MQTT_PASSWORD: process.env.TEST_MQTT_DEVICE_PASSWORD, DEVICE_STATE_DIR: stateDir };
  // Use a dedicated database URI without changing the shared test deployment.
  const apiUri = new URL(process.env.TEST_MONGODB_URI); apiUri.pathname = `/${dbName}`; apiEnv.MONGODB_URI = apiUri.toString();
  let api = spawn(process.execPath, ['src/server.js'], { env: apiEnv, stdio: 'ignore' });
  let simulator, publisher;
  try {
    await eventually(async () => (await fetch(`${base}/health`)).ok);
    const created = await fetch(`${base}/devices`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'drone1', name: 'Test', capabilities: ['survey'] }) });
    assert.equal(created.status, 201);
    simulator = spawn(process.execPath, ['simulator/device.js'], { env: deviceEnv, stdio: 'ignore' });
    const device = async () => (await (await fetch(`${base}/devices`, { headers })).json())[0];
    const first = await eventually(async () => { const d = await device(); return d?.connectivityState === 'online' && d.sessionId && d; });
    const createdMission = await (await fetch(`${base}/missions`, { method: 'POST', headers, body: JSON.stringify({ type: 'survey', parameters: {} }) })).json();
    assert.equal((await fetch(`${base}/missions/${createdMission.missionId}/assign`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'drone1' }) })).status, 200);
    assert.equal((await fetch(`${base}/missions/${createdMission.missionId}/cancel`, { method: 'POST', headers })).status, 200);
    const audit = await (await fetch(`${base}/events?kind=audit&missionId=${createdMission.missionId}`, { headers })).json();
    assert.deepEqual(audit.map((entry) => entry.data.type).sort(), ['MISSION_ASSIGNED', 'MISSION_CANCELLED', 'MISSION_CREATED']);
    const missionReplay = await (await fetch(`${base}/missions/${createdMission.missionId}/replay`, { headers })).json();
    assert.equal(missionReplay.incomplete, false);
    assert.equal(missionReplay.state.status, 'cancelled');
    simulator.kill('SIGKILL'); await once(simulator, 'exit'); simulator = null;
    await eventually(async () => (await device()).connectivityState === 'offline');
    const alerts = await (await fetch(`${base}/alerts`, { headers })).json();
    assert.ok(alerts.devices.some((item) => item.deviceId === 'drone1'));
    simulator = spawn(process.execPath, ['simulator/device.js'], { env: deviceEnv, stdio: 'ignore' });
    const second = await eventually(async () => { const d = await device(); return d?.connectivityState === 'online' && d.sessionId !== first.sessionId && d; });
    publisher = mqtt.connect(process.env.TEST_MQTT_URL, { username: 'drone1', password: process.env.TEST_MQTT_DEVICE_PASSWORD });
    await once(publisher, 'connect');
    const oldWill = { schemaVersion: 1, messageId: randomUUID(), deviceId: 'drone1', sessionId: first.sessionId, type: 'DEVICE_DISCONNECTED' };
    await publisher.publishAsync('devices/drone1/events', JSON.stringify(oldWill), { qos: 1 });
    await sleep(300);
    assert.equal((await device()).sessionId, second.sessionId);
    assert.equal((await device()).connectivityState, 'online');
    const replay = await (await fetch(`${base}/devices/drone1/replay`, { headers })).json();
    assert.equal(replay.state.sessionId, second.sessionId);
    assert.equal(replay.state.connectivityState, 'online');
    assert.ok(replay.eventsApplied >= 3);
    const events = await (await fetch(`${base}/events?deviceId=drone1`, { headers })).json();
    assert.ok(events.some((event) => event.data.type === 'DEVICE_DISCONNECTED'));
    assert.equal((await fetch(`${base}/events`)).status, 401);
    assert.equal((await fetch(`${base}/events?kind=unknown`, { headers })).status, 400);
    const recovering = await (await fetch(`${base}/missions`, { method: 'POST', headers, body: JSON.stringify({ type: 'survey', parameters: {} }) })).json();
    assert.equal((await fetch(`${base}/missions/${recovering.missionId}/assign`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'drone1' }) })).status, 200);
    api.kill('SIGTERM'); await once(api, 'exit');
    const retainedId = randomUUID();
    const retained = { schemaVersion: 1, messageId: retainedId, deviceId: 'drone1', sessionId: randomUUID(), timestamp: new Date().toISOString(), type: 'STATUS_UPDATE', payload: { connectivity: 'online', operationalState: 'idle' } };
    await publisher.publishAsync('devices/drone1/status', JSON.stringify(retained), { qos: 1, retain: true });
    const commandId = randomUUID(), correlationId = randomUUID(), issuedAt = new Date(), expiresAt = new Date(issuedAt.getTime() + 2000);
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName });
    await mongoose.connection.db.collection('commands').insertOne({ commandId, correlationId, missionId: recovering.missionId, deviceId: 'drone1', action: 'start', command: 'MISSION_START', fromStatus: 'assigned', toStatus: 'active', status: 'pending', issuedAt, expiresAt, requestedBy: 'integration', createdAt: issuedAt, updatedAt: issuedAt });
    await mongoose.connection.db.collection('missions').updateOne({ missionId: recovering.missionId }, { $set: { pendingCommandId: commandId } });
    await mongoose.disconnect();
    publisher.end(true);
    publisher = mqtt.connect(process.env.TEST_MQTT_URL, { username: 'backend', password: process.env.TEST_MQTT_BACKEND_PASSWORD });
    await once(publisher, 'connect');
    const envelope = { schemaVersion: 1, commandId, correlationId, missionId: recovering.missionId, command: 'MISSION_START', issuedAt: issuedAt.toISOString(), expiresAt: expiresAt.toISOString(), payload: { type: 'survey', parameters: {} } };
    await publisher.publishAsync('devices/drone1/commands', JSON.stringify(envelope), { qos: 1 });
    await eventually(async () => { const saved = JSON.parse(fs.readFileSync(path.join(stateDir, 'drone1.json'), 'utf8')); return saved.entries.some((item) => item.ack.commandId === commandId); });
    simulator.kill('SIGKILL'); await once(simulator, 'exit'); simulator = null;
    await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 100);
    // A fresh backend session isolates the simulator's own acknowledgement replay.
    clientIds.push(`droneops-test-${randomUUID()}`); apiEnv.MQTT_CLIENT_ID = clientIds.at(-1);
    api = spawn(process.execPath, ['src/server.js'], { env: apiEnv, stdio: 'ignore' });
    await eventually(async () => (await fetch(`${base}/health`)).ok);
    await eventually(async () => (await (await fetch(`${base}/commands/${commandId}`, { headers })).json()).status === 'timed_out');
    const afterRestart = await (await fetch(`${base}/events?kind=device&deviceId=drone1`, { headers })).json();
    assert.ok(!afterRestart.some((event) => event.data.messageId === retainedId));
    simulator = spawn(process.execPath, ['simulator/device.js'], { env: deviceEnv, stdio: 'ignore' });
    await eventually(async () => (await (await fetch(`${base}/commands/${commandId}`, { headers })).json()).status === 'acknowledged');
    assert.equal((await (await fetch(`${base}/missions/${recovering.missionId}`, { headers })).json()).status, 'active');
    assert.equal((await (await fetch(`${base}/missions/${recovering.missionId}/replay`, { headers })).json()).incomplete, true);
    const cancelResponse = await fetch(`${base}/missions/${recovering.missionId}/cancel`, { method: 'POST', headers });
    assert.equal(cancelResponse.status, 202);
    await eventually(async () => (await (await fetch(`${base}/missions/${recovering.missionId}`, { headers })).json()).status === 'cancelled');
    const queuedMission = await (await fetch(`${base}/missions`, { method: 'POST', headers, body: JSON.stringify({ type: 'survey', parameters: {} }) })).json();
    await eventually(async () => { const d = await device(); return d.operationalState === 'idle' && !d.stale; });
    assert.equal((await fetch(`${base}/missions/${queuedMission.missionId}/assign`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'drone1' }) })).status, 200);
    api.kill('SIGTERM'); await once(api, 'exit');
    const queuedId = randomUUID(), queuedCorrelation = randomUUID(), queuedAt = new Date(), queuedExpiry = new Date(queuedAt.getTime() + 2000);
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName });
    await mongoose.connection.db.collection('commands').insertOne({ commandId: queuedId, correlationId: queuedCorrelation, missionId: queuedMission.missionId, deviceId: 'drone1', action: 'start', command: 'MISSION_START', fromStatus: 'assigned', toStatus: 'active', status: 'pending', issuedAt: queuedAt, expiresAt: queuedExpiry, requestedBy: 'integration', createdAt: queuedAt, updatedAt: queuedAt });
    await mongoose.connection.db.collection('missions').updateOne({ missionId: queuedMission.missionId }, { $set: { pendingCommandId: queuedId } });
    await mongoose.disconnect();
    await publisher.publishAsync('devices/drone1/commands', JSON.stringify({ schemaVersion: 1, commandId: queuedId, correlationId: queuedCorrelation, missionId: queuedMission.missionId, command: 'MISSION_START', issuedAt: queuedAt.toISOString(), expiresAt: queuedExpiry.toISOString(), payload: { type: 'survey', parameters: {} } }), { qos: 1 });
    await eventually(async () => JSON.parse(fs.readFileSync(path.join(stateDir, 'drone1.json'), 'utf8')).entries.some((item) => item.ack.commandId === queuedId));
    await sleep(Math.max(0, queuedExpiry.getTime() - Date.now()) + 100);
    // Keep the same persistent backend session and simulator process: the broker must redeliver the queued acknowledgement.
    api = spawn(process.execPath, ['src/server.js'], { env: apiEnv, stdio: 'ignore' });
    await eventually(async () => (await fetch(`${base}/health`)).ok);
    await eventually(async () => (await (await fetch(`${base}/commands/${queuedId}`, { headers })).json()).status === 'acknowledged');
    assert.equal((await (await fetch(`${base}/missions/${queuedMission.missionId}`, { headers })).json()).status, 'active');
    await eventually(async () => (await device()).stale);
    const staleAlerts = await (await fetch(`${base}/alerts`, { headers })).json();
    assert.ok(staleAlerts.devices.some((item) => item.deviceId === 'drone1' && item.stale));
  } finally {
    if (publisher?.connected) await publisher.publishAsync('devices/drone1/status', '', { qos: 1, retain: true });
    if (publisher) publisher.end(true);
    if (simulator && simulator.exitCode === null && simulator.signalCode === null) { simulator.kill('SIGTERM'); await once(simulator, 'exit'); }
    if (api.exitCode === null && api.signalCode === null) { api.kill('SIGTERM'); await once(api, 'exit'); }
    for (const clientId of clientIds) {
      const cleaner = mqtt.connect(process.env.TEST_MQTT_URL, { clientId, clean: true, username: 'backend', password: process.env.TEST_MQTT_BACKEND_PASSWORD, reconnectPeriod: 0 });
      await once(cleaner, 'connect'); await cleaner.endAsync();
    }
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName });
    await mongoose.connection.dropDatabase(); await mongoose.disconnect();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
