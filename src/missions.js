const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { recordAudit } = require('./audit');

const missionInput = z.object({
  type: z.string().trim().min(1).max(100),
  parameters: z.record(z.string().max(100), z.unknown()),
}).strict();

function createMissionModel(mongoose) {
  const schema = new mongoose.Schema({
    missionId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    parameters: { type: mongoose.Schema.Types.Mixed, required: true },
    status: { type: String, required: true, enum: ['created', 'assigned', 'active', 'paused', 'cancelled', 'completed', 'failed'] },
    assignedDeviceId: { type: String, default: null },
    createdBy: { type: String, required: true },
    failureReason: { type: String, default: null },
    pendingCommandId: { type: String, default: null },
  }, { timestamps: true, versionKey: false, minimize: false });
  return mongoose.model('Mission', schema);
}

function createMissionStore(Mission, Device, connection, staleAfterMs = 60000, Audit) {
  return {
    async create(input, user) {
      const missionId = randomUUID();
      return connection.transaction(async (session) => {
        const [mission] = await Mission.create([{ ...input, missionId, status: 'created', createdBy: user.sub }], { session });
        await recordAudit(Audit, { type: 'MISSION_CREATED', missionId, metadata: { createdBy: user.sub } }, session);
        return mission.toObject();
      });
    },
    get(missionId) { return Mission.findOne({ missionId }).lean(); },
    list({ limit = 100 } = {}) { return Mission.find().sort({ updatedAt: -1 }).limit(limit).lean(); },
    async cancel(missionId) {
      return connection.transaction(async (session) => {
        const mission = await Mission.findOneAndUpdate({ missionId, status: { $in: ['created', 'assigned'] }, pendingCommandId: null }, { $set: { status: 'cancelled' } }, { session, returnDocument: 'after' }).lean();
        if (!mission) return null;
        if (mission.assignedDeviceId) await Device.updateOne({ deviceId: mission.assignedDeviceId, activeMissionId: missionId }, { $set: { activeMissionId: null } }, { session });
        await recordAudit(Audit, { type: 'MISSION_CANCELLED', missionId, deviceId: mission.assignedDeviceId || undefined }, session);
        return mission;
      });
    },
    async assign(missionId, deviceId) {
      return connection.transaction(async (session) => {
        const mission = await Mission.findOne({ missionId, status: 'created' }).session(session).lean();
        if (!mission) return null;
        const device = await Device.findOneAndUpdate({
          deviceId, connectivityState: 'online', operationalState: 'idle', activeMissionId: null,
          capabilities: mission.type, lastSeenAt: { $gte: new Date(Date.now() - staleAfterMs), $lte: new Date(Date.now() + 30000) },
        }, { $set: { activeMissionId: missionId } }, { session, returnDocument: 'after' }).lean();
        if (!device) return null;
        const result = await Mission.findOneAndUpdate({ missionId, status: 'created' }, {
          $set: { status: 'assigned', assignedDeviceId: deviceId },
        }, { session, returnDocument: 'after' }).lean();
        if (!result) throw new Error('Mission changed during assignment');
        await recordAudit(Audit, { type: 'MISSION_ASSIGNED', missionId, deviceId }, session);
        return result;
      });
    },
  };
}

module.exports = { missionInput, createMissionModel, createMissionStore };
