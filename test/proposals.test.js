const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createProposalService, riskPolicy, riskPolicyVersion, ProposalError } = require('../src/proposals');
const { createApp } = require('../src/app');

function memoryModel() {
  const records = [];
  const matches = (record, filter) => Object.entries(filter).every(([key, value]) => {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.entries(value).every(([op, expected]) => op === '$gt' ? record[key] > expected : false);
    }
    return record[key] === value;
  });
  const query = (run) => ({ session() { return this; }, lean() { return Promise.resolve(run()); }, then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); } });
  return {
    records,
    Model: {
      async create(docs) { records.push(...structuredClone(docs)); return docs; },
      findOne(filter) { return query(() => structuredClone(records.find((record) => matches(record, filter)) || null)); },
      findOneAndUpdate(filter, update) { return query(() => {
        const record = records.find((entry) => matches(entry, filter));
        if (!record) return null;
        Object.assign(record, structuredClone(update.$set || {}));
        return structuredClone(record);
      }); },
      async updateOne(filter, update) {
        const record = records.find((entry) => matches(entry, filter));
        if (!record) return { modifiedCount: 0 };
        Object.assign(record, structuredClone(update.$set || {}));
        return { modifiedCount: 1 };
      },
    },
  };
}

const operator = { sub: 'operator-1', role: 'operator', exp: Math.floor(Date.now() / 1000) + 600 };
const missionId = '3c0c7d5d-c80c-4c71-86ae-f963c7f50c1f';

function setup() {
  const { Model: Proposal, records } = memoryModel();
  const calls = [];
  const service = createProposalService({
    Proposal,
    connection: { async transaction(callback) { return callback({}); } },
    missions: {
      async create(input, user, options) { calls.push(['create', input, user.sub, options]); return { missionId, status: 'created' }; },
      async assign(id, deviceId) { calls.push(['assign', id, deviceId]); return { missionId: id, status: 'assigned' }; },
    },
    commands: { async dispatch(id, action, user) { calls.push(['command', id, action, user.sub]); return { commandId: 'command-1', status: 'pending' }; } },
  });
  return { service, records, calls };
}

test('backend risk policy auto-applies only an unassigned draft', async () => {
  assert.deepEqual(riskPolicy, { create_draft: 'low', assign_device: 'high', mission_command: 'high' });
  const { service, calls } = setup();
  const result = await service.propose({ action: 'create_draft', type: 'survey', parameters: {} }, operator);
  assert.deepEqual(result, { action: 'create_draft', riskTier: 'low', status: 'applied', missionId, missionStatus: 'created' });
  assert.deepEqual(calls, [['create', { type: 'survey', parameters: {} }, operator.sub, { source: 'ai' }]]);
  await assert.rejects(service.propose({ action: 'create_draft', type: 'survey', parameters: {}, riskTier: 'low' }, operator));
  assert.equal(calls.length, 1);
});

test('high-risk mission actions require human approval and dispatch once', async () => {
  const { service, calls } = setup();
  const pending = await service.propose({ action: 'assign_device', missionId, deviceId: 'drone-1' }, operator);
  assert.equal(pending.riskTier, 'high');
  assert.equal(pending.policyVersion, riskPolicyVersion);
  assert.equal(pending.status, 'pending_approval');
  assert.equal(calls.length, 0);
  assert.equal(await service.get(pending.proposalId, { sub: 'other', role: 'operator' }), null);
  await assert.rejects(service.dispatch(pending.proposalId, 'not-approved', operator), { code: 'CONFLICT' });

  const approval = await service.approve(pending.proposalId, operator);
  assert.equal(approval.status, 'approved');
  assert.ok(approval.approvalId);
  await assert.rejects(service.dispatch(pending.proposalId, 'wrong-approval', operator), { code: 'CONFLICT' });
  await assert.rejects(service.dispatch(pending.proposalId, approval.approvalId, { ...operator, sub: 'other' }), { code: 'NOT_FOUND' });
  const applied = await service.dispatch(pending.proposalId, approval.approvalId, operator);
  assert.equal(applied.status, 'applied');
  assert.deepEqual(calls, [['assign', missionId, 'drone-1']]);
  await assert.rejects(service.dispatch(pending.proposalId, approval.approvalId, operator), { code: 'CONFLICT' });
});

