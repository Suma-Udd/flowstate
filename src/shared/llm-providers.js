'use strict';

/*
 * Cleanup providers. Every one of them speaks the OpenAI chat-completions
 * format, so adding another is a table entry, not new code.
 *
 * `baseUrl` is the API root; the request goes to `${baseUrl}/chat/completions`.
 * `model` is a small, fast model: cleanup is a short edit, not a conversation.
 * `extraBody` carries a provider-specific request field when one is needed.
 * `keyUrl` is the page where a person creates a key.
 */
const LLM_PROVIDERS = Object.freeze([
  Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    extraBody: Object.freeze({ thinking: Object.freeze({ type: 'disabled' }) }),
    requiresApiKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
  }),
  Object.freeze({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    extraBody: Object.freeze({}),
    requiresApiKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
  }),
  Object.freeze({
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.1-8b-instant',
    extraBody: Object.freeze({}),
    requiresApiKey: true,
    keyUrl: 'https://console.groq.com/keys',
  }),
  Object.freeze({
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    extraBody: Object.freeze({}),
    requiresApiKey: true,
    keyUrl: 'https://openrouter.ai/keys',
  }),
  Object.freeze({
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    model: '',
    extraBody: Object.freeze({}),
    // A local server such as Ollama or LM Studio needs no key.
    requiresApiKey: false,
    keyUrl: null,
  }),
]);

function findProvider(id) {
  return LLM_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/**
 * What a request will actually use: the saved base URL and model when there
 * are any, otherwise the provider's defaults. Returns null for an unknown id.
 */
function resolveEndpoint(llmConfig) {
  const provider = findProvider(llmConfig?.provider);
  if (!provider) return null;
  const savedBase = typeof llmConfig.baseUrl === 'string' ? llmConfig.baseUrl.trim() : '';
  const savedModel = typeof llmConfig.model === 'string' ? llmConfig.model.trim() : '';
  const baseUrl = (savedBase || provider.baseUrl).replace(/\/+$/, '');
  const model = savedModel || provider.model;
  return Object.freeze({
    provider,
    baseUrl,
    model,
    endpoint: baseUrl ? `${baseUrl}/chat/completions` : '',
    extraBody: provider.extraBody,
  });
}

module.exports = { LLM_PROVIDERS, findProvider, resolveEndpoint };
