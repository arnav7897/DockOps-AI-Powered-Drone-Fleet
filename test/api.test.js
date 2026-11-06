const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createApp } = require('../src/app');

const secret = 'test-secret-at-least-thirty-two-characters';
const token = (role, options = {}) => jwt.sign({ role }, secret, { subject: 'user-1', issuer: 'droneops', audience: 'droneops-api', expiresIn: '1h', ...options });

test('device registry validates input and enforces roles', async (t) => {
  const records = [];
  const devices = {
    async create(input) {
      if (records.some((x) => x.deviceId === input.deviceId)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      records.push(input); return input;
    },
    async list() { return records; },
    async events(deviceId) { return [{ deviceId, type: 'STATUS_UPDATE' }]; },
  };
  const server = createApp({ devices, jwtSecret: secret }).listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  async function request(path, { role, body, bearer, method = 'GET' } = {}) {
    return fetch(base + path, { method, headers: { ...(role ? { Authorization: `Bearer ${token(role)}` } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/devices')).status, 401);
  assert.equal((await request('/devices', { bearer: token('admin', { expiresIn: -1 }) })).status, 401);
  assert.equal((await request('/devices', { method: 'POST', role: 'operator', body: {} })).status, 403);
  assert.equal((await request('/devices', { method: 'POST', role: 'admin', body: { deviceId: '../bad', name: 'x', capabilities: [] } })).status, 400);
  assert.equal((await request('/devices', { method: 'POST', role: 'admin', body: { deviceId: 'backend', name: 'x', capabilities: [] } })).status, 400);
  const input = { deviceId: 'drone-1', name: 'Drone', capabilities: ['survey'] };
  assert.equal((await request('/devices', { method: 'POST', role: 'admin', body: input })).status, 201);
  assert.equal((await request('/devices', { method: 'POST', role: 'admin', body: input })).status, 409);
  const response = await request('/devices', { role: 'operator' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [input]);
  assert.equal((await request('/devices/drone-1/events')).status, 401);
  const events = await request('/devices/drone-1/events', { role: 'operator' });
  assert.deepEqual(await events.json(), [{ deviceId: 'drone-1', type: 'STATUS_UPDATE' }]);
});
