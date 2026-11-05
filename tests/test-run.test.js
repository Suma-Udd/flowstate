'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestRunner, DEFAULT_DURATION_MS } = require('../src/main/test-run');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness({ workerStatus = 'ready' } = {}) {
  let nextTimer = 1;
  const pendingTimers = new Map();
  const start = deferred();
  const stop = deferred();
  const transcribe = deferred();
  const calls = { cancel: 0, pill: [], start: [], stop: 0, transcribe: [] };

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
    getState: () => ({ status: workerStatus }),
    transcribe(request) {
      calls.transcribe.push(request);
      return transcribe.promise;
    },
  };
  const windows = {
    showPill: (state, detail) => calls.pill.push(['show', state, detail]),
    setPillState: (state, detail) => calls.pill.push(['set', state, detail]),
    hidePill: () => calls.pill.push(['hide']),
  };

  const runner = createTestRunner({
    recorder,
    worker,
    windows,
    getConfig: () => ({ audio: { deviceId: 'mic-1' } }),
    createId: () => 'test-run-1',
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
    runner,
    start,
    stop,
    transcribe,
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
}

test('a happy run records for the fixed window, transcribes, and hides the pill exactly once', async () => {
  const h = harness();
  const result = h.runner.run();
  await microtasks();

  assert.deepEqual(h.calls.pill, [['show', 'listening', undefined]]);
  assert.deepEqual(h.calls.start, [{ deviceId: 'mic-1' }]);
  h.start.resolve({ contextSampleRate: 48_000 });
  await microtasks();

  h.fireTimer(DEFAULT_DURATION_MS);
  await microtasks();
  assert.deepEqual(h.calls.pill.at(-1), ['set', 'thinking', undefined]);
  assert.equal(h.calls.stop, 1);

  h.stop.resolve({ pcm: new Int16Array([1, 2, 3]) });
  await microtasks();
  assert.deepEqual(h.calls.transcribe, [{ id: 'test-run-1', pcm: new Int16Array([1, 2, 3]) }]);

  h.transcribe.resolve({ text: 'hello world', lang: 'en' });
  assert.deepEqual(await result, { text: 'hello world', lang: 'en' });
  assert.deepEqual(h.calls.pill.filter((entry) => entry[0] === 'hide'), [['hide']]);
  assert.equal(h.runner.isRunning(), false);
});

test('a second run cannot start while one is already in flight', async () => {
  const h = harness();
  const first = h.runner.run();
  await microtasks();
  await assert.rejects(h.runner.run(), /already running/);

  h.start.resolve({});
  await microtasks();
  h.fireTimer(DEFAULT_DURATION_MS);
  await microtasks();
  h.stop.resolve({ pcm: new Int16Array() });
  await microtasks();
  h.transcribe.resolve({ text: 'ok', lang: 'en' });
  await first;
});

test('a model that has not finished loading refuses without touching the recorder', async () => {
  const h = harness({ workerStatus: 'downloading' });
  await assert.rejects(h.runner.run(), /still loading/);
  assert.deepEqual(h.calls.start, []);
  assert.deepEqual(h.calls.pill, []);
});

test('no detected speech surfaces a friendly error and hides the pill', async () => {
  const h = harness();
  const result = h.runner.run();
  await microtasks();
  h.start.resolve({});
  await microtasks();
  h.fireTimer(DEFAULT_DURATION_MS);
  await microtasks();
  h.stop.resolve({ pcm: new Int16Array() });
  await microtasks();
  h.transcribe.resolve({ text: '', lang: null });

  await assert.rejects(result, /No speech was detected/);
  assert.deepEqual(h.calls.pill.at(-1), ['hide']);
  assert.equal(h.calls.cancel, 0, 'the capture already stopped cleanly; nothing to cancel');
});

test('a start failure has nothing to cancel: no capture ever began', async () => {
  const h = harness();
  const result = h.runner.run();
  await microtasks();
  h.start.reject(new Error('The microphone disconnected.'));

  await assert.rejects(result, /microphone disconnected/);
  assert.equal(h.calls.cancel, 0, 'recorder.start() itself failed; there is no capture to cancel');
  assert.deepEqual(h.calls.pill.at(-1), ['hide']);
});

test('a failure after capture has started cancels it and hides the pill', async () => {
  const h = harness();
  const result = h.runner.run();
  await microtasks();
  h.start.resolve({});
  await microtasks();
  h.fireTimer(DEFAULT_DURATION_MS);
  await microtasks();
  h.stop.reject(new Error('Recorder returned invalid PCM.'));

  await assert.rejects(result, /invalid PCM/);
  assert.equal(h.calls.cancel, 1, 'a capture was in flight when it failed');
  assert.deepEqual(h.calls.pill.at(-1), ['hide']);
});
