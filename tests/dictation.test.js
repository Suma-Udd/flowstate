'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDictationController } = require('../src/main/dictation');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness({
  pasteResult = { ok: true, state: 'pasted', code: 'pasted' },
  cleanupResult,
  dictionaryTerms = [],
  snippets = [],
  llmConfig = { skipUnderWords: 0, removeFillers: true },
  target = {
    windowId: 'target-1',
    exe: 'editor.exe',
    capturedAt: 1,
  },
  recordHistoryOutcome,
  workerState = { status: 'ready' },
  wake,
} = {}) {
  let clock = 0;
  let nextTimer = 1;
  const pendingTimers = new Map();
  const start = deferred();
  const stop = deferred();
  const transcribe = deferred();
  const calls = {
    cancel: 0,
    cleanup: [],
    dictionaryCorrections: [],
    historyOutcomes: [],
    logger: [],
    pill: [],
    paste: [],
    results: [],
    snippetUses: [],
    start: [],
    stop: 0,
    transcribe: [],
  };
  const recorder = {
    start(options) {
      calls.start.push(options);
      return start.promise;
    },
    stop() {
      calls.stop += 1;
      return stop.promise;
    },
    cancel() {
      calls.cancel += 1;
    },
  };
  const worker = {
    getState: () => workerState,
    wake,
    transcribe(request) {
      calls.transcribe.push(request);
      return transcribe.promise;
    },
  };
  const injector = {
    async pasteText(request) {
      calls.paste.push(request);
      return pasteResult;
    },
  };
  const windows = {
    showPill: (state, detail) => calls.pill.push(['show', state, detail]),
    setPillState: (state, detail) => calls.pill.push(['set', state, detail]),
    pushPillAmplitude: (value) => calls.pill.push(['amplitude', value]),
    hidePill: () => calls.pill.push(['hide']),
  };
  const controller = createDictationController({
    recorder,
    worker,
    llm: cleanupResult
      ? {
          async cleanup(request) {
            calls.cleanup.push(request);
            return cleanupResult;
          },
        }
      : undefined,
    injector,
    windows,
    focus: {
      captureAtKeyDown: () => target,
    },
    getConfig: () => ({
      audio: { deviceId: 'mic-1' },
      llm: llmConfig,
    }),
    getSnippets: () => snippets,
    getDictionaryTerms: () => dictionaryTerms,
    recordSnippetUses: (ids) => calls.snippetUses.push(ids),
    recordDictionaryCorrections: (ids) =>
      calls.dictionaryCorrections.push(ids),
    recordHistoryOutcome: recordHistoryOutcome
      ?? ((outcome) => calls.historyOutcomes.push(outcome)),
    createId: () => 'dictation-1',
    now: () => clock,
    wallClock: () => 0,
    logger: {
      log: (message) => calls.logger.push(['log', message]),
      error: (message) => calls.logger.push(['error', message]),
      note: (message) => calls.logger.push(['note', message]),
    },
    onResult: (result) => calls.results.push(result),
    timers: {
      setTimeout(callback, delay) {
        const id = nextTimer++;
        pendingTimers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        pendingTimers.delete(id);
      },
    },
  });

  return {
    calls,
    controller,
    pendingTimers,
    start,
    stop,
    transcribe,
    setClock(value) { clock = value; },
    fireTimer(delay) {
      const entry = [...pendingTimers].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `no ${delay}ms timer is pending`);
      pendingTimers.delete(entry[0]);
      entry[1].callback();
    },
  };
}

async function microtasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('hotkey on an unloaded model wakes it and starts capturing; a cold start still errors', () => {
  let woke = 0;
  const state = { status: 'unloaded' };
  const h = harness({
    workerState: state,
    wake: () => {
      woke += 1;
      Object.assign(state, { status: 'loading', waking: true });
    },
  });
  h.controller.handleHotkeyDown();
  assert.equal(woke, 1);
  assert.equal(h.controller.getState(), 'arming');

  const cold = harness({ workerState: { status: 'loading' } });
  cold.controller.handleHotkeyDown();
  assert.equal(cold.controller.getState(), 'error');
});

test('an accidental sub-300ms tap cancels silently', async () => {
  const h = harness();
  h.controller.handleHotkeyDown();
  assert.equal(h.controller.getState(), 'arming');
  assert.deepEqual(h.calls.start, [{ deviceId: 'mic-1' }]);

  h.setClock(299);
  h.controller.handleHotkeyUp('keyup');
  h.start.resolve();
  await microtasks();

  assert.equal(h.controller.getState(), 'idle');
  assert.equal(h.calls.cancel, 1);
  assert.deepEqual(h.calls.pill, []);
  assert.deepEqual(h.calls.transcribe, []);
});

