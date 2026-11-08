const { z } = require('zod');
const { eventFilters } = require('./history');

const deviceInput = z.object({ deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict();
const missionInput = z.object({ missionId: z.uuid() }).strict();
const emptyInput = z.object({}).strict();
const safeText = (value) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : value;

const toolDefinitions = [
  { name: 'getFleetSnapshot', description: 'Read the current device and mission summaries.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'getDeviceStatus', description: 'Read the current status for one device.', inputSchema: { type: 'object', properties: { deviceId: { type: 'string', maxLength: 64, pattern: '^[a-zA-Z0-9_-]{1,64}$' } }, required: ['deviceId'], additionalProperties: false } },
  { name: 'getMissionStatus', description: 'Read the current status for one mission.', inputSchema: { type: 'object', properties: { missionId: { type: 'string', format: 'uuid' } }, required: ['missionId'], additionalProperties: false } },
  { name: 'getRecentEvents', description: 'Read recent operational events using supported filters.', inputSchema: { type: 'object', properties: { deviceId: { type: 'string', maxLength: 64, pattern: '^[a-zA-Z0-9_-]{1,64}$' }, missionId: { type: 'string', format: 'uuid' }, correlationId: { type: 'string', format: 'uuid' }, kind: { type: 'string', enum: ['device', 'command', 'audit'] } }, additionalProperties: false } },
];

function createAiTools({ devices, missions, history }) {
  const tools = {
    async getFleetSnapshot(args) {
      emptyInput.parse(args);
      const [allDevices, allMissions] = await Promise.all([devices.list({ limit: 101 }), missions.list({ limit: 101 })]);
      const deviceList = allDevices.slice(0, 100);
      const missionList = allMissions.slice(0, 100);
      return {
        truncated: allDevices.length > 100 || allMissions.length > 100,
        devices: deviceList.map(({ deviceId, name, capabilities, connectivityState, operationalState, lastSeenAt, activeMissionId, stale }) => ({ deviceId, name, capabilities, connectivityState, operationalState, lastSeenAt, activeMissionId, stale })),
        missions: missionList.map(({ missionId, type, status, assignedDeviceId, failureReason, pendingCommandId, createdAt, updatedAt }) => ({ missionId, type, status, assignedDeviceId, failureReason: safeText(failureReason), pendingCommandId, createdAt, updatedAt })),
      };
    },
    async getDeviceStatus(args) {
      const { deviceId } = deviceInput.parse(args);
      const device = await devices.get(deviceId);
      if (!device) return null;
      const { name, capabilities, connectivityState, operationalState, lastSeenAt, activeMissionId, stale } = device;
      return { deviceId, name, capabilities, connectivityState, operationalState, lastSeenAt, activeMissionId, stale };
    },
    async getMissionStatus(args) {
      const { missionId } = missionInput.parse(args);
      const mission = await missions.get(missionId);
      if (!mission) return null;
      const { type, status, assignedDeviceId, failureReason, pendingCommandId, createdAt, updatedAt } = mission;
      return { missionId, type, status, assignedDeviceId, failureReason: safeText(failureReason), pendingCommandId, createdAt, updatedAt };
    },
    async getRecentEvents(args) {
      const filters = eventFilters.parse(args);
      const events = await history.events(filters);
      return events.map(({ kind, timestamp, data = {} }) => {
        if (kind === 'device') {
          const payload = data.payload || {};
          return { kind, timestamp, eventId: data.messageId, deviceId: data.deviceId, type: data.type,
            payload: { ...(payload.connectivity ? { connectivity: payload.connectivity } : {}), ...(payload.operationalState ? { operationalState: payload.operationalState } : {}) } };
        }
        if (kind === 'command') {
          const { commandId, correlationId, missionId, deviceId, action, command, status, issuedAt, expiresAt, acknowledgedAt, failureReason } = data;
          return { kind, timestamp, commandId, correlationId, missionId, deviceId, action, command, status, issuedAt, expiresAt, acknowledgedAt, failureReason: safeText(failureReason) };
        }
        const { eventId, type, missionId, deviceId, correlationId } = data;
        return { kind: 'audit', timestamp, eventId, type, missionId, deviceId, correlationId };
      });
    },
  };
  return {
    definitions: toolDefinitions,
    async execute(name, args) {
      if (!Object.hasOwn(tools, name)) throw new Error('Unknown AI tool');
      return tools[name](args);
    },
  };
}

module.exports = { createAiTools, toolDefinitions };
