const { randomUUID } = require('node:crypto');
const { z } = require('zod');

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
  }, { timestamps: true, versionKey: false });
  return mongoose.model('Mission', schema);
}

function createMissionStore(Mission, Device, connection) {
  return {
    async create(input, user) {
      return (await Mission.create({ ...input, missionId: randomUUID(), status: 'created', createdBy: user.sub })).toObject();
    },
    get(missionId) { return Mission.findOne({ missionId }).lean(); },
    async cancel(missionId) {
      const draft = await Mission.findOneAndUpdate({ missionId, status: 'created' }, { $set: { status: 'cancelled' } }, { returnDocument: 'after' }).lean();
      if (draft) return draft;
      return connection.transaction(async (session) => {
        const mission = await Mission.findOneAndUpdate({ missionId, status: 'assigned', pendingCommandId: null }, { $set: { status: 'cancelled' } }, { session, returnDocument: 'after' }).lean();
        if (!mission) return null;
        await Device.updateOne({ deviceId: mission.assignedDeviceId, activeMissionId: missionId }, { $set: { activeMissionId: null } }, { session });
        return mission;
      });
    },
    async assign(missionId, deviceId) {
      return connection.transaction(async (session) => {
        const mission = await Mission.findOne({ missionId, status: 'created' }).session(session).lean();
        if (!mission) return null;
        const device = await Device.findOneAndUpdate({
          deviceId, connectivityState: 'online', operationalState: 'idle', activeMissionId: null,
          capabilities: mission.type, lastSeenAt: { $gte: new Date(Date.now() - 60000), $lte: new Date(Date.now() + 30000) },
        }, { $set: { activeMissionId: missionId } }, { session, returnDocument: 'after' }).lean();
        if (!device) return null;
        const result = await Mission.findOneAndUpdate({ missionId, status: 'created' }, {
          $set: { status: 'assigned', assignedDeviceId: deviceId },
        }, { session, returnDocument: 'after' }).lean();
        if (!result) throw new Error('Mission changed during assignment');
        return result;
      });
    },
  };
}

module.exports = { missionInput, createMissionModel, createMissionStore };
