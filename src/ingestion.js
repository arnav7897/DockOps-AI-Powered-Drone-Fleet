const { z } = require('zod');

const statusMessage = z.object({
  schemaVersion: z.literal(1),
  messageId: z.string().min(1).max(128),
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  sessionId: z.uuid().optional(),
  timestamp: z.iso.datetime({ offset: true }),
  type: z.literal('STATUS_UPDATE'),
  payload: z.object({
    connectivity: z.enum(['online', 'offline']),
    operationalState: z.enum(['idle', 'busy', 'unknown']),
  }).strict(),
}).strict();

async function ingestStatus(topic, raw, store, now = Date.now(), retained = false) {
  const match = /^devices\/([a-zA-Z0-9_-]{1,64})\/status$/.exec(topic);
  if (!match || retained || raw.length > 16384) return false;
  let input;
  try { input = JSON.parse(raw.toString()); } catch { return false; }
  const result = statusMessage.safeParse(input);
  if (!result.success || result.data.deviceId !== match[1]) return false;
  const time = Date.parse(result.data.timestamp);
  if (time > now + 30000 || time < now - 300000) return false;
  return store.recordStatus(result.data);
}

const disconnectMessage = z.object({ schemaVersion: z.literal(1), messageId: z.uuid(), deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), sessionId: z.uuid(), type: z.literal('DEVICE_DISCONNECTED') }).strict();

async function ingestDisconnect(topic, raw, store, retained = false) {
  const match = /^devices\/([a-zA-Z0-9_-]{1,64})\/events$/.exec(topic);
  if (!match || retained || raw.length > 16384) return false;
  let parsed;
  try { parsed = disconnectMessage.safeParse(JSON.parse(raw.toString())); } catch { return false; }
  if (!parsed.success || parsed.data.deviceId !== match[1]) return false;
  return store.recordDisconnect(parsed.data);
}

module.exports = { ingestStatus, ingestDisconnect };
