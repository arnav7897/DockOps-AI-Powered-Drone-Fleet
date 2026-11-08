const { z } = require('zod');

const providerResponse = z.object({
  choices: z.array(z.object({ message: z.object({
    role: z.literal('assistant'),
    content: z.string().max(5000).nullable().optional(),
    tool_calls: z.array(z.object({
      id: z.string().min(1).max(128),
      type: z.literal('function'),
      function: z.object({ name: z.string().min(1).max(80), arguments: z.string().max(8192) }).strict(),
    }).strict()).max(4).optional(),
  }).passthrough() }).passthrough()).min(1),
}).passthrough();

function createModelClient({ baseUrl, apiKey, model, fetchImpl = fetch, timeoutMs = 15000 }) {
  const configuredUrl = new URL(baseUrl);
  const endpoint = new URL(`${baseUrl.replace(/\/+$/, '')}/chat/completions`);
  if (configuredUrl.username || configuredUrl.password || configuredUrl.hash || configuredUrl.search || endpoint.username || endpoint.password || (endpoint.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) {
    throw new Error('AI endpoint must use HTTPS and contain no embedded credentials');
  }

  return async function complete(messages, tools) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, tools: tools.map(({ name, description, inputSchema }) => ({ type: 'function', function: { name, description, parameters: inputSchema } })), tool_choice: 'auto', max_tokens: 700, temperature: 0 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('AI provider unavailable');
    }
    if (!response.ok) throw new Error('AI provider returned an error');
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > 1024 * 1024) throw new Error('AI provider response too large');
    let raw;
    try {
      if (!response.body) raw = await response.text();
      else {
        const reader = response.body.getReader();
        const chunks = [];
        let bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1024 * 1024) {
            await reader.cancel();
            throw new Error('too large');
          }
          chunks.push(Buffer.from(value));
        }
        raw = Buffer.concat(chunks).toString('utf8');
      }
      if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('too large');
      return providerResponse.parse(JSON.parse(raw));
    } catch {
      throw new Error('AI provider returned an invalid response');
    }
  };
}

function createConfiguredModel(env = process.env, fetchImpl) {
  const { AI_API_BASE_URL, AI_API_KEY, AI_MODEL } = env;
  if (![AI_API_BASE_URL, AI_API_KEY, AI_MODEL].some(Boolean)) return null;
  if (![AI_API_BASE_URL, AI_API_KEY, AI_MODEL].every((value) => typeof value === 'string' && value.trim())) {
    throw new Error('Set AI_API_BASE_URL, AI_API_KEY and AI_MODEL together');
  }
  if (AI_API_BASE_URL.length > 2048 || AI_API_KEY.length > 4096 || AI_MODEL.length > 100) throw new Error('Invalid AI provider configuration');
  return createModelClient({ baseUrl: AI_API_BASE_URL.trim(), apiKey: AI_API_KEY.trim(), model: AI_MODEL.trim(), ...(fetchImpl ? { fetchImpl } : {}) });
}

module.exports = { createModelClient, createConfiguredModel };
