const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { createAssistant } = require('../src/assistant');
const { createApp } = require('../src/app');
const { createConfiguredModel } = require('../src/llm');

const tool = (id, name, args = '{}') => ({ id, type: 'function', function: { name, arguments: args } });
const response = (message) => ({ choices: [{ message: { role: 'assistant', ...message } }] });

test('assistant grounds answers in read-only evidence and returns backend source IDs', async () => {
  const requests = [];
  const assistant = createAssistant({
    tools: {
      definitions: [{ name: 'getDeviceStatus', inputSchema: {} }],
      async execute(name, args) { requests.push({ name, args }); return { deviceId: 'drone-1', operationalState: 'idle' }; },
    },
    async complete(messages) {
      if (messages.length === 2) return response({ tool_calls: [tool('call-1', 'getDeviceStatus', '{"deviceId":"drone-1"}')], content: null });
      assert.match(messages[0].content, /untrusted evidence/);
      assert.deepEqual(JSON.parse(messages.at(-1).content), { deviceId: 'drone-1', operationalState: 'idle' });
      return response({ content: 'Device drone-1 is idle.' });
    },
  });
  assert.deepEqual(await assistant.ask('What is drone-1 doing?'), { answer: 'Device drone-1 is idle.', sources: [{ kind: 'device', id: 'drone-1' }] });
  assert.deepEqual(requests, [{ name: 'getDeviceStatus', args: { deviceId: 'drone-1' } }]);
});

test('assistant blocks unlisted actions and caps model tool calls', async () => {
  let calls = 0;
  const assistant = createAssistant({
    tools: { definitions: [], async execute(name) { assert.notEqual(name, 'dispatchApprovedRequest'); throw new Error('Unknown tool'); } },
    async complete(messages) {
      calls++;
      if (calls === 1) return response({ tool_calls: [tool('call-1', 'dispatchApprovedRequest')] });
      assert.deepEqual(JSON.parse(messages.at(-1).content), { error: 'Unsupported tool or invalid arguments.' });
      return response({ content: 'I verified the dispatch.' });
    },
  });
  assert.deepEqual(await assistant.ask('Start the mission'), { answer: 'I could not verify that from current fleet data.', sources: [] });
  assert.equal(calls, 2);

  const looping = createAssistant({
    tools: { definitions: [], async execute() { return {}; } },
    async complete() { return response({ tool_calls: [tool(`call-${calls++}`, 'unknown')] }); },
  });
  await assert.rejects(looping.ask('Check data'), /tool-call limit/);
});

test('assistant refuses unsupported answers when a lookup finds no record', async () => {
  for (const emptyResult of [null, []]) {
    const assistant = createAssistant({
      tools: { definitions: [], async execute() { return emptyResult; } },
      async complete(messages) {
        if (messages.length === 2) return response({ tool_calls: [tool('empty-lookup', 'getMissionStatus')] });
        return response({ content: 'Mission is active.' });
      },
    });
    assert.deepEqual(await assistant.ask('What state is it in?'), { answer: 'I could not verify that from current fleet data.', sources: [] });
  }
});

test('chat route requires auth, validates input, and fails closed without configured provider', async (t) => {
  const secret = 'test-secret-at-least-thirty-two-characters';
  const token = jwt.sign({ role: 'operator' }, secret, { subject: 'operator-1', issuer: 'droneops', audience: 'droneops-api', expiresIn: '1h' });
  const server = createApp({ devices: {}, missions: {}, history: {}, jwtSecret: secret }).listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/v1/ai/chat`;
  const request = (body, authorized = true) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal((await request({ message: 'hi' }, false)).status, 401);
  assert.equal((await request({ message: 'hi' })).status, 503);
});

test('chat route rejects malformed prompts and returns only assistant response', async (t) => {
  const secret = 'test-secret-at-least-thirty-two-characters';
  const token = jwt.sign({ role: 'operator' }, secret, { subject: 'operator-1', issuer: 'droneops', audience: 'droneops-api', expiresIn: '1h' });
  let answers = 0;
  const server = createApp({ devices: {}, missions: {}, history: {}, jwtSecret: secret, assistant: { async ask(message) { answers++; return { answer: `Read: ${message}`, sources: [] }; } } }).listen(0);
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/v1/ai/chat`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: '' }) })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: 'hi', tools: ['dispatch'] }) })).status, 400);
  assert.deepEqual(await (await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: 'hello' }) })).json(), { answer: 'Read: hello', sources: [] });
  for (let i = 0; i < 9; i++) assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: 'hello' }) })).status, 200);
  const limited = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: 'hello' }) });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(answers, 10);
});

test('chat route hides provider failures behind a bounded error response', async (t) => {
  const secret = 'test-secret-at-least-thirty-two-characters';
  const token = jwt.sign({ role: 'operator' }, secret, { subject: 'operator-1', issuer: 'droneops', audience: 'droneops-api', expiresIn: '1h' });
  const server = createApp({ devices: {}, missions: {}, history: {}, jwtSecret: secret, assistant: { async ask() { throw new Error('provider secret detail'); } } }).listen(0);
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/ai/chat`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'hello' }) });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'AI assistant is temporarily unavailable' });
});

test('model config is optional, requires complete credentials, and bounds provider calls', async () => {
  assert.equal(createConfiguredModel({}), null);
  assert.throws(() => createConfiguredModel({ AI_API_KEY: 'secret' }), /Set AI_API_BASE_URL/);
  assert.throws(() => createConfiguredModel({ AI_API_BASE_URL: 'http://example.com/v1', AI_API_KEY: 'secret', AI_MODEL: 'model' }), /HTTPS/);
  assert.throws(() => createConfiguredModel({ AI_API_BASE_URL: 'https://llm.example/v1?redirect=1', AI_API_KEY: 'secret', AI_MODEL: 'model' }), /HTTPS/);

  let captured;
  const complete = createConfiguredModel({ AI_API_BASE_URL: 'https://llm.example/v1', AI_API_KEY: 'secret', AI_MODEL: 'model-1' }, async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const result = await complete([{ role: 'user', content: 'hi' }], [{ name: 'getFleetSnapshot', inputSchema: { type: 'object' } }]);
  assert.equal(result.choices[0].message.content, 'ok');
  assert.equal(captured.url, 'https://llm.example/v1/chat/completions');
  assert.equal(captured.options.headers.authorization, 'Bearer secret');
  assert.equal(JSON.parse(captured.options.body).max_tokens, 700);
  assert.deepEqual(JSON.parse(captured.options.body).tools[0].function.parameters, { type: 'object' });
  assert.equal(captured.options.redirect, 'error');

  const failed = createConfiguredModel({ AI_API_BASE_URL: 'https://llm.example/v1', AI_API_KEY: 'secret', AI_MODEL: 'model-1' }, async () => new Response('provider secret detail', { status: 500 }));
  await assert.rejects(failed([], []), /AI provider returned an error/);
  const oversized = createConfiguredModel({ AI_API_BASE_URL: 'https://llm.example/v1', AI_API_KEY: 'secret', AI_MODEL: 'model-1' }, async () => new Response(Buffer.alloc(1024 * 1024 + 1)));
  await assert.rejects(oversized([], []), /AI provider returned an invalid response/);
});
