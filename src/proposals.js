const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { recordAudit } = require('./audit');
const { actions } = require('./commands');

const deviceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const proposalInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create_draft'), type: z.string().trim().min(1).max(100), parameters: z.record(z.string().max(100), z.unknown()).refine((value) => Object.keys(value).length <= 32) }).strict(),
  z.object({ action: z.literal('assign_device'), missionId: z.uuid(), deviceId: deviceIdSchema }).strict(),
  z.object({ action: z.literal('mission_command'), missionId: z.uuid(), command: z.enum(Object.keys(actions)) }).strict(),
]);

const riskPolicy = Object.freeze({ create_draft: 'low', assign_device: 'high', mission_command: 'high' });
const riskPolicyVersion = 1;
const proposalLifetimeMs = 10 * 60 * 1000;
const approvalLifetimeMs = 60 * 1000;

class ProposalError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function canAccess(proposal, user) { return user?.role === 'admin' || proposal.requestedBy === user?.sub; }
function validActor(user) { return user && ['admin', 'operator'].includes(user.role) && typeof user.sub === 'string' && user.sub && Number.isFinite(user.exp) && user.exp * 1000 > Date.now(); }
function summary(proposal, { includeApproval = false } = {}) {
  if (!proposal) return null;
  return {
    proposalId: proposal.proposalId, action: proposal.action, riskTier: proposal.riskTier, policyVersion: proposal.policyVersion, status: proposal.status,
    payload: proposal.payload, requestedBy: proposal.requestedBy, missionId: proposal.missionId || null,
    expiresAt: proposal.expiresAt, approvalExpiresAt: proposal.approvalExpiresAt || null,
    ...(includeApproval && proposal.approvalId ? { approvalId: proposal.approvalId } : {}),
    ...(proposal.result ? { result: proposal.result } : {}),
  };
}

