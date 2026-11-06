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
  }, { timestamps: true, versionKey: false });
  return mongoose.model('Mission', schema);
}

function createMissionStore(Mission) {
  return {
    async create(input, user) {
      return (await Mission.create({ ...input, missionId: randomUUID(), status: 'created', createdBy: user.sub })).toObject();
    },
    get(missionId) { return Mission.findOne({ missionId }).lean(); },
    cancelDraft(missionId) {
      return Mission.findOneAndUpdate({ missionId, status: 'created' }, { $set: { status: 'cancelled' } }, { returnDocument: 'after' }).lean();
    },
  };
}

module.exports = { missionInput, createMissionModel, createMissionStore };
