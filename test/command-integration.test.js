const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createMissionModel, createMissionStore } = require('../src/missions');
const { createCommandModel, createCommandService } = require('../src/commands');
const { createSimulatorCommands } = require('../simulator/commands');

test('command transitions, acknowledgements and uncertain timeout preserve reservation', { skip: !process.env.TEST_MONGODB_URI }, async () => {
  await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: `droneops_commands_${process.pid}` });
  try {
    const Device = mongoose.model('CommandTestDevice', new mongoose.Schema({ deviceId: String, connectivityState: String, operationalState: String,
      capabilities: [String], activeMissionId: { type: String, default: null }, lastSeenAt: Date }));
    const Mission = createMissionModel(mongoose), Command = createCommandModel(mongoose);
    await Promise.all([Device.init(), Mission.init(), Command.init()]);
    const missions = createMissionStore(Mission, Device, mongoose.connection);
    const sent = [];
    const broker = { connected: true, readyForCommands: true, async publishAsync(topic, raw) { sent.push({ topic, raw }); } };
    const commands = createCommandService({ Command, Mission, Device, connection: mongoose.connection, broker });
    const simulator = createSimulatorCommands('d1');
    const user = { role: 'operator', sub: 'op', exp: Math.floor(Date.now() / 1000) + 15 };
    await Device.create({ deviceId: 'd1', connectivityState: 'online', operationalState: 'idle', capabilities: ['survey'], lastSeenAt: new Date() });
    const mission = await missions.create({ type: 'survey', parameters: {} }, user);
    await missions.assign(mission.missionId, 'd1');
    assert.equal(await commands.dispatch(mission.missionId, 'pause', user), null);
    assert.equal(await commands.dispatch(mission.missionId, 'start', { ...user, exp: 1 }), null);
    async function action(name) {
      const command = await commands.dispatch(mission.missionId, name, user);
      assert.ok(command);
      assert.ok(new Date(command.expiresAt).getTime() <= user.exp * 1000);
      assert.equal((await missions.get(mission.missionId)).pendingCommandId, command.commandId);
      const ack = simulator.handle(Buffer.from(sent.at(-1).raw));
      assert.ok(ack);
      assert.equal(await commands.acknowledge('devices/other/ack', Buffer.from(JSON.stringify(ack))), false);
      assert.equal(await commands.acknowledge('devices/d1/ack', Buffer.from(JSON.stringify(ack))), true);
      assert.equal(await commands.acknowledge('devices/d1/ack', Buffer.from(JSON.stringify(ack))), false);
      assert.equal((await commands.get(command.commandId)).status, 'acknowledged');
      return command;
    }
    await action('start');
    assert.equal((await missions.get(mission.missionId)).status, 'active');
    const rejected = await commands.dispatch(mission.missionId, 'pause', user);
    const rejectedMessage = JSON.parse(sent.at(-1).raw);
    const rejectedAck = { schemaVersion: 1, commandId: rejected.commandId, correlationId: rejected.correlationId,
      missionId: mission.missionId, deviceId: 'd1', timestamp: new Date().toISOString(), status: 'rejected' };
    assert.equal(await commands.acknowledge('devices/d1/ack', Buffer.from(JSON.stringify({ ...rejectedAck, correlationId: mission.missionId }))), false);
    assert.equal(await commands.acknowledge('devices/d1/ack', Buffer.from(JSON.stringify(rejectedAck))), true);
    assert.equal((await commands.get(rejected.commandId)).status, 'rejected');
    assert.equal((await missions.get(mission.missionId)).status, 'active');
    assert.equal(rejectedMessage.command, 'MISSION_PAUSE');
    await action('pause');
    assert.equal((await missions.get(mission.missionId)).status, 'paused');
    await action('resume');
    await action('complete');
    assert.equal((await missions.get(mission.missionId)).status, 'completed');
    assert.equal((await Device.findOne({ deviceId: 'd1' }).lean()).activeMissionId, null);
    const cancelled = await missions.create({ type: 'survey', parameters: {} }, user);
    await missions.assign(cancelled.missionId, 'd1');
    for (const next of ['start', 'cancel']) {
      const command = await commands.dispatch(cancelled.missionId, next, user);
      assert.ok(command);
      const ack = simulator.handle(Buffer.from(sent.at(-1).raw));
      assert.equal(await commands.acknowledge('devices/d1/ack', Buffer.from(JSON.stringify(ack))), true);
    }
    assert.equal((await missions.get(cancelled.missionId)).status, 'cancelled');
    assert.equal((await Device.findOne({ deviceId: 'd1' }).lean()).activeMissionId, null);
    const second = await missions.create({ type: 'survey', parameters: {} }, user);
    await missions.assign(second.missionId, 'd1');
    broker.connected = false;
    assert.equal(await commands.dispatch(second.missionId, 'start', user), null);
    broker.connected = true;
    const starts = await Promise.all([commands.dispatch(second.missionId, 'start', user), commands.dispatch(second.missionId, 'start', user)]);
    assert.equal(starts.filter(Boolean).length, 1);
    const pending = starts.find(Boolean);
    assert.ok(pending);
    assert.equal(await missions.cancel(second.missionId), null);
    await Command.updateOne({ commandId: pending.commandId }, { $set: { expiresAt: new Date(Date.now() - 1) } });
    await commands.expire();
    assert.equal((await commands.get(pending.commandId)).status, 'timed_out');
    assert.equal((await Device.findOne({ deviceId: 'd1' }).lean()).activeMissionId, second.missionId);
    assert.equal(await commands.dispatch(second.missionId, 'start', user), null);
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
