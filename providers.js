// providers.js — routes a task to the selected LLM provider.
// All providers are called server-side. API keys come ONLY from environment
// variables and are never sent to the browser.
//
// Anthropic uses its native Messages API (x-api-key header, distinct format).
// OpenAI, Gemini (via its OpenAI-compatible endpoint), DeepSeek and Meta all
// speak the OpenAI chat-completions shape, so they share one code path.
const PROVIDERS = {
  anthropic: {
    name: 'Anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: 'claude-sonnet-4-20250514',
    kind: 'anthropic',
  },
  openai: {
    name: 'OpenAI',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    defaultModel: 'gpt-4o-mini',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
  },
  gemini: {
    name: 'Google Gemini',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'GEMINI_MODEL',
    defaultModel: 'gemini-2.0-flash',
    kind: 'openai-compatible',
    // Google's OpenAI-compatible endpoint (key sent as Bearer token).
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  deepseek: {
    name: 'DeepSeek',
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'DEEPSEEK_MODEL',
    defaultModel: 'deepseek-chat',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
  },
  meta: {
    name: 'Meta',
    keyEnv: 'META_MODEL_API_KEY',
    modelEnv: 'META_MODEL',
    defaultModel: 'muse-spark-1.3',
    kind: 'openai-compatible',
    baseUrl: 'https://api.meta.ai/v1',
  },
};

function getProvider(id) {
  return PROVIDERS[id] || null;
}

function providerIds() {
  return Object.keys(PROVIDERS);
}

// Public provider info for the UI: never includes keys, only whether one exists.
function publicProviders() {
  return providerIds().map((id) => ({
    id,
    name: PROVIDERS[id].name,
    model: process.env[PROVIDERS[id].modelEnv] || PROVIDERS[id].defaultModel,
    hasKey: Boolean(process.env[PROVIDERS[id].keyEnv]),
  }));
}

async function callAnthropic({ key, model, system, history, message }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system,
      messages: [
        ...history.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
        { role: 'user', content: message },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw providerHttpError('Anthropic', res.status, text);
  }
  const data = await res.json();
  const answer = (data.content || [])
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { answer, model: data.model || model };
}

async function callOpenAICompatible({ def, key, model, system, history, message }) {
  const res = await fetch(def.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + key,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: system },
        ...history.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
        { role: 'user', content: message },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw providerHttpError(def.name, res.status, text);
  }
  const data = await res.json();
  const answer = (data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content : '').trim();
  return { answer, model: (data.model || model) };
}

function providerHttpError(name, status, bodyText) {
  const err = new Error(`${name} API returned HTTP ${status}`);
  err.code = 'PROVIDER_HTTP_ERROR';
  err.status = status;
  // Keep the provider's message short — it may contain request ids, never keys.
  err.detail = String(bodyText || '').slice(0, 500);
  return err;
}

/**
 * Run one task through the selected provider.
 * Returns { answer, actualProvider, model, routingMode }.
 * Throws an Error with .code === 'NO_KEY' when the provider has no API key —
 * the route turns this into an honest JSON error, never a faked answer.
 */
async function completeTask({ providerId, system, history, message }) {
  const def = getProvider(providerId);
  if (!def) {
    const err = new Error(`Unknown provider: ${providerId}`);
    err.code = 'UNKNOWN_PROVIDER';
    throw err;
  }
  const key = process.env[def.keyEnv];
  if (!key) {
    const err = new Error(
      `No API key configured for ${def.name}. Set ${def.keyEnv} in your .env file and restart the server.`
    );
    err.code = 'NO_KEY';
    err.provider = def.name;
    throw err;
  }
  const model = process.env[def.modelEnv] || def.defaultModel;
  const result = def.kind === 'anthropic'
    ? await callAnthropic({ key, model, system, history, message })
    : await callOpenAICompatible({ def, key, model, system, history, message });
  if (!result.answer) {
    const err = new Error(`${def.name} returned an empty response.`);
    err.code = 'EMPTY_RESPONSE';
    throw err;
  }
  return {
    answer: result.answer,
    actualProvider: def.name,
    model: result.model,
    routingMode: 'direct',
  };
}

module.exports = { PROVIDERS, getProvider, providerIds, publicProviders, completeTask };
