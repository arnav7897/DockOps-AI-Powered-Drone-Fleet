const { z } = require('zod');

const envelope = z.object({
  schemaVersion: z.literal(1), commandId: z.uuid(), correlationId: z.uuid(), missionId: z.uuid(),
  command: z.enum(['MISSION_START', 'MISSION_PAUSE', 'MISSION_RESUME', 'MISSION_COMPLETE', 'MISSION_CANCEL']),
  issuedAt: z.iso.datetime({ offset: true }), expiresAt: z.iso.datetime({ offset: true }),
  payload: z.union([z.object({}).strict(), z.object({ type: z.string().min(1).max(100), parameters: z.record(z.string().max(100), z.unknown()) }).strict()]),
}).strict();
const savedState = z.object({ version: z.literal(1), deviceId: z.string(),
  current: z.object({ missionId: z.uuid(), status: z.enum(['active', 'paused']) }).strict().nullable(),
  entries: z.array(z.object({ signature: z.string().max(32768), expires: z.number(), ack: z.object({
    schemaVersion: z.literal(1), commandId: z.uuid(), correlationId: z.uuid(), missionId: z.uuid(), deviceId: z.string(),
    timestamp: z.iso.datetime({ offset: true }), status: z.enum(['acknowledged', 'rejected']),
  }).strict() }).strict()).max(1000),
}).strict();

function createSimulatorCommands(deviceId, { initialState, saveState } = {}) {
  let current = null;
  const seen = new Map();
  if (initialState !== undefined) {
    const saved = savedState.parse(initialState);
    if (saved.deviceId !== deviceId) throw new Error('Simulator state belongs to another device');
    current = saved.current;
    for (const entry of saved.entries) {
      const input = envelope.parse(JSON.parse(entry.signature));
      if (entry.ack.deviceId !== deviceId || input.commandId !== entry.ack.commandId || input.correlationId !== entry.ack.correlationId || input.missionId !== entry.ack.missionId || Date.parse(input.expiresAt) !== entry.expires || seen.has(input.commandId)) throw new Error('Invalid simulator command state');
      seen.set(input.commandId, entry);
    }
  }
  function handle(raw, now = Date.now()) {
    if (raw.length > 32768) return null;
    let parsed;
    try { parsed = envelope.safeParse(JSON.parse(raw.toString())); } catch { return null; }
    if (!parsed.success) return null;
    const input = parsed.data;
    if (input.command === 'MISSION_START' ? !('type' in input.payload) : Object.keys(input.payload).length !== 0) return null;
    const issued = Date.parse(input.issuedAt), expires = Date.parse(input.expiresAt);
    if (issued > now + 30000 || expires <= now || expires <= issued || expires - issued > 30000) return null;
    if (!saveState) for (const [id, entry] of seen) if (entry.expires <= now) seen.delete(id);
    const previous = seen.get(input.commandId);
    if (previous) return previous.signature === JSON.stringify(input) ? previous.ack : null;
    // shortcut: retain at most 1000 acknowledgements, add a backend receipt protocol before pruning.
    if (seen.size >= 1000) return null;
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
    if (saveState) saveState({ version: 1, deviceId, current, entries: [...seen.values()] });
    return ack;
  }
  return { handle, state: () => current ? { ...current } : null, acknowledgements: () => [...seen.values()].map((entry) => entry.ack) };
}
module.exports = { createSimulatorCommands };
