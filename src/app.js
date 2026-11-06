const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { missionInput } = require('./missions');

const deviceInput = z.object({
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).refine((id) => id !== 'backend'),
  name: z.string().trim().min(1).max(100),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(50),
}).strict();

function createApp({ devices, missions, jwtSecret }) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api/v1', (req, res, next) => {
    const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
    try {
      if (!match) throw new Error('missing token');
      const claims = jwt.verify(match[1], jwtSecret, { algorithms: ['HS256'], issuer: 'droneops', audience: 'droneops-api' });
      if (typeof claims.sub !== 'string' || !claims.sub || !['operator', 'admin'].includes(claims.role) || typeof claims.exp !== 'number') throw new Error('invalid claims');
      req.user = claims;
      next();
    } catch {
      res.status(401).json({ error: 'Unauthorized' });
    }
  });
  app.post('/api/v1/devices', async (req, res, next) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const parsed = deviceInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid device' });
    try {
      const device = await devices.create(parsed.data);
      return res.status(201).json(device);
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'Device already exists' });
      return next(err);
    }
  });
  app.get('/api/v1/devices', async (_req, res, next) => {
    try { res.json(await devices.list()); } catch (err) { next(err); }
  });
  app.get('/api/v1/devices/:id/events', async (req, res, next) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid device ID' });
    try { res.json(await devices.events(req.params.id)); } catch (err) { next(err); }
  });
  app.post('/api/v1/missions', async (req, res, next) => {
    const parsed = missionInput.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid mission' });
    try { return res.status(201).json(await missions.create(parsed.data, req.user)); } catch (err) { return next(err); }
  });
  app.get('/api/v1/missions/:id', async (req, res, next) => {
    try {
      const mission = await missions.get(req.params.id);
      return mission ? res.json(mission) : res.status(404).json({ error: 'Mission not found' });
    } catch (err) { return next(err); }
  });
  app.post('/api/v1/missions/:id/assign', async (req, res, next) => {
    const input = z.object({ deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/) }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid device ID' });
    try {
      const mission = await missions.assign(req.params.id, input.data.deviceId);
      if (mission) return res.json(mission);
      return res.status(await missions.get(req.params.id) ? 409 : 404).json({ error: 'Mission cannot be assigned' });
    } catch (err) { return next(err); }
  });
  app.post('/api/v1/missions/:id/cancel', async (req, res, next) => {
    try {
      const mission = await missions.cancel(req.params.id);
      if (mission) return res.json(mission);
      return res.status(await missions.get(req.params.id) ? 409 : 404).json({ error: 'Mission cannot be cancelled' });
    } catch (err) { return next(err); }
  });
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

module.exports = { createApp };
