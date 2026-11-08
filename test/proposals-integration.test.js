const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { createMissionModel, createMissionStore } = require('../src/missions');
const { createCommandModel, createCommandService } = require('../src/commands');
const { createAuditModel } = require('../src/audit');
const { createProposalModel, createProposalService } = require('../src/proposals');

test('replica-set proposal flow audits drafts, approvals, revalidation and one-time command dispatch', { skip: !process.env.TEST_MONGODB_URI }, async () => {
  await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName: `droneops_proposals_${process.pid}` });
  try {
    const Device = mongoose.model('ProposalTestDevice', new mongoose.Schema({
      deviceId: String, connectivityState: String, operationalState: String, capabilities: [String],
      activeMissionId: { type: String, default: null }, lastSeenAt: Date,
    }));
    const Mission = createMissionModel(mongoose);
    const Command = createCommandModel(mongoose);
    const Audit = createAuditModel(mongoose);
    const Proposal = createProposalModel(mongoose);
    await Promise.all([Device.init(), Mission.init(), Command.init(), Audit.init(), Proposal.init()]);
    const user = { sub: 'ai-operator', role: 'operator', exp: Math.floor(Date.now() / 1000) + 3600 };
    const missions = createMissionStore(Mission, Device, mongoose.connection, 60000, Audit);
    const sent = [];
    const broker = { connected: true, readyForCommands: true, async publishAsync(topic, raw) { sent.push({ topic, envelope: JSON.parse(raw) }); } };
    const commands = createCommandService({ Command, Mission, Device, connection: mongoose.connection, broker, Audit });
    const proposals = createProposalService({ Proposal, missions, commands, connection: mongoose.connection, Audit });
    const device = (deviceId) => Device.create({ deviceId, connectivityState: 'online', operationalState: 'idle', capabilities: ['survey'], lastSeenAt: new Date() });
    await device('drone-1');

    const draft = await proposals.propose({ action: 'create_draft', type: 'survey', parameters: {} }, user);
    assert.equal(draft.riskTier, 'low');
    assert.equal((await Mission.findOne({ missionId: draft.missionId }).lean()).status, 'created');
    assert.equal((await Audit.findOne({ missionId: draft.missionId, type: 'MISSION_CREATED' }).lean()).metadata.source, 'ai');

    const assignment = await proposals.propose({ action: 'assign_device', missionId: draft.missionId, deviceId: 'drone-1' }, user);
    assert.equal((await Mission.findOne({ missionId: draft.missionId }).lean()).status, 'created');
    const assignmentApproval = await proposals.approve(assignment.proposalId, user);
    const applied = await proposals.dispatch(assignment.proposalId, assignmentApproval.approvalId, user);
    assert.equal(applied.status, 'applied');
    assert.equal((await Mission.findOne({ missionId: draft.missionId }).lean()).status, 'assigned');
    assert.equal((await Device.findOne({ deviceId: 'drone-1' }).lean()).activeMissionId, draft.missionId);
    await assert.rejects(proposals.dispatch(assignment.proposalId, assignmentApproval.approvalId, user), { code: 'CONFLICT' });

    const start = await proposals.propose({ action: 'mission_command', missionId: draft.missionId, command: 'start' }, user);
    const startApproval = await proposals.approve(start.proposalId, user);
    const dispatched = await proposals.dispatch(start.proposalId, startApproval.approvalId, user);
    assert.equal(dispatched.status, 'dispatched');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].envelope.command, 'MISSION_START');
    assert.equal((await Command.findOne({ commandId: dispatched.result.commandId }).lean()).status, 'pending');

    await device('drone-2');
    const staleDraft = await missions.create({ type: 'survey', parameters: {} }, user);
    const staleProposal = await proposals.propose({ action: 'assign_device', missionId: staleDraft.missionId, deviceId: 'drone-2' }, user);
    const staleApproval = await proposals.approve(staleProposal.proposalId, user);
    await Device.updateOne({ deviceId: 'drone-2' }, { $set: { lastSeenAt: new Date(Date.now() - 120000) } });
    await assert.rejects(proposals.dispatch(staleProposal.proposalId, staleApproval.approvalId, user), { code: 'CONFLICT' });
    assert.equal((await Mission.findOne({ missionId: staleDraft.missionId }).lean()).status, 'created');
    assert.equal((await Proposal.findOne({ proposalId: staleProposal.proposalId }).lean()).status, 'failed');
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
