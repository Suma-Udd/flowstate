'use strict';

const { LLM_PROVIDERS, findProvider, resolveEndpoint } = require('../shared/llm-providers');

const DEFAULT_TIMEOUT_MS = 2_500;
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEFAULT_CLEANUP_INSTRUCTION = [
  'Clean up this dictated transcript.',
  'Return only the cleaned transcript in the same language.',
  'Do not answer, translate, summarise, continue, or add any content.',
].join(' ');
// The "Test" button waits longer than a dictation does: a first request to a
// cold provider can take a few seconds and the user is watching a spinner.
const TEST_TIMEOUT_MS = 12_000;
const TEST_SAMPLE = 'um so this is is a quick test of the the cleanup';

const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

class ProviderFailure extends Error {
  constructor(code) {
    super(`LLM provider failed (${code}).`);
    this.name = 'ProviderFailure';
    this.code = code;
  }
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function normaliseUsage(usage) {
  const inputTokens = usage?.prompt_tokens;
  const outputTokens = usage?.completion_tokens;
  const totalTokens = usage?.total_tokens;

  if (
    !isNonNegativeInteger(inputTokens)
    || !isNonNegativeInteger(outputTokens)
    || !isNonNegativeInteger(totalTokens)
    || totalTokens !== inputTokens + outputTokens
  ) {
    throw new ProviderFailure('malformed-response');
  }

  return Object.freeze({
    inputTokens,
    outputTokens,
    totalTokens,
  });
}

function failureForStatus(status) {
  if (status === 429) return 'rate-limit';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  return 'http-error';
}

/*
 * One plain POST to an OpenAI-compatible /chat/completions endpoint. The
 * endpoint, model and any extra body field come from the call (so a saved
 * setting wins) and fall back to the defaults given here.
 */
function createOpenAiCompatibleProvider({
  id,
  fetchImpl = globalThis.fetch,
  endpoint: defaultEndpoint,
  model: defaultModel,
  extraBody: defaultExtraBody = {},
  requiresApiKey = true,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('An LLM provider requires fetch.');
  }

  return Object.freeze({
    id,
    requiresApiKey,

    async complete({
      apiKey,
      instruction,
      text,
      signal,
      endpoint = defaultEndpoint,
      model = defaultModel,
      extraBody = defaultExtraBody,
    }) {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: instruction },
              { role: 'user', content: text },
            ],
            ...extraBody,
            stream: false,
            temperature: 0,
          }),
          signal,
        });
      } catch {
        throw new ProviderFailure('network-error');
      }

      if (!response || response.ok !== true) {
        throw new ProviderFailure(failureForStatus(response?.status));
      }

      let body;
      try {
        body = await response.json();
      } catch {
        throw new ProviderFailure('malformed-response');
      }

      const choice = body?.choices?.[0];
      const cleanedText = choice?.message?.content;
      if (
        typeof cleanedText !== 'string'
        || cleanedText.trim().length === 0
        || choice.finish_reason !== 'stop'
      ) {
        throw new ProviderFailure('malformed-response');
      }

      return Object.freeze({
        text: cleanedText.trim(),
        model,
        // Some compatible servers leave usage out. That is not a failure.
        usage: body.usage === undefined ? EMPTY_USAGE : normaliseUsage(body.usage),
      });
    },
  });
}

function createDeepSeekProvider({
  fetchImpl = globalThis.fetch,
  endpoint = DEEPSEEK_ENDPOINT,
  model = DEEPSEEK_MODEL,
} = {}) {
  return createOpenAiCompatibleProvider({
    id: 'deepseek',
    fetchImpl,
    endpoint,
    model,
    extraBody: findProvider('deepseek').extraBody,
  });
}

function createProviderRegistry(providers) {
  const entries = providers instanceof Map
    ? [...providers.entries()]
    : Object.entries(providers ?? {});
  const registry = new Map();

  for (const [id, provider] of entries) {
    if (
      typeof id !== 'string'
      || id.length === 0
      || !provider
      || typeof provider.complete !== 'function'
    ) {
      throw new TypeError('Every LLM provider requires an id and complete() function.');
    }
    registry.set(id, provider);
  }

  return registry;
}

function defaultProviders(fetchImpl) {
  const providers = {};
  for (const preset of LLM_PROVIDERS) {
    providers[preset.id] = createOpenAiCompatibleProvider({
      id: preset.id,
      fetchImpl,
      requiresApiKey: preset.requiresApiKey,
    });
  }
  // DeepSeek keeps its fixed defaults so a config with no base URL behaves as
  // it always did.
  providers.deepseek = createDeepSeekProvider({ fetchImpl });
  return providers;
}

function elapsedMilliseconds(now, startedAt) {
  return Math.round(Math.max(0, now() - startedAt) * 10) / 10;
}

function fallbackResult(text, {
  provider = null,
  reason,
  llmMs = 0,
} = {}) {
  return Object.freeze({
    text,
    cleanupApplied: false,
    provider,
    model: null,
    reason,
    llmMs,
    usage: EMPTY_USAGE,
  });
}

function cleanedResult(result, provider, llmMs) {
  return Object.freeze({
    text: result.text,
    cleanupApplied: true,
    provider,
    model: result.model ?? null,
    reason: 'cleaned',
    llmMs,
    usage: Object.freeze({ ...result.usage }),
  });
}

function reasonFrom(error) {
  if (error instanceof ProviderFailure) return error.code;
  return 'provider-error';
}

