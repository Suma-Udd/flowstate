'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_CLEANUP_INSTRUCTION,
  DEEPSEEK_ENDPOINT,
  DEEPSEEK_MODEL,
  createLlmService,
} = require('../src/main/llm');

function config(overrides = {}) {
  return {
    llm: {
      provider: 'deepseek',
      apiKey: 'TEST_KEY_VALUE',
      enabled: true,
      timeoutMs: 2_500,
      ...overrides,
    },
  };
}

function response(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

function successfulBody(text = 'Hello, world.') {
  return {
    choices: [{
      finish_reason: 'stop',
      message: { role: 'assistant', content: text },
    }],
    usage: {
      prompt_tokens: 17,
      completion_tokens: 4,
      total_tokens: 21,
    },
  };
}

function timerHarness() {
  let nextId = 1;
  const pending = new Map();

  return {
    timers: {
      setTimeout(callback, delay) {
        const id = nextId++;
        pending.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    fire(delay) {
      const entry = [...pending].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `No ${delay}ms timeout is pending.`);
      pending.delete(entry[0]);
      entry[1].callback();
    },
    count: () => pending.size,
  };
}

test('DeepSeek is one plain POST behind the provider-neutral cleanup interface', async () => {
  const calls = [];
  let clock = 100;
  const service = createLlmService({
    getConfig: () => config(),
    now: () => clock,
    fetchImpl: async (...args) => {
      calls.push(args);
      clock = 164.2;
      return response(successfulBody());
    },
  });

  const result = await service.cleanup({ text: 'hello world' });

  assert.equal(calls.length, 1, 'cleanup retried inside the dictation path');
  const [url, options] = calls[0];
  assert.equal(url, DEEPSEEK_ENDPOINT);
  assert.equal(options.method, 'POST');
  assert.equal(options.headers.Authorization, 'Bearer TEST_KEY_VALUE');
  assert.ok(options.signal instanceof AbortSignal);

  const request = JSON.parse(options.body);
  assert.deepEqual(request, {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: DEFAULT_CLEANUP_INSTRUCTION },
      { role: 'user', content: 'hello world' },
    ],
    thinking: { type: 'disabled' },
    stream: false,
    temperature: 0,
  });
  assert.deepEqual(result, {
    text: 'Hello, world.',
    cleanupApplied: true,
    provider: 'deepseek',
    model: DEEPSEEK_MODEL,
    reason: 'cleaned',
    llmMs: 64.2,
    usage: {
      inputTokens: 17,
      outputTokens: 4,
      totalTokens: 21,
    },
  });
});

test('the hard timeout aborts the request and returns raw text even if fetch never settles', async () => {
  const h = timerHarness();
  let clock = 0;
  let aborted = false;
  const service = createLlmService({
    getConfig: () => config(),
    now: () => clock,
    timers: h.timers,
    logger: { warn() {} },
    fetchImpl: (_url, { signal }) => {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise(() => {});
    },
  });

  const cleanup = service.cleanup({ text: 'raw transcript' });
  await Promise.resolve();
  clock = 2_500;
  h.fire(2_500);
  const result = await cleanup;

  assert.equal(aborted, true);
  assert.equal(h.count(), 0);
  assert.equal(result.text, 'raw transcript');
  assert.equal(result.cleanupApplied, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.llmMs, 2_500);
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
});

test('missing key, network, rate-limit, and malformed responses all fall back without retry', async (t) => {
  const cases = [
    {
      name: 'missing key',
      config: config({ apiKey: '' }),
      expectedReason: 'missing-key',
      fetchImpl: async () => {
        throw new Error('fetch must not run without a key');
      },
      expectedCalls: 0,
    },
    {
      name: 'network',
      config: config(),
      expectedReason: 'network-error',
      fetchImpl: async () => {
        throw new Error('offline');
      },
      expectedCalls: 1,
    },
    {
      name: 'rate limit',
      config: config(),
      expectedReason: 'rate-limit',
      fetchImpl: async () => response(null, { ok: false, status: 429 }),
      expectedCalls: 1,
    },
    {
      name: 'malformed JSON',
      config: config(),
      expectedReason: 'malformed-response',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        async json() {
          throw new SyntaxError('not JSON');
        },
      }),
      expectedCalls: 1,
    },
    {
      name: 'malformed completion',
      config: config(),
      expectedReason: 'malformed-response',
      fetchImpl: async () => response({ choices: [], usage: {} }),
      expectedCalls: 1,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      let calls = 0;
      const service = createLlmService({
        getConfig: () => scenario.config,
        logger: { warn() {} },
        fetchImpl: async (...args) => {
          calls += 1;
          return scenario.fetchImpl(...args);
        },
      });

      const result = await service.cleanup({ text: 'keep me verbatim' });

      assert.equal(calls, scenario.expectedCalls);
      assert.equal(result.text, 'keep me verbatim');
      assert.equal(result.cleanupApplied, false);
      assert.equal(result.reason, scenario.expectedReason);
      assert.equal(result.usage.totalTokens, 0);
    });
  }
});

