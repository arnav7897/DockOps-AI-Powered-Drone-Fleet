const { z } = require('zod');
const { ingestStatus, ingestDisconnect } = require('./ingestion');

const eventFilters = z.object({
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).optional(),
  missionId: z.uuid().optional(), correlationId: z.uuid().optional(),
  kind: z.enum(['device', 'command', 'audit']).optional(),
}).strict();

function createHistory({ Device, Event, Command, Audit, Mission, staleAfterMs }) {
  return {
    async events(filters) {
      const deviceFilter = filters.deviceId ? { deviceId: filters.deviceId } : {};
      const commandFilter = { ...deviceFilter, ...(filters.missionId ? { missionId: filters.missionId } : {}), ...(filters.correlationId ? { correlationId: filters.correlationId } : {}) };
      const includeDevice = (!filters.kind || filters.kind === 'device') && !filters.missionId && !filters.correlationId;
      const includeCommand = !filters.kind || filters.kind === 'command';
      const includeAudit = !filters.kind || filters.kind === 'audit';
      const [events, commands, audit] = await Promise.all([
        includeDevice ? Event.find(deviceFilter).sort({ timestamp: -1, _id: -1 }).limit(100).lean() : [],
        includeCommand ? Command.find(commandFilter).sort({ updatedAt: -1, _id: -1 }).limit(100).lean() : [],
        includeAudit ? Audit.find(commandFilter).sort({ timestamp: -1, _id: -1 }).limit(100).lean() : [],
      ]);
      return [...events.map((event) => ({ kind: 'device', timestamp: event.timestamp, data: event })),
        ...commands.map((command) => ({ kind: 'command', timestamp: command.updatedAt, data: command })),
        ...audit.map((event) => ({ kind: 'audit', timestamp: event.timestamp, data: event }))]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 100);
    },
    async alerts() {
      const cutoff = new Date(Date.now() - staleAfterMs);
      const [devices, commands, faults] = await Promise.all([
        Device.find({ $or: [{ connectivityState: 'offline' }, { lastSeenAt: null }, { lastSeenAt: { $lt: cutoff } }] }).sort({ deviceId: 1 }).limit(100).lean(),
        Command.find({ status: 'timed_out' }).sort({ updatedAt: -1 }).limit(100).lean(),
        Audit.find({ type: { $in: ['COMMAND_REJECTED', 'COMMAND_FAILED'] } }).sort({ timestamp: -1 }).limit(100).lean(),
      ]);
      return {
        devices: devices.map((device) => ({ deviceId: device.deviceId, connectivityState: device.connectivityState, lastSeenAt: device.lastSeenAt,
          stale: !device.lastSeenAt || device.lastSeenAt < cutoff })),
        commands: commands.map((command) => ({ commandId: command.commandId, missionId: command.missionId, deviceId: command.deviceId, status: command.status, expiresAt: command.expiresAt })),
        faults,
      };
    },
    async replay(deviceId) {
      if (!await Device.exists({ deviceId })) return null;
      const events = await Event.find({ deviceId }).sort({ _id: 1 }).limit(1001).lean();
      if (events.length > 1000) return { tooMany: true };
      const state = { connectivityState: 'offline', operationalState: 'unknown', lastSeenAt: null, sessionId: null, disconnectedSessionId: null };
      let applied = 0;
      const store = {
        async recordStatus(message) {
          const time = new Date(message.timestamp);
          if ((message.sessionId && message.sessionId === state.disconnectedSessionId) || (state.lastSeenAt && time <= state.lastSeenAt)) return false;
          Object.assign(state, { connectivityState: message.payload.connectivity, operationalState: message.payload.operationalState, lastSeenAt: time, sessionId: message.sessionId || null });
          return true;
        },
        async recordDisconnect(message) {
          if (state.sessionId !== message.sessionId || state.disconnectedSessionId === message.sessionId) return false;
          state.connectivityState = 'offline'; state.disconnectedSessionId = message.sessionId; return true;
        },
      };
      for (const event of events) {
        const common = { schemaVersion: 1, messageId: event.messageId, deviceId, type: event.type, ...(event.sessionId ? { sessionId: event.sessionId } : {}) };
        let accepted = false;
        if (event.type === 'STATUS_UPDATE') accepted = await ingestStatus(`devices/${deviceId}/status`, Buffer.from(JSON.stringify({ ...common, timestamp: event.timestamp.toISOString(), payload: event.payload })), store, event.timestamp.getTime());
        if (event.type === 'DEVICE_DISCONNECTED') accepted = await ingestDisconnect(`devices/${deviceId}/events`, Buffer.from(JSON.stringify(common)), store);
        if (accepted) applied++;
      }
      return { deviceId, eventsRead: events.length, eventsApplied: applied, state };
    },
    async replayMission(missionId) {
      if (!await Mission.exists({ missionId })) return null;
      const events = await Audit.find({ missionId }).sort({ _id: 1 }).limit(1001).lean();
      if (events.length > 1000) return { tooMany: true };
      let state = null, incomplete = false;
      for (const event of events) {
        const metadata = event.metadata || {};
        if (event.type === 'MISSION_CREATED') {
          if (state) incomplete = true;
          else state = { status: 'created', assignedDeviceId: null, pendingCommandId: null };
        } else if (!state) incomplete = true;
        else if (event.type === 'MISSION_ASSIGNED') {
          if (state.status !== 'created') incomplete = true;
          state.status = 'assigned'; state.assignedDeviceId = event.deviceId;
        } else if (event.type === 'MISSION_CANCELLED') {
          if (!['created', 'assigned'].includes(state.status) || state.pendingCommandId) incomplete = true;
          state.status = 'cancelled';
        } else if (event.type === 'COMMAND_PENDING') {
          if (state.pendingCommandId) incomplete = true;
          state.pendingCommandId = metadata.commandId;
        } else if (['COMMAND_ACKNOWLEDGED', 'COMMAND_REJECTED', 'COMMAND_FAILED'].includes(event.type)) {
          if (state.pendingCommandId !== metadata.commandId) incomplete = true;
          if (event.type === 'COMMAND_ACKNOWLEDGED') state.status = metadata.toStatus;
          state.pendingCommandId = null;
        } else if (event.type === 'COMMAND_TIMED_OUT' && state.pendingCommandId !== metadata.commandId) incomplete = true;
      }
      return { missionId, eventsRead: events.length, incomplete: incomplete || !state, state };
    },
  };
}
module.exports = { eventFilters, createHistory };
