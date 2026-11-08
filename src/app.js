const express = require('express');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { missionInput } = require('./missions');
const { eventFilters } = require('./history');
const { ProposalError } = require('./proposals');

const deviceInput = z.object({
  deviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).refine((id) => id !== 'backend'),
  name: z.string().trim().min(1).max(100),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(50),
}).strict();

function createApp({ devices, missions, commands, history, assistant, proposals, jwtSecret }) {
  const app = express();
  const aiRequestWindows = new Map();
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
  app.post('/api/v1/ai/chat', async (req, res) => {
    if (!assistant) return res.status(503).json({ error: 'AI assistant is not configured' });
    const input = z.object({ message: z.string().trim().min(1).max(2000) }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid chat request' });
    const now = Date.now();
    for (const [subject, window] of aiRequestWindows) if (window.expiresAt <= now) aiRequestWindows.delete(subject);
    const currentWindow = aiRequestWindows.get(req.user.sub);
    if (!currentWindow && aiRequestWindows.size >= 10000) return res.status(429).json({ error: 'AI request limit reached; retry later' });
    const window = currentWindow || { count: 0, expiresAt: now + 60000 };
    if (window.count >= 10) return res.set('Retry-After', '60').status(429).json({ error: 'AI request limit reached; retry later' });
    window.count++;
    aiRequestWindows.set(req.user.sub, window);
    try {
      return res.json(await assistant.ask(input.data.message, req.user));
    } catch {
      return res.status(502).json({ error: 'AI assistant is temporarily unavailable' });
    }
  });
  app.get('/api/v1/ai/proposals/:id', async (req, res) => {
    if (!proposals) return res.status(503).json({ error: 'AI proposals are not configured' });
    if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid proposal ID' });
    const proposal = await proposals.get(req.params.id, req.user);
    return proposal ? res.json(proposal) : res.status(404).json({ error: 'Proposal not found' });
  });
  app.post('/api/v1/ai/proposals/:id/dispatch', async (req, res) => {
    if (!proposals) return res.status(503).json({ error: 'AI proposals are not configured' });
    if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid proposal ID' });
    const input = z.object({ approvalId: z.uuid() }).strict().safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'Invalid dispatch request' });
    try {
      const result = await proposals.dispatch(req.params.id, input.data.approvalId, req.user);
      return res.status(result.status === 'dispatched' ? 202 : 200).json(result);
    } catch (err) { return proposalError(err, res); }
  });
  app.post('/api/v1/ai/proposals/:id/:decision', async (req, res) => {
    if (!proposals) return res.status(503).json({ error: 'AI proposals are not configured' });
    if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid proposal ID' });
    if (!['approve', 'reject'].includes(req.params.decision)) return res.status(404).json({ error: 'Not found' });
    if (!z.object({}).strict().safeParse(req.body).success) return res.status(400).json({ error: 'Invalid approval request' });
    try {
      const result = await proposals[req.params.decision](req.params.id, req.user);
      return res.json(result);
    } catch (err) { return proposalError(err, res); }
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
  app.get('/api/v1/devices/:id/replay', async (req, res, next) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid device ID' });
    try {
      const result = await history.replay(req.params.id);
      if (!result) return res.status(404).json({ error: 'Device not found' });
      if (result.tooMany) return res.status(409).json({ error: 'Replay exceeds 1000 events' });
      return res.json(result);
    } catch (err) { return next(err); }
  });
  app.get('/api/v1/events', async (req, res, next) => {
    const parsed = eventFilters.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid event filters' });
    try { return res.json(await history.events(parsed.data)); } catch (err) { return next(err); }
  });
  app.get('/api/v1/alerts', async (_req, res, next) => {
    try { return res.json(await history.alerts()); } catch (err) { return next(err); }
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
  app.get('/api/v1/missions/:id/replay', async (req, res, next) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid mission ID' });
    try {
      const result = await history.replayMission(req.params.id);
      if (!result) return res.status(404).json({ error: 'Mission not found' });
      if (result.tooMany) return res.status(409).json({ error: 'Replay exceeds 1000 events' });
      return res.json(result);
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
      if (commands) {
        const command = await commands.dispatch(req.params.id, 'cancel', req.user);
        if (command) return res.status(202).json(command);
      }
      return res.status(await missions.get(req.params.id) ? 409 : 404).json({ error: 'Mission cannot be cancelled' });
    } catch (err) { return next(err); }
  });
  app.post('/api/v1/missions/:id/:action', async (req, res, next) => {
    if (!['start', 'pause', 'resume', 'complete'].includes(req.params.action)) return res.status(404).json({ error: 'Not found' });
    try {
      const command = commands && await commands.dispatch(req.params.id, req.params.action, req.user);
      if (command) return res.status(202).json(command);
      return res.status(await missions.get(req.params.id) ? 409 : 404).json({ error: 'Mission action unavailable' });
    } catch (err) { return next(err); }
  });
  app.get('/api/v1/commands/:id', async (req, res, next) => {
    try {
      const command = commands && await commands.get(req.params.id);
      return command ? res.json(command) : res.status(404).json({ error: 'Command not found' });
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

function proposalError(err, res) {
  if (!(err instanceof ProposalError)) return res.status(500).json({ error: 'Internal server error' });
  const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'FORBIDDEN' ? 403 : err.code === 'INVALID' ? 400 : ['EXPIRED', 'CONFLICT', 'POLICY_CHANGED'].includes(err.code) ? 409 : 500;
  return res.status(status).json({ error: err.code === 'NOT_FOUND' ? 'Proposal not found' : err.code === 'EXPIRED' ? 'Proposal or approval expired' : err.code === 'POLICY_CHANGED' ? 'Risk policy changed; create a new proposal' : err.code === 'FORBIDDEN' ? 'Forbidden' : err.code === 'INVALID' ? 'Invalid proposal' : 'Proposal state conflict' });
}

module.exports = { createApp };