test('an API key embedded in a provider error never reaches logs or the result', async () => {
  const apiKey = 'DO_NOT_EXPOSE_THIS_TEST_KEY';
  const lines = [];
  const logger = {
    log: (...args) => lines.push(args),
    warn: (...args) => lines.push(args),
    error: (...args) => lines.push(args),
  };
  const service = createLlmService({
    getConfig: () => config({ apiKey }),
    logger,
    fetchImpl: async () => {
      throw new Error(`request failed while using ${apiKey}`);
    },
  });

  const result = await service.cleanup({ text: 'raw text survives' });
  const logged = JSON.stringify(lines);

  assert.equal(result.text, 'raw text survives');
  assert.equal(result.reason, 'network-error');
  assert.doesNotMatch(logged, new RegExp(apiKey));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(apiKey));
});

test('the configured provider selects any adapter implementing the interface', async () => {
  const calls = [];
  const service = createLlmService({
    getConfig: () => config({
      provider: 'local',
      apiKey: '',
    }),
    providers: {
      local: {
        requiresApiKey: false,
        async complete(request) {
          calls.push(request);
          return {
            text: 'Local cleanup.',
            model: 'local-model',
            usage: {
              inputTokens: 3,
              outputTokens: 2,
              totalTokens: 5,
            },
          };
        },
      },
    },
  });

  const result = await service.cleanup({
    text: 'local cleanup',
    instruction: 'Return corrected text only.',
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].apiKey, '');
  assert.equal(calls[0].text, 'local cleanup');
  assert.equal(calls[0].instruction, 'Return corrected text only.');
  assert.equal(result.provider, 'local');
  assert.equal(result.text, 'Local cleanup.');
  assert.equal(result.usage.totalTokens, 5);
});

test('OpenAI-compatible presets use their own endpoint and model, without the DeepSeek-only field', async () => {
  const calls = [];
  const service = createLlmService({
    getConfig: () => config({ provider: 'groq' }),
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(successfulBody());
    },
  });

  const result = await service.cleanup({ text: 'hello world' });

  assert.equal(calls[0][0], 'https://api.groq.com/openai/v1/chat/completions');
  const request = JSON.parse(calls[0][1].body);
  assert.equal(request.model, 'llama-3.1-8b-instant');
  assert.equal('thinking' in request, false);
  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'llama-3.1-8b-instant');
});

test('a custom provider takes its base URL and model from the settings and needs no key', async () => {
  const calls = [];
  const service = createLlmService({
    getConfig: () => config({
      provider: 'custom',
      apiKey: '',
      baseUrl: 'http://localhost:11434/v1/',
      model: 'llama3.2',
    }),
    fetchImpl: async (...args) => {
      calls.push(args);
      return response({
        choices: [{ finish_reason: 'stop', message: { content: 'Hi there.' } }],
      });
    },
  });

  const result = await service.cleanup({ text: 'hi there' });

  assert.equal(calls[0][0], 'http://localhost:11434/v1/chat/completions');
  assert.equal('Authorization' in calls[0][1].headers, false);
  assert.equal(result.cleanupApplied, true);
  assert.equal(result.usage.totalTokens, 0, 'a server that reports no usage is still fine');
});

test('a custom provider with no base URL or model falls back instead of guessing', async () => {
  const service = createLlmService({
    getConfig: () => config({ provider: 'custom', apiKey: '' }),
    fetchImpl: async () => {
      throw new Error('must not be called');
    },
  });

  const result = await service.cleanup({ text: 'hello world' });

  assert.equal(result.cleanupApplied, false);
  assert.equal(result.reason, 'not-configured');
});

test('a rejected key and a wrong model are told apart from a generic failure', async () => {
  for (const [status, reason] of [[401, 'unauthorized'], [403, 'unauthorized'], [404, 'not-found'], [500, 'http-error']]) {
    const service = createLlmService({
      getConfig: () => config(),
      logger: { warn() {} },
      fetchImpl: async () => response({}, { ok: false, status }),
    });
    assert.equal((await service.cleanup({ text: 'hello world' })).reason, reason);
  }
});

test('test() sends one real request even when cleanup is switched off, and reports the outcome', async () => {
  let requests = 0;
  const service = createLlmService({
    getConfig: () => config({ enabled: false }),
    fetchImpl: async () => {
      requests += 1;
      return response(successfulBody('So this is a quick test of the cleanup.'));
    },
  });

  const good = await service.test();
  assert.equal(requests, 1);
  assert.equal(good.ok, true);
  assert.equal(good.text, 'So this is a quick test of the cleanup.');

  const noKey = createLlmService({
    getConfig: () => config({ apiKey: '' }),
    fetchImpl: async () => {
      throw new Error('must not be called');
    },
  });
  const bad = await noKey.test();
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'missing-key');
  assert.equal(bad.text, null);
});
