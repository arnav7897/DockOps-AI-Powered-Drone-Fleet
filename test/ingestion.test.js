const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ingestStatus } = require('../src/ingestion');

test('status ingestion accepts only valid, current, matching messages', async () => {
  const now = Date.now();
  const message = { schemaVersion: 1, messageId: 'm1', deviceId: 'd1', timestamp: new Date(now).toISOString(), type: 'STATUS_UPDATE', payload: { connectivity: 'online', operationalState: 'idle' } };
  const seen = [];
  const store = { async recordStatus(value) { seen.push(value); return true; } };
  const send = (topic, value) => ingestStatus(topic, Buffer.from(JSON.stringify(value)), store, now);
  assert.equal(await send('devices/d1/status', message), true);
  assert.equal(await send('devices/d2/status', message), false);
  assert.equal(await send('devices/d1/events', message), false);
  assert.equal(await send('devices/d1/status', { ...message, timestamp: new Date(now - 300001).toISOString() }), false);
  assert.equal(await send('devices/d1/status', { ...message, timestamp: new Date(now + 30001).toISOString() }), false);
  assert.equal(await send('devices/d1/status', { ...message, schemaVersion: 2 }), false);
  assert.equal(await ingestStatus('devices/d1/status', Buffer.from('{'), store, now), false);
  assert.equal(seen.length, 1);
});
