const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createMissionModel, createMissionStore } = require('../src/missions');

test('replica set atomically reserves and releases eligible devices', { skip: !process.env.TEST_MONGODB_URI }, async () => {
  await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: `droneops_test_${process.pid}` });
  try {
    const Device = mongoose.model('TestDevice', new mongoose.Schema({
      deviceId: String, connectivityState: String, operationalState: String,
      capabilities: [String], activeMissionId: { type: String, default: null }, lastSeenAt: Date,
    }));
    const Mission = createMissionModel(mongoose);
    await Promise.all([Device.init(), Mission.init()]);
    const store = createMissionStore(Mission, Device, mongoose.connection);
    await Device.create({ deviceId: 'd1', connectivityState: 'online', operationalState: 'idle', capabilities: ['survey'], lastSeenAt: new Date() });
    const a = await store.create({ type: 'survey', parameters: {} }, { sub: 'op' });
    const b = await store.create({ type: 'survey', parameters: {} }, { sub: 'op' });
    const results = await Promise.all([store.assign(a.missionId, 'd1'), store.assign(b.missionId, 'd1')]);
    assert.equal(results.filter(Boolean).length, 1);
    const winner = results.find(Boolean);
    assert.equal((await Device.findOne({ deviceId: 'd1' }).lean()).activeMissionId, winner.missionId);
    assert.equal((await store.cancel(winner.missionId)).status, 'cancelled');
    assert.equal((await Device.findOne({ deviceId: 'd1' }).lean()).activeMissionId, null);
    await Device.updateOne({ deviceId: 'd1' }, { lastSeenAt: new Date(Date.now() - 61000) });
    const remaining = results[0] ? b : a;
    assert.equal(await store.assign(remaining.missionId, 'd1'), null);
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