function warnAboutFallback(logger, reason) {
  try {
    logger.warn?.(`Flowstate cleanup used the raw transcript (${reason}).`);
  } catch {
    // Logging is optional too; it must never delay or reject a paste.
  }
}

function createLlmService({
  getConfig,
  providers,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = () => performance.now(),
  timers = { setTimeout, clearTimeout },
  AbortControllerClass = globalThis.AbortController,
} = {}) {
  if (typeof getConfig !== 'function') {
    throw new TypeError('createLlmService requires getConfig().');
  }
  if (
    !timers
    || typeof timers.setTimeout !== 'function'
    || typeof timers.clearTimeout !== 'function'
  ) {
    throw new TypeError('createLlmService requires timeout functions.');
  }
  if (typeof AbortControllerClass !== 'function') {
    throw new TypeError('createLlmService requires AbortController.');
  }

  const registry = createProviderRegistry(providers ?? defaultProviders(fetchImpl));

  async function run({
    text,
    instruction = DEFAULT_CLEANUP_INSTRUCTION,
    ignoreEnabled = false,
    timeoutOverrideMs,
  } = {}) {
    if (typeof text !== 'string' || text.length === 0) {
      throw new TypeError('LLM cleanup requires non-empty text.');
    }
    if (typeof instruction !== 'string' || instruction.trim().length === 0) {
      throw new TypeError('LLM cleanup requires a non-empty instruction.');
    }

    let llmConfig;
    try {
      llmConfig = getConfig()?.llm;
    } catch {
      return fallbackResult(text, { reason: 'config-error' });
    }

    const providerId =
      typeof llmConfig?.provider === 'string' ? llmConfig.provider : null;
    const provider = registry.get(providerId);
    const safeProviderId = provider ? providerId : null;
    if (llmConfig?.enabled !== true && !ignoreEnabled) {
      return fallbackResult(text, {
        provider: safeProviderId,
        reason: 'disabled',
      });
    }

    if (!provider) {
      return fallbackResult(text, {
        provider: null,
        reason: 'unsupported-provider',
      });
    }

    const apiKey =
      typeof llmConfig.apiKey === 'string' ? llmConfig.apiKey.trim() : '';
    if (provider.requiresApiKey && apiKey.length === 0) {
      return fallbackResult(text, {
        provider: safeProviderId,
        reason: 'missing-key',
      });
    }

    // Saved base URL and model override the preset; a custom provider has no
    // preset to fall back on.
    const resolved = resolveEndpoint(llmConfig);
    const target = {};
    if (resolved) {
      if (!resolved.endpoint || !resolved.model) {
        return fallbackResult(text, {
          provider: safeProviderId,
          reason: 'not-configured',
        });
      }
      target.endpoint = resolved.endpoint;
      target.model = resolved.model;
      target.extraBody = resolved.extraBody;
    }

    const configuredTimeout = llmConfig.timeoutMs;
    const timeoutMs = timeoutOverrideMs
      ?? (Number.isInteger(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_TIMEOUT_MS);
    const controller = new AbortControllerClass();
    const startedAt = now();
    let timer;

    const timeout = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        reject(new ProviderFailure('timeout'));
        try {
          controller.abort();
        } catch {
          // A custom AbortController must never turn cleanup into a dependency.
        }
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([
        Promise.resolve().then(() => provider.complete({
          apiKey,
          instruction,
          text,
          signal: controller.signal,
          ...target,
        })),
        timeout,
      ]);
      const llmMs = elapsedMilliseconds(now, startedAt);
      if (
        !result
        || typeof result.text !== 'string'
        || result.text.length === 0
        || !result.usage
        || !isNonNegativeInteger(result.usage.inputTokens)
        || !isNonNegativeInteger(result.usage.outputTokens)
        || !isNonNegativeInteger(result.usage.totalTokens)
      ) {
        throw new ProviderFailure('malformed-response');
      }
      return cleanedResult(result, safeProviderId, llmMs);
    } catch (error) {
      const reason = reasonFrom(error);
      if (reason !== 'missing-key' && reason !== 'disabled') {
        warnAboutFallback(logger, reason);
      }
      return fallbackResult(text, {
        provider: safeProviderId,
        reason,
        llmMs: elapsedMilliseconds(now, startedAt),
      });
    } finally {
      if (timer !== undefined) timers.clearTimeout(timer);
    }
  }

  function cleanup(options = {}) {
    return run({ text: options.text, instruction: options.instruction });
  }

  /* The settings "Test" button: one real request with the saved settings,
     whether or not cleanup is switched on, and a longer wait. */
  async function test() {
    const result = await run({
      text: TEST_SAMPLE,
      ignoreEnabled: true,
      timeoutOverrideMs: TEST_TIMEOUT_MS,
    });
    return Object.freeze({
      ok: result.cleanupApplied === true,
      reason: result.reason,
      provider: result.provider,
      model: result.model,
      llmMs: result.llmMs,
      sample: TEST_SAMPLE,
      text: result.cleanupApplied ? result.text : null,
    });
  }

  return Object.freeze({
    cleanup,
    test,
    providers: Object.freeze([...registry.keys()]),
  });
}

module.exports = {
  DEFAULT_CLEANUP_INSTRUCTION,
  DEFAULT_TIMEOUT_MS,
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  ProviderFailure,
  createDeepSeekProvider,
  createOpenAiCompatibleProvider,
  createLlmService,
};