test('hold, release, and transcribe produce the explicit state and pill trace', async () => {
  const h = harness();
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  assert.equal(h.controller.getState(), 'listening');

  h.setClock(300);
  h.fireTimer(300);
  h.controller.pushAmplitude(0.4);
  assert.deepEqual(h.calls.pill.slice(-2), [
    ['show', 'listening', undefined],
    ['amplitude', 0.4],
  ]);

  h.setClock(800);
  h.controller.handleHotkeyUp('keyup');
  assert.equal(h.controller.getState(), 'thinking');
  assert.equal(h.calls.stop, 1);

  const pcm = new Int16Array([1, 2, 3]);
  h.stop.resolve({ pcm });
  await microtasks();
  assert.equal(h.calls.transcribe[0].pcm, pcm);

  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'Hello world.',
    lang: 'en',
    vadMs: 1,
    inferMs: 20,
    totalMs: 22,
  });
  await microtasks();
  assert.equal(h.controller.getState(), 'pasting');
  assert.equal(h.calls.results[0].target.windowId, 'target-1');
  assert.equal(h.calls.paste[0].text, 'Hello world.');
  assert.equal(h.calls.paste[0].target.windowId, 'target-1');
  assert.ok(
    h.calls.logger.some(
      ([, line]) =>
        line.includes(
          'Dictation timing id=dictation-1 capture=0ms vad=1ms ' +
          'asr=20ms llm=0ms inject=0ms total=0ms'
        )
    )
  );

  h.fireTimer(350);
  await microtasks();
  assert.equal(h.controller.getState(), 'idle');
  assert.deepEqual(h.calls.pill.slice(-2), [
    ['set', 'pasting', undefined],
    ['hide'],
  ]);

  const trace = h.calls.logger
    .filter(([kind, line]) => kind === 'log' && line.startsWith('Dictation state'))
    .map(([, line]) => line.match(/(\w+) -> (\w+)/).slice(1).join('->'));
  assert.deepEqual(trace, [
    'idle->arming',
    'arming->listening',
    'listening->thinking',
    'thinking->pasting',
    'pasting->idle',
  ]);
});

test('an injection failure surfaces the returned recovery message', async () => {
  const h = harness({
    pasteResult: {
      ok: false,
      state: 'error',
      code: 'paste-rejected',
      message: 'Paste was blocked. The transcript is on the clipboard.',
    },
  });
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(400);
  h.fireTimer(300);
  h.controller.handleHotkeyUp('keyup');
  h.stop.resolve({ pcm: new Int16Array([1]) });
  await microtasks();
  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'Keep this text.',
    lang: 'en',
    vadMs: 1,
    inferMs: 2,
    totalMs: 3,
  });
  await microtasks();

  assert.equal(h.controller.getState(), 'error');
  assert.deepEqual(h.calls.pill.at(-1), [
    'show',
    'error',
    { reason: 'Paste was blocked. The transcript is on the clipboard.' },
  ]);
  assert.equal(h.calls.results[0].injection.code, 'paste-rejected');
  // The failed paste is still recorded against its history row.
  assert.deepEqual(h.calls.historyOutcomes, [{
    id: 'dictation-1',
    ok: false,
    code: 'paste-rejected',
    injectMs: 0,
    totalMs: 0,
  }]);
});

test('history row carries the captured speech duration and the paste outcome', async () => {
  const h = harness();
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(400);
  h.fireTimer(300);
  h.controller.handleHotkeyUp('keyup');
  // 2.5 s at 16 kHz.
  h.stop.resolve({
    pcm: new Int16Array(40_000),
    metadata: { capturedSeconds: 2.5, outputSampleRate: 16_000 },
  });
  await microtasks();
  h.setClock(900);
  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'Duration is measured from samples.',
    lang: 'en',
    vadMs: 1,
    inferMs: 2,
    totalMs: 3,
  });
  await microtasks();
  await microtasks();

  assert.equal(h.calls.paste[0].historyEntry.durationMs, 2_500);
  assert.deepEqual(h.calls.historyOutcomes, [{
    id: 'dictation-1',
    ok: true,
    code: 'pasted',
    injectMs: 0,
    totalMs: 500,
  }]);
});

test('a throwing history outcome hook never breaks the dictation', async () => {
  const h = harness({
    recordHistoryOutcome: () => {
      throw new Error('disk is gone');
    },
  });
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(400);
  h.fireTimer(300);
  h.controller.handleHotkeyUp('keyup');
  h.stop.resolve({ pcm: new Int16Array([1]) });
  await microtasks();
  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'Still pastes.',
    lang: 'en',
    vadMs: 1,
    inferMs: 2,
    totalMs: 3,
  });
  await microtasks();
  await microtasks();

  assert.equal(h.calls.paste.length, 1);
  assert.equal(h.calls.results.length, 1);
  assert.equal(h.controller.getState(), 'pasting');
});

