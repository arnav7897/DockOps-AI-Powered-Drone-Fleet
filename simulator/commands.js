const { z } = require('zod');

const envelope = z.object({
  schemaVersion: z.literal(1), commandId: z.uuid(), correlationId: z.uuid(), missionId: z.uuid(),
  command: z.enum(['MISSION_START', 'MISSION_PAUSE', 'MISSION_RESUME', 'MISSION_COMPLETE', 'MISSION_CANCEL']),
  issuedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }),
  payload: z.union([z.object({}).strict(), z.object({ type: z.string().min(1).max(100), parameters: z.record(z.string().max(100), z.unknown()) }).strict()]),
}).strict();

function createSimulatorCommands(deviceId) {
  let current = null;
  const seen = new Map();
  function handle(raw, now = Date.now()) {
    if (raw.length > 32768) return null;
    let parsed;
    try { parsed = envelope.safeParse(JSON.parse(raw.toString())); } catch { return null; }
    if (!parsed.success) return null;
    const input = parsed.data;
    if (input.command === 'MISSION_START' ? !('type' in input.payload) : Object.keys(input.payload).length !== 0) return null;
    const issued = Date.parse(input.issuedAt), expires = Date.parse(input.expiresAt);
    if (issued > now + 30000 || expires <= now || expires <= issued || expires - issued > 30000) return null;
    for (const [id, entry] of seen) if (entry.expires <= now) seen.delete(id);
    const previous = seen.get(input.commandId);
    if (previous) return previous.signature === JSON.stringify(input) ? previous.ack : null;
    let accepted = false;
    if (input.command === 'MISSION_START' && current === null) { current = { missionId: input.missionId, status: 'active' }; accepted = true; }
    else if (current?.missionId === input.missionId) {
      if (input.command === 'MISSION_PAUSE' && current.status === 'active') { current.status = 'paused'; accepted = true; }
      else if (input.command === 'MISSION_RESUME' && current.status === 'paused') { current.status = 'active'; accepted = true; }
      else if (['MISSION_COMPLETE', 'MISSION_CANCEL'].includes(input.command)) { current = null; accepted = true; }
    }
    const ack = { schemaVersion: 1, commandId: input.commandId, correlationId: input.correlationId, missionId: input.missionId,
      deviceId, timestamp: new Date(now).toISOString(), status: accepted ? 'acknowledged' : 'rejected' };
    seen.set(input.commandId, { signature: JSON.stringify(input), ack, expires });
    return ack;
  }
  return { handle, state: () => current ? { ...current } : null };
}
module.exports = { createSimulatorCommands };
