const { randomUUID } = require('node:crypto');
const { z } = require('zod');

const actions = Object.freeze({
  start: { from: ['assigned'], to: 'active', command: 'MISSION_START' },
  pause: { from: ['active'], to: 'paused', command: 'MISSION_PAUSE' },
  resume: { from: ['paused'], to: 'active', command: 'MISSION_RESUME' },
  complete: { from: ['active', 'paused'], to: 'completed', command: 'MISSION_COMPLETE' },
  cancel: { from: ['active', 'paused'], to: 'cancelled', command: 'MISSION_CANCEL' },
});

function createCommandModel(mongoose) {
  return mongoose.model('Command', new mongoose.Schema({
    commandId: { type: String, required: true, unique: true },
    correlationId: { type: String, required: true },
    missionId: { type: String, required: true },
    deviceId: { type: String, required: true },
    action: { type: String, required: true },
    command: { type: String, required: true },
    fromStatus: { type: String, required: true },
    toStatus: { type: String, required: true },
    status: { type: String, required: true, enum: ['pending', 'acknowledged', 'rejected', 'failed', 'timed_out'] },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    acknowledgedAt: Date,
    failureReason: String,
    requestedBy: { type: String, required: true },
  }, { timestamps: true, versionKey: false }));
}

const ackSchema = z.object({
  schemaVersion: z.literal(1), commandId: z.uuid(), correlationId: z.uuid(),
  missionId: z.uuid(), deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  timestamp: z.iso.datetime({ offset: true }), status: z.enum(['acknowledged', 'rejected']),
}).strict();

