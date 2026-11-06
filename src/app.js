const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');

const deviceInput = z.object({
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  name: z.string().trim().min(1).max(100),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(50),
}).strict();

function createApp({ devices, jwtSecret }) {
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
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    console.error(err);
    return res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}

module.exports = { createApp };
