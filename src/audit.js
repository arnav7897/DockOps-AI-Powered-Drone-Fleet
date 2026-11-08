const { randomUUID } = require('node:crypto');

function createAuditModel(mongoose) {
  const schema = new mongoose.Schema({
    eventId: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    timestamp: { type: Date, required: true },
    missionId: String, deviceId: String, correlationId: String, proposalId: String,
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  }, { versionKey: false });
  schema.index({ missionId: 1, timestamp: -1 });
  schema.index({ deviceId: 1, timestamp: -1 });
  schema.index({ proposalId: 1, timestamp: -1 });
  return mongoose.model('AuditEvent', schema);
}

async function recordAudit(Audit, event, session) {
  if (Audit) await Audit.create([{ eventId: randomUUID(), timestamp: new Date(), ...event }], { session });
}
module.exports = { createAuditModel, recordAudit };