function createProposalService({ Proposal, missions, commands, connection, Audit }) {
  async function audit(proposal, type, session, metadata = {}) {
    await recordAudit(Audit, { type, proposalId: proposal.proposalId, missionId: proposal.missionId || undefined,
      metadata: { action: proposal.action, riskTier: proposal.riskTier, ...metadata } }, session);
  }

  async function propose(input, user) {
    if (!validActor(user)) throw new ProposalError('FORBIDDEN');
    const action = proposalInput.parse(input);
    if (Buffer.byteLength(JSON.stringify(action)) > 6000) throw new ProposalError('INVALID');
    const riskTier = riskPolicy[action.action];
    if (action.action === 'create_draft') {
      const mission = await missions.create({ type: action.type, parameters: action.parameters }, user, { source: 'ai' });
      return { action: action.action, riskTier, status: 'applied', missionId: mission.missionId, missionStatus: mission.status };
    }

    const proposal = {
      proposalId: randomUUID(), action: action.action, riskTier, policyVersion: riskPolicyVersion, status: 'pending_approval', payload: action,
      requestedBy: user.sub, missionId: action.missionId, createdAt: new Date(), expiresAt: new Date(Date.now() + proposalLifetimeMs),
    };
    await connection.transaction(async (session) => {
      await Proposal.create([proposal], { session });
      await audit(proposal, 'AI_PROPOSAL_CREATED', session);
    });
    return summary(proposal);
  }

  async function get(proposalId, user) {
    const proposal = await Proposal.findOne({ proposalId }).lean();
    return proposal && canAccess(proposal, user) ? summary(proposal) : null;
  }

  async function approve(proposalId, user) {
    if (!validActor(user)) throw new ProposalError('FORBIDDEN');
    const now = new Date();
    const outcome = await connection.transaction(async (session) => {
      const proposal = await Proposal.findOne({ proposalId }).session(session).lean();
      if (!proposal || !canAccess(proposal, user)) return { error: 'NOT_FOUND' };
      if (proposal.riskTier !== 'high' || riskPolicy[proposal.action] !== 'high' || proposal.status !== 'pending_approval') return { error: 'CONFLICT' };
      if (proposal.policyVersion !== riskPolicyVersion) {
        await Proposal.updateOne({ proposalId, status: 'pending_approval' }, { $set: { status: 'invalidated' } }, { session });
        await audit(proposal, 'AI_PROPOSAL_INVALIDATED', session, { reason: 'Risk policy changed' });
        return { error: 'POLICY_CHANGED' };
      }
      if (proposal.expiresAt <= now) {
        await Proposal.updateOne({ proposalId, status: 'pending_approval' }, { $set: { status: 'expired' } }, { session });
        await audit(proposal, 'AI_PROPOSAL_EXPIRED', session);
        return { error: 'EXPIRED' };
      }
      const approvalId = randomUUID();
      const updated = await Proposal.findOneAndUpdate({ proposalId, status: 'pending_approval', expiresAt: { $gt: now } }, {
        $set: { status: 'approved', approvedBy: user.sub, approvalId, approvedAt: now, approvalExpiresAt: new Date(Math.min(proposal.expiresAt.getTime(), now.getTime() + approvalLifetimeMs)) },
      }, { session, returnDocument: 'after' }).lean();
      if (!updated) return { error: 'CONFLICT' };
      await audit(updated, 'AI_PROPOSAL_APPROVED', session, { approvedBy: user.sub });
      return { proposal: summary(updated, { includeApproval: true }) };
    });
    if (outcome.error) throw new ProposalError(outcome.error);
    return outcome.proposal;
  }

  async function reject(proposalId, user) {
    if (!validActor(user)) throw new ProposalError('FORBIDDEN');
    const outcome = await connection.transaction(async (session) => {
      const proposal = await Proposal.findOne({ proposalId }).session(session).lean();
      if (!proposal || !canAccess(proposal, user)) return { error: 'NOT_FOUND' };
      if (proposal.riskTier !== 'high' || riskPolicy[proposal.action] !== 'high' || proposal.status !== 'pending_approval') return { error: 'CONFLICT' };
      const now = new Date();
      if (proposal.expiresAt <= now) {
        await Proposal.updateOne({ proposalId, status: 'pending_approval' }, { $set: { status: 'expired' } }, { session });
        await audit(proposal, 'AI_PROPOSAL_EXPIRED', session);
        return { error: 'EXPIRED' };
      }
      const updated = await Proposal.findOneAndUpdate({ proposalId, status: 'pending_approval', expiresAt: { $gt: now } }, {
        $set: { status: 'rejected', rejectedBy: user.sub, rejectedAt: now },
      }, { session, returnDocument: 'after' }).lean();
      if (!updated) return { error: 'EXPIRED' };
      await audit(updated, 'AI_PROPOSAL_REJECTED', session, { rejectedBy: user.sub });
      return { proposal: summary(updated) };
    });
    if (outcome.error) throw new ProposalError(outcome.error);
    return outcome.proposal;
  }

  async function finish(proposal, status, result) {
    await connection.transaction(async (session) => {
      const updated = await Proposal.findOneAndUpdate({ proposalId: proposal.proposalId, status: 'dispatching' }, {
        $set: { status, ...(result ? { result } : {}) },
      }, { session, returnDocument: 'after' }).lean();
      if (updated) await audit(updated, status === 'failed' ? 'AI_PROPOSAL_FAILED' : 'AI_PROPOSAL_DISPATCHED', session, result || {});
    });
  }

  async function dispatch(proposalId, approvalId, user) {
    if (!validActor(user)) throw new ProposalError('FORBIDDEN');
    const now = new Date();
    const outcome = await connection.transaction(async (session) => {
      const current = await Proposal.findOne({ proposalId }).session(session).lean();
      if (!current || !canAccess(current, user)) throw new ProposalError('NOT_FOUND');
      if (current.status !== 'approved' || current.riskTier !== 'high' || riskPolicy[current.action] !== 'high' || current.approvalId !== approvalId || current.approvedBy !== user.sub) throw new ProposalError('CONFLICT');
      if (current.policyVersion !== riskPolicyVersion) {
        await Proposal.updateOne({ proposalId, status: 'approved' }, { $set: { status: 'invalidated' } }, { session });
        await audit(current, 'AI_PROPOSAL_INVALIDATED', session, { reason: 'Risk policy changed' });
        return { error: 'POLICY_CHANGED' };
      }
      if (current.expiresAt <= now || current.approvalExpiresAt <= now) {
        await Proposal.updateOne({ proposalId, status: 'approved' }, { $set: { status: 'expired' } }, { session });
        await audit(current, 'AI_PROPOSAL_EXPIRED', session);
        return { error: 'EXPIRED' };
      }
      const claimed = await Proposal.findOneAndUpdate({ proposalId, status: 'approved', approvalId, approvedBy: user.sub, expiresAt: { $gt: now }, approvalExpiresAt: { $gt: now } }, {
        $set: { status: 'dispatching', dispatchStartedAt: now },
      }, { session, returnDocument: 'after' }).lean();
      if (!claimed) throw new ProposalError('CONFLICT');
      await audit(claimed, 'AI_PROPOSAL_DISPATCHING', session, { dispatchedBy: user.sub });
      return { proposal: claimed };
    });
    if (outcome.error) throw new ProposalError(outcome.error);
    const proposal = outcome.proposal;

    try {
      if (!validActor(user)) {
        await finish(proposal, 'failed', { reason: 'Operator authorization expired' });
        throw new ProposalError('FORBIDDEN');
      }
      let result;
      let status;
      if (proposal.action === 'assign_device') {
        result = await missions.assign(proposal.payload.missionId, proposal.payload.deviceId);
        status = 'applied';
      } else if (proposal.action === 'mission_command') {
        result = await commands.dispatch(proposal.payload.missionId, proposal.payload.command, user);
        status = 'dispatched';
      } else {
        throw new ProposalError('CONFLICT');
      }
      if (!result) {
        await finish(proposal, 'failed', { reason: 'Backend authorization, state or eligibility check failed' });
        throw new ProposalError('CONFLICT');
      }
      const safeResult = status === 'dispatched'
        ? { commandId: result.commandId, commandStatus: result.status }
        : { missionId: result.missionId, missionStatus: result.status };
      await finish(proposal, status, safeResult);
      return { ...summary(proposal), status, result: safeResult };
    } catch (error) {
      if (!(error instanceof ProposalError)) await finish(proposal, 'failed', { reason: 'Backend operation failed' });
      throw error;
    }
  }

  return { propose, get, approve, reject, dispatch };
}

function createProposalModel(mongoose) {
  const schema = new mongoose.Schema({
    proposalId: { type: String, required: true, unique: true }, action: { type: String, enum: Object.keys(riskPolicy), required: true },
    riskTier: { type: String, enum: ['low', 'high'], required: true }, policyVersion: { type: Number, required: true }, status: { type: String, enum: ['pending_approval', 'approved', 'dispatching', 'applied', 'dispatched', 'rejected', 'expired', 'invalidated', 'failed'], required: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true }, requestedBy: { type: String, required: true }, missionId: String,
    createdAt: { type: Date, required: true }, expiresAt: { type: Date, required: true }, approvedBy: String, approvedAt: Date,
    approvalId: String, approvalExpiresAt: Date, rejectedBy: String, rejectedAt: Date, dispatchStartedAt: Date,
    result: mongoose.Schema.Types.Mixed,
  }, { versionKey: false });
  schema.index({ requestedBy: 1, createdAt: -1 });
  return mongoose.model('AIProposal', schema);
}

module.exports = { proposalInput, riskPolicy, riskPolicyVersion, ProposalError, createProposalService, createProposalModel };