test('high-risk command proposals use backend dispatch policy and expire approvals', async () => {
  const { service, records, calls } = setup();
  const pending = await service.propose({ action: 'mission_command', missionId, command: 'start' }, operator);
  const approval = await service.approve(pending.proposalId, operator);
  const result = await service.dispatch(pending.proposalId, approval.approvalId, operator);
  assert.equal(result.status, 'dispatched');
  assert.deepEqual(calls, [['command', missionId, 'start', operator.sub]]);

  const expiring = await service.propose({ action: 'mission_command', missionId, command: 'pause' }, operator);
  const expiringApproval = await service.approve(expiring.proposalId, operator);
  records.find((entry) => entry.proposalId === expiring.proposalId).approvalExpiresAt = new Date(0);
  await assert.rejects(service.dispatch(expiring.proposalId, expiringApproval.approvalId, operator), { code: 'EXPIRED' });
  assert.equal(records.find((entry) => entry.proposalId === expiring.proposalId).status, 'expired');
  assert.equal(calls.length, 1);
});

test('approval and dispatch invalidate proposals from an obsolete risk policy', async () => {
  const { service, records, calls } = setup();
  const pending = await service.propose({ action: 'mission_command', missionId, command: 'start' }, operator);
  const approval = await service.approve(pending.proposalId, operator);
  records.find((entry) => entry.proposalId === pending.proposalId).policyVersion--;
  await assert.rejects(service.dispatch(pending.proposalId, approval.approvalId, operator), { code: 'POLICY_CHANGED' });
  assert.equal(records.find((entry) => entry.proposalId === pending.proposalId).status, 'invalidated');

  const pending2 = await service.propose({ action: 'mission_command', missionId, command: 'pause' }, operator);
  records.find((entry) => entry.proposalId === pending2.proposalId).policyVersion--;
  await assert.rejects(service.approve(pending2.proposalId, operator), { code: 'POLICY_CHANGED' });
  assert.equal(records.find((entry) => entry.proposalId === pending2.proposalId).status, 'invalidated');
  assert.equal(calls.length, 0);
});

test('expired actors cannot create proposals and rejected proposals cannot dispatch', async () => {
  const { service, calls } = setup();
  await assert.rejects(service.propose({ action: 'create_draft', type: 'survey', parameters: {} }, { ...operator, exp: 1 }), { code: 'FORBIDDEN' });
  const pending = await service.propose({ action: 'mission_command', missionId, command: 'cancel' }, operator);
  const rejected = await service.reject(pending.proposalId, operator);
  assert.equal(rejected.status, 'rejected');
  await assert.rejects(service.approve(pending.proposalId, operator), { code: 'CONFLICT' });
  assert.equal(calls.length, 0);
});

test('proposal endpoints authenticate, validate approval, and require the approval ID at dispatch', async (t) => {
  const secret = 'test-secret-at-least-thirty-two-characters';
  const token = jwt.sign({ role: 'operator' }, secret, { subject: operator.sub, issuer: 'droneops', audience: 'droneops-api', expiresIn: '1h' });
  const id = '6b47e733-33a9-4c46-9bd0-a92f580236fa';
  const calls = [];
  const service = {
    async get(proposalId, user) { calls.push(['get', proposalId, user.sub]); return proposalId === id ? { proposalId, status: 'pending_approval' } : null; },
    async approve(proposalId, user) { calls.push(['approve', proposalId, user.sub]); return { proposalId, status: 'approved', approvalId: 'b40916ac-9a85-43fd-82a2-b043467ab7f5' }; },
    async reject(proposalId, user) { calls.push(['reject', proposalId, user.sub]); throw new ProposalError('CONFLICT'); },
    async dispatch(proposalId, approvalId, user) { calls.push(['dispatch', proposalId, approvalId, user.sub]); return { proposalId, status: 'dispatched' }; },
  };
  const server = createApp({ devices: {}, missions: {}, history: {}, proposals: service, jwtSecret: secret }).listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/v1/ai/proposals/${id}`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ai/proposals/not-a-uuid`, { headers })).status, 400);
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal((await fetch(`${url}/approve`, { method: 'POST', headers, body: JSON.stringify({ riskTier: 'low' }) })).status, 400);
  assert.equal((await fetch(`${url}/approve`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(`${url}/dispatch`, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(`${url}/dispatch`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId: 'b40916ac-9a85-43fd-82a2-b043467ab7f5' }) })).status, 401);
  const dispatch = await fetch(`${url}/dispatch`, { method: 'POST', headers, body: JSON.stringify({ approvalId: 'b40916ac-9a85-43fd-82a2-b043467ab7f5' }) });
  assert.equal(dispatch.status, 202);
  assert.deepEqual(calls, [['get', id, operator.sub], ['approve', id, operator.sub], ['dispatch', id, 'b40916ac-9a85-43fd-82a2-b043467ab7f5', operator.sub]]);
});