test('watchdog release commits and stops a capture exactly like keyup', async () => {
  const h = harness();
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(120_000);
  h.controller.handleHotkeyUp('watchdog');
  assert.equal(h.controller.getState(), 'thinking');
  assert.equal(h.calls.stop, 1);
});

test('microphone failure is visible as error and always returns to idle', async () => {
  const h = harness();
  h.controller.handleHotkeyDown();
  h.start.reject(new Error('Microphone permission was denied.'));
  await microtasks();

  assert.equal(h.controller.getState(), 'error');
  assert.deepEqual(h.calls.pill.at(-1), [
    'show',
    'error',
    { reason: 'Microphone permission was denied.' },
  ]);
  h.fireTimer(2_000);
  assert.equal(h.controller.getState(), 'idle');
  assert.deepEqual(h.calls.pill.at(-1), ['hide']);
});

test('cleanup output and token accounting are retained in the pre-database history entry', async () => {
  const h = harness({
    cleanupResult: {
      text: 'Cleaned transcript.',
      cleanupApplied: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reason: 'cleaned',
      llmMs: 42,
      usage: {
        inputTokens: 12,
        outputTokens: 3,
        totalTokens: 15,
      },
    },
  });
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(400);
  h.fireTimer(300);
  h.controller.handleHotkeyUp('keyup');
  h.stop.resolve({ pcm: new Int16Array([1]) });
  await microtasks();
  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'cleaned transcript',
    lang: 'en',
    vadMs: 1,
    inferMs: 2,
    totalMs: 3,
  });
  await microtasks();
  await microtasks();

  assert.equal(h.calls.cleanup.length, 1);
  assert.equal(h.calls.cleanup[0].text, 'cleaned transcript');
  assert.match(h.calls.cleanup[0].instruction, /English \(en\)/);
  assert.match(h.calls.cleanup[0].instruction, /TARGET APP — plain text/);
  assert.equal(h.calls.paste[0].text, 'Cleaned transcript.');
  assert.deepEqual(h.calls.paste[0].historyEntry, {
    id: 'dictation-1',
    createdAt: new Date(0).toISOString(),
    language: 'en',
    rawText: 'cleaned transcript',
    snippetText: 'cleaned transcript',
    llmText: 'Cleaned transcript.',
    dictionaryText: 'Cleaned transcript.',
    finalText: 'Cleaned transcript.',
    cleanedText: 'Cleaned transcript.',
    pipelineStages: {
      raw: 'cleaned transcript',
      snippets: 'cleaned transcript',
      llm: 'Cleaned transcript.',
      dictionary: 'Cleaned transcript.',
      final: 'Cleaned transcript.',
    },
    cleanupApplied: true,
    cleanupReason: 'cleaned',
    llmProvider: 'deepseek',
    llmModel: 'deepseek-v4-flash',
    llmMs: 42,
    llmInputTokens: 12,
    llmOutputTokens: 3,
    llmTokens: 15,
    vadMs: 1,
    asrMs: 2,
    durationMs: 0,
  });
  assert.equal(h.calls.results[0].rawText, 'cleaned transcript');
  assert.equal(h.calls.results[0].text, 'Cleaned transcript.');
  assert.equal(h.calls.results[0].cleanup.usage.totalTokens, 15);
});

test('utterances under the configured word threshold bypass the LLM immediately', async () => {
  const h = harness({
    llmConfig: { skipUnderWords: 4, removeFillers: true },
    cleanupResult: {
      text: 'This must not be used.',
      cleanupApplied: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reason: 'cleaned',
      llmMs: 20,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  });
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(400);
  h.fireTimer(300);
  h.controller.handleHotkeyUp('keyup');
  h.stop.resolve({ pcm: new Int16Array([1]) });
  await microtasks();
  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'paste this now',
    lang: 'en',
    vadMs: 1,
    inferMs: 2,
    totalMs: 3,
  });
  await microtasks();

  assert.deepEqual(h.calls.cleanup, []);
  assert.equal(h.calls.paste[0].text, 'paste this now');
  assert.equal(h.calls.paste[0].historyEntry.cleanupReason, 'short-utterance');
  assert.equal(h.calls.paste[0].historyEntry.llmMs, 0);
});

