const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');

test('authenticated operators create, read and cancel draft missions', async (t) => {
  const secret = 'test-secret-at-least-thirty-two-characters';
  const token = jwt.sign({ role: 'operator' }, secret, { subject: 'operator', issuer: 'droneops', audience: 'droneops-api', expiresIn: '1h' });
  let record;
  const missions = {
    async create(input, user) { record = { ...input, missionId: 'm1', createdBy: user.sub, status: 'created' }; return record; },
    async get(id) { return id === 'm1' ? record : null; },
    async cancel(id) { if (id !== 'm1' || !['created', 'assigned'].includes(record?.status)) return null; record.status = 'cancelled'; return record; },
    async assign(id, deviceId) { if (id !== 'm1' || record?.status !== 'created' || deviceId !== 'eligible') return null; record.status = 'assigned'; record.assignedDeviceId = deviceId; return record; },
  };
  const sent = [];
  const commands = { async dispatch(id, action, user) { if (action === 'cancel') return null; sent.push({ id, action, user: user.sub }); return { commandId: 'c1', status: 'pending' }; }, async get(id) { return id === 'c1' ? { commandId: id } : null; } };
  const server = createApp({ devices: {}, missions, commands, jwtSecret: secret }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/v1/missions`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(base, { method: 'POST', headers, body: JSON.stringify({ type: '', parameters: {} }) })).status, 400);
  assert.equal((await fetch(base, { method: 'POST', body: '{}' })).status, 401);
  const created = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ type: 'survey', parameters: {} }) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).createdBy, 'operator');
  assert.equal((await fetch(`${base}/missing`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/m1`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/m1/assign`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'unavailable' }) })).status, 409);
  assert.equal((await fetch(`${base}/m1/assign`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'eligible' }) })).status, 200);
  assert.equal((await fetch(`${base}/m1/assign`, { method: 'POST', headers, body: JSON.stringify({ deviceId: 'eligible' }) })).status, 409);
  assert.equal((await fetch(`${base}/m1/start`, { method: 'POST' })).status, 401);
  assert.equal(sent.length, 0);
  assert.equal((await fetch(`${base}/m1/start`, { method: 'POST', headers })).status, 202);
  assert.deepEqual(sent[0], { id: 'm1', action: 'start', user: 'operator' });
  assert.equal((await fetch(`${base}/m1/arbitrary`, { method: 'POST', headers })).status, 404);
  assert.equal((await fetch(`${base}/m1/cancel`, { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(`${base}/m1/cancel`, { method: 'POST', headers })).status, 409);
});