function createCommandService({ Command, Mission, Device, connection, broker }) {
  async function prepare(missionId, action, user) {
    const policy = actions[action];
    if (!policy || !user || !['admin', 'operator'].includes(user.role) || typeof user.sub !== 'string' || !user.sub || !Number.isFinite(user.exp) || user.exp * 1000 <= Date.now()) return null;
    if (!broker?.connected || !broker.readyForCommands) return null;
    return connection.transaction(async (session) => {
      const now = new Date();
      if (user.exp * 1000 <= now.getTime() || !broker.connected || !broker.readyForCommands) return null;
      const mission = await Mission.findOne({ missionId, status: { $in: policy.from }, pendingCommandId: null }).session(session).lean();
      if (!mission) return null;
      // Touch the device in the transaction so a concurrent status change conflicts.
      const device = await Device.findOneAndUpdate({ deviceId: mission.assignedDeviceId, activeMissionId: missionId,
        connectivityState: 'online', ...(action === 'start' ? { operationalState: 'idle' } : {}),
        capabilities: mission.type, lastSeenAt: { $gte: new Date(now.getTime() - 60000), $lte: new Date(now.getTime() + 30000) },
      }, { $set: { activeMissionId: missionId } }, { session, returnDocument: 'after' }).lean();
      if (!device) return null;
      const commandId = randomUUID();
      const updated = await Mission.updateOne({ missionId, status: mission.status, pendingCommandId: null }, { $set: { pendingCommandId: commandId } }, { session });
      if (updated.modifiedCount !== 1) throw new Error('Mission changed during dispatch');
      const [command] = await Command.create([{ commandId, correlationId: randomUUID(), missionId, deviceId: device.deviceId,
        action, command: policy.command, fromStatus: mission.status, toStatus: policy.to, status: 'pending',
        issuedAt: now, expiresAt: new Date(Math.min(now.getTime() + 30000, user.exp * 1000)), requestedBy: user.sub }], { session });
      return command.toObject();
    });
  }

  async function abandonUnsent(command, reason) {
    return connection.transaction(async (session) => {
      const result = await Command.updateOne({ commandId: command.commandId, status: 'pending' }, { $set: { status: 'failed', failureReason: reason } }, { session });
      if (result.modifiedCount) await Mission.updateOne({ missionId: command.missionId, pendingCommandId: command.commandId }, { $set: { pendingCommandId: null } }, { session });
    });
  }

  async function dispatch(missionId, action, user) {
    const command = await prepare(missionId, action, user);
    if (!command) return null;
    const now = Date.now();
    const mission = await Mission.findOne({ missionId, status: command.fromStatus, pendingCommandId: command.commandId }).lean();
    const eligible = mission && await Device.exists({ deviceId: command.deviceId, activeMissionId: missionId, connectivityState: 'online', capabilities: mission.type,
      ...(action === 'start' ? { operationalState: 'idle' } : {}), lastSeenAt: { $gte: new Date(now - 60000), $lte: new Date(now + 30000) } });
    if (!eligible || !broker.connected || !broker.readyForCommands || user.exp * 1000 <= Date.now() || command.expiresAt.getTime() <= Date.now()) {
      await abandonUnsent(command, 'Dispatch preconditions changed');
      return null;
    }
    const envelope = { schemaVersion: 1, commandId: command.commandId, correlationId: command.correlationId,
      missionId, command: command.command, issuedAt: command.issuedAt.toISOString(), expiresAt: command.expiresAt.toISOString(),
      payload: action === 'start' ? { type: mission.type, parameters: mission.parameters ?? {} } : {} };
    try {
      // Do not queue requests in memory when disconnected; uncertain delivery keeps the reservation.
      let timeout;
      try {
        await Promise.race([
          broker.publishAsync(`devices/${command.deviceId}/commands`, JSON.stringify(envelope), { qos: 1, retain: false }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Publish timed out')), 5000); }),
        ]);
      } finally { clearTimeout(timeout); }
    } catch (err) {
      await Command.updateOne({ commandId: command.commandId, status: 'pending' }, { $set: { failureReason: 'Publish outcome uncertain' } });
    }
    return Command.findOne({ commandId: command.commandId }).lean();
  }

  async function acknowledge(topic, raw) {
    const match = /^devices\/([a-zA-Z0-9_-]{1,64})\/ack$/.exec(topic);
    if (!match || raw.length > 16384) return false;
    let parsed;
    try { parsed = ackSchema.safeParse(JSON.parse(raw.toString())); } catch { return false; }
    if (!parsed.success || parsed.data.deviceId !== match[1]) return false;
    const ack = parsed.data;
    return connection.transaction(async (session) => {
      const now = new Date();
      const timestamp = new Date(ack.timestamp);
      if (timestamp.getTime() > now.getTime() + 30000 || timestamp.getTime() < now.getTime() - 300000) return false;
      const command = await Command.findOne({ commandId: ack.commandId, correlationId: ack.correlationId, missionId: ack.missionId, deviceId: ack.deviceId, status: 'pending', expiresAt: { $gt: now } }).session(session).lean();
      if (!command || timestamp < command.issuedAt || timestamp > command.expiresAt) return false;
      const mission = await Mission.findOneAndUpdate({ missionId: command.missionId, status: command.fromStatus, pendingCommandId: command.commandId },
        { $set: { pendingCommandId: null, ...(ack.status === 'acknowledged' ? { status: command.toStatus } : {}) } }, { session, returnDocument: 'after' }).lean();
      if (!mission) return false;
      await Command.updateOne({ commandId: command.commandId, status: 'pending' }, { $set: { status: ack.status, acknowledgedAt: now } }, { session });
      if (ack.status === 'acknowledged' && ['completed', 'cancelled'].includes(command.toStatus)) {
        await Device.updateOne({ deviceId: command.deviceId, activeMissionId: command.missionId }, { $set: { activeMissionId: null } }, { session });
      }
      return true;
    });
  }

  async function expire() {
    // Timed-out deliveries are uncertain; pendingCommandId deliberately remains set.
    await Command.updateMany({ status: 'pending', expiresAt: { $lte: new Date() } }, { $set: { status: 'timed_out', failureReason: 'Acknowledgement not received before expiry' } });
  }
  return { dispatch, acknowledge, expire, get: (commandId) => Command.findOne({ commandId }).lean() };
}

module.exports = { actions, createCommandModel, createCommandService, ackSchema };
