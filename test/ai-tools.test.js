const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAiTools, toolDefinitions } = require('../src/ai-tools');

test('AI tool registry exposes grounded read-only tools only', async () => {
  const calls = [];
  const tools = createAiTools({
    devices: {
    async list() { calls.push('devices.list'); return [{ deviceId: 'd1', name: 'Drone 1', capabilities: ['survey'], connectivityState: 'online', operationalState: 'idle', lastSeenAt: new Date(0), activeMissionId: null, stale: true, secret: 'omit' }]; },
      async get(id) { calls.push('devices.get'); return id === 'd1' ? { deviceId: id, name: 'Drone 1', capabilities: ['survey'], connectivityState: 'online', operationalState: 'idle', lastSeenAt: new Date(0), activeMissionId: null, stale: true, secret: 'omit' } : null; },
    },
    missions: {
      async list() { calls.push('missions.list'); return [{ missionId: '3c0c7d5d-c80c-4c71-86ae-f963c7f50c1f', type: 'survey', status: 'created', assignedDeviceId: null, failureReason: null, pendingCommandId: null, createdAt: new Date(0), updatedAt: new Date(0), parameters: { secret: true } }]; },
      async get(id) { calls.push('missions.get'); return id === '3c0c7d5d-c80c-4c71-86ae-f963c7f50c1f' ? { missionId: id, type: 'survey', status: 'created', assignedDeviceId: null, failureReason: null, pendingCommandId: null, createdAt: new Date(0), updatedAt: new Date(0), parameters: { secret: true } } : null; },
    },
    history: { async events(filters) { calls.push(['history.events', filters]); return [
      { kind: 'audit', timestamp: new Date(0), data: { eventId: 'event-1', type: 'MISSION_CREATED', metadata: { requestedBy: 'operator-secret' } } },
      { kind: 'device', timestamp: new Date(0), data: { messageId: 'message-1', deviceId: 'd1', type: 'STATUS_UPDATE', payload: { connectivity: 'online', operationalState: 'idle', gps: 'private' } } },
      { kind: 'command', timestamp: new Date(0), data: { commandId: 'command-1', failureReason: `bad\n${'x'.repeat(400)}`, requestedBy: 'operator-secret', payload: { secret: true } } },
    ]; } },
  });

  assert.deepEqual(tools.definitions.map(({ name }) => name), ['getFleetSnapshot', 'getDeviceStatus', 'getMissionStatus', 'getRecentEvents']);
  assert.deepEqual(await tools.execute('getFleetSnapshot', {}), {
    truncated: false,
    devices: [{ deviceId: 'd1', name: 'Drone 1', capabilities: ['survey'], connectivityState: 'online', operationalState: 'idle', lastSeenAt: new Date(0), activeMissionId: null, stale: true }],
    missions: [{ missionId: '3c0c7d5d-c80c-4c71-86ae-f963c7f50c1f', type: 'survey', status: 'created', assignedDeviceId: null, failureReason: null, pendingCommandId: null, createdAt: new Date(0), updatedAt: new Date(0) }],
  });
  assert.equal(await tools.execute('getDeviceStatus', { deviceId: 'missing' }), null);
  assert.equal((await tools.execute('getMissionStatus', { missionId: '3c0c7d5d-c80c-4c71-86ae-f963c7f50c1f' })).status, 'created');
  const events = await tools.execute('getRecentEvents', { kind: 'audit' });
  assert.deepEqual(events[0], { kind: 'audit', timestamp: new Date(0), eventId: 'event-1', type: 'MISSION_CREATED', missionId: undefined, deviceId: undefined, correlationId: undefined });
  assert.deepEqual(events[1].payload, { connectivity: 'online', operationalState: 'idle' });
  assert.equal(events[2].failureReason.length, 300);
  assert.equal(events[2].failureReason.includes('\n'), false);
  assert.equal(JSON.stringify(events).includes('operator-secret'), false);
  assert.equal(JSON.stringify(events).includes('private'), false);
  assert.deepEqual(calls, ['devices.list', 'missions.list', 'devices.get', 'missions.get', ['history.events', { kind: 'audit' }]]);
});

test('fleet snapshots cap model context and report truncation', async () => {
  const tools = createAiTools({
    devices: { async list({ limit }) { return Array.from({ length: limit }, (_, index) => ({ deviceId: `d${index}` })); } },
    missions: { async list({ limit }) { return Array.from({ length: limit }, (_, index) => ({ missionId: `m${index}` })); } },
    history: {},
  });
  const snapshot = await tools.execute('getFleetSnapshot', {});
  assert.equal(snapshot.devices.length, 100);
  assert.equal(snapshot.missions.length, 100);
  assert.equal(snapshot.truncated, true);
});

test('AI tools reject unknown names and invalid or extra arguments', async () => {
  const tools = createAiTools({ devices: {}, missions: {}, history: {} });
  await assert.rejects(tools.execute('dispatchApprovedRequest', {}), /Unknown AI tool/);
  await assert.rejects(tools.execute('getFleetSnapshot', { filter: {} }));
  await assert.rejects(tools.execute('getDeviceStatus', { deviceId: '../broker' }));
  await assert.rejects(tools.execute('getDeviceStatus', { deviceId: 'd1', topic: '#' }));
  await assert.rejects(tools.execute('getMissionStatus', { missionId: 'not-a-uuid' }));
  await assert.rejects(tools.execute('getRecentEvents', { deviceId: 'd1', rawQuery: {} }));
});
