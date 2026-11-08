const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createSimulatorCommands } = require('../simulator/commands');
const { simulatorState } = require('../simulator/state');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('simulator validates expiry, transitions and duplicate command IDs', () => {
  const simulator = createSimulatorCommands('drone-1');
  const now = Date.now(), missionId = randomUUID();
  const make = (command) => ({ schemaVersion: 1, commandId: randomUUID(), correlationId: randomUUID(), missionId, command,
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString(), payload: command === 'MISSION_START' ? { type: 'survey', parameters: {} } : {} });
  const send = (command, at = now) => simulator.handle(Buffer.from(JSON.stringify(command)), at);
  const start = make('MISSION_START');
  const first = send(start);
  assert.equal(first.status, 'acknowledged');
  assert.deepEqual(send(start), first);
  assert.equal(send({ ...start, command: 'MISSION_CANCEL', payload: {} }), null);
  assert.equal(send(make('MISSION_START')).status, 'rejected');
  assert.equal(send(make('MISSION_PAUSE')).status, 'acknowledged');
  assert.equal(send(make('MISSION_RESUME')).status, 'acknowledged');
  assert.equal(send(make('MISSION_COMPLETE')).status, 'acknowledged');
  assert.equal(simulator.state(), null);
  assert.equal(send(make('MISSION_START'), now + 30000), null);
  assert.equal(simulator.handle(Buffer.from('{')), null);
});

test('simulator persists state and acknowledgements across restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droneops-simulator-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const now = Date.now(), missionId = randomUUID();
  const command = { schemaVersion: 1, commandId: randomUUID(), correlationId: randomUUID(), missionId, command: 'MISSION_START',
    issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30000).toISOString(), payload: { type: 'survey', parameters: {} } };
  const first = createSimulatorCommands('drone-1', simulatorState(dir, 'drone-1'));
  const ack = first.handle(Buffer.from(JSON.stringify(command)), now);
  const restored = createSimulatorCommands('drone-1', simulatorState(dir, 'drone-1'));
  assert.deepEqual(restored.state(), { missionId, status: 'active' });
  assert.deepEqual(restored.acknowledgements(), [ack]);
  assert.deepEqual(restored.handle(Buffer.from(JSON.stringify(command)), now + 1), ack);
  assert.equal(restored.handle(Buffer.from(JSON.stringify(command)), now + 30000), null);
  fs.writeFileSync(path.join(dir, 'drone-1.json'), '{');
  assert.throws(() => simulatorState(dir, 'drone-1'));
});