test('cleanup receives detected language, app profile, dictionary, and filler preference', async () => {
  const h = harness({
    llmConfig: { skipUnderWords: 0, removeFillers: false },
    target: {
      windowId: 'target-1',
      exe: 'Code.exe',
      capturedAt: 1,
    },
    dictionaryTerms: [
      {
        term: 'Anmeldebestätigung',
        soundsLike: 'anmelde bestätigung',
        lang: 'de',
      },
    ],
    cleanupResult: {
      text: 'Die Anmeldebestätigung bleibt exakt.',
      cleanupApplied: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reason: 'cleaned',
      llmMs: 20,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    },
  });
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(400);
  h.fireTimer(300);
  h.controller.handleHotkeyUp('keyup');
  h.stop.resolve({ pcm: new Int16Array([1]) });
  await microtasks();
  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'die anmelde bestätigung bleibt exakt',
    lang: 'de',
    vadMs: 1,
    inferMs: 2,
    totalMs: 3,
  });
  await microtasks();
  await microtasks();

  const instruction = h.calls.cleanup[0].instruction;
  assert.match(instruction, /German \(de\)/);
  assert.match(instruction, /TARGET APP — code editor/);
  assert.match(instruction, /Preserve filler words/);
  assert.match(instruction, /"Anmeldebestätigung"/);
});

test('the live controller retains ordered stages and records expansion/repair counters', async () => {
  const h = harness({
    snippets: [{
      id: 'snippet-1',
      trigger: 'release shortcut',
      expansion: 'the release checklist',
      appScope: null,
    }],
    dictionaryTerms: [{
      id: 'dictionary-1',
      term: 'Samuel',
      soundsLike: null,
      lang: 'en',
    }],
    cleanupResult: {
      text: 'Use the release checklist for Samul.',
      cleanupApplied: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reason: 'cleaned',
      llmMs: 20,
      usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
    },
  });
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(400);
  h.fireTimer(300);
  h.controller.handleHotkeyUp('keyup');
  h.stop.resolve({ pcm: new Int16Array([1]) });
  await microtasks();
  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'Use release shortcut for Samuel.',
    lang: 'en',
    vadMs: 1,
    inferMs: 2,
    totalMs: 3,
  });
  await microtasks();
  await microtasks();

  assert.equal(
    h.calls.cleanup[0].text,
    'Use the release checklist for Samuel.'
  );
  assert.equal(h.calls.paste[0].text, 'Use the release checklist for Samuel.');
  assert.deepEqual(h.calls.paste[0].historyEntry.pipelineStages, {
    raw: 'Use release shortcut for Samuel.',
    snippets: 'Use the release checklist for Samuel.',
    llm: 'Use the release checklist for Samul.',
    dictionary: 'Use the release checklist for Samuel.',
    final: 'Use the release checklist for Samuel.',
  });
  assert.deepEqual(h.calls.snippetUses, [['snippet-1']]);
  assert.deepEqual(h.calls.dictionaryCorrections, [['dictionary-1']]);
});

test('disabling dictation during the result display cancels back to idle', async () => {
  const h = harness();
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(400);
  h.fireTimer(300);
  h.controller.handleHotkeyUp('keyup');
  h.stop.resolve({ pcm: new Int16Array([1]) });
  await microtasks();
  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'Done.',
    lang: 'en',
    vadMs: 1,
    inferMs: 2,
    totalMs: 3,
  });
  await microtasks();
  assert.equal(h.controller.getState(), 'pasting');

  h.controller.cancel();
  await microtasks();
  assert.equal(h.controller.getState(), 'idle');
  assert.equal(h.pendingTimers.size, 0);
  assert.deepEqual(h.calls.pill.at(-1), ['hide']);
});

test('a rejected cleanup logs the reason, the offending word and both texts, and pastes the raw transcript', async () => {
  const h = harness({
    cleanupResult: {
      text: 'The capital of France is Paris.',
      cleanupApplied: true,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      reason: 'cleaned',
      llmMs: 5,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  });
  h.controller.handleHotkeyDown();
  h.start.resolve();
  await microtasks();
  h.setClock(400);
  h.fireTimer(300);
  h.controller.handleHotkeyUp('keyup');
  h.stop.resolve({ pcm: new Int16Array([1]) });
  await microtasks();
  h.transcribe.resolve({
    id: 'dictation-1',
    text: 'what is the capital of france',
    lang: 'en',
    vadMs: 1,
    inferMs: 2,
    totalMs: 3,
  });
  await microtasks();
  await microtasks();

  assert.equal(h.calls.paste[0].text, 'what is the capital of france');
  const notes = h.calls.logger.filter(([kind]) => kind === 'note').map(([, message]) => message);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /rejected the model output \(new-word \["paris"\]\)/);
  assert.match(notes[0], /raw="what is the capital of france"/);
  assert.match(notes[0], /model="The capital of France is Paris\."/);
  assert.ok(h.calls.logger.every(([kind]) => kind !== 'error'));
});
