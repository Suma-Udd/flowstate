'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { createAsrWorkerManager } = require('../src/main/asr-worker');
const { trimSilence } = require('../src/worker/asr');
const { createWorkerRuntime, modelsDirectoryFromArgs } = require('../src/worker');

class FakePort extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
  }

  postMessage(message) {
    this.messages.push(message);
  }

  send(message) {
    this.emit('message', { data: message });
  }
}

test('the utility worker accepts only an absolute model-cache argument', () => {
  assert.equal(
    modelsDirectoryFromArgs(['electron', 'worker.js', 'C:\\cache\\models']),
    'C:\\cache\\models'
  );
  assert.equal(
    modelsDirectoryFromArgs(['electron', 'worker.js', 'relative-models']),
    undefined
  );
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    this.messages = [];
  }

  kill() {
    this.killed = true;
  }

  postMessage(message) {
    this.messages.push(message);
  }
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('worker announces ready only after the warm engine has loaded', async () => {
  const port = new FakePort();
  let finishLoading;
  const engineLoaded = new Promise((resolve) => {
    finishLoading = resolve;
  });
  const runtime = createWorkerRuntime({
    port,
    loadEngine: () => engineLoaded,
    onFatal: assert.fail,
  });

  port.send({
    type: 'transcribe',
    id: 'too-early',
    pcm: new Int16Array([1]),
  });
  assert.deepEqual(port.messages, [
    {
      type: 'error',
      id: 'too-early',
      message: 'ASR worker is not ready.',
    },
  ]);

  finishLoading({
    transcribe: async () => ({
      text: '',
      lang: '',
      vadMs: 0,
      inferMs: 0,
      totalMs: 0,
    }),
  });
  await runtime.loaded;

  assert.equal(runtime.isReady(), true);
  assert.equal(
    port.messages.filter((message) => message.type === 'ready').length,
    1
  );
});

test('worker protocol correlates a stub transcript and timing fields', async () => {
  const port = new FakePort();
  const pcm = new Int16Array([0, 12_000, -12_000, 0]);
  const runtime = createWorkerRuntime({
    port,
    loadEngine: async () => ({
      async transcribe(request) {
        assert.equal(request.pcm, pcm);
        assert.equal(request.hintLang, 'de');
        return {
          text: 'Guten Morgen.',
          lang: 'de',
          vadMs: 2.5,
          inferMs: 41.2,
          totalMs: 44.1,
        };
      },
    }),
    onFatal: assert.fail,
  });
  await runtime.loaded;

  port.send({
    type: 'transcribe',
    id: 'dictation-7',
    pcm,
    hintLang: 'de',
  });
  await nextTurn();

  assert.deepEqual(port.messages.at(-1), {
    type: 'result',
    id: 'dictation-7',
    text: 'Guten Morgen.',
    lang: 'de',
    vadMs: 2.5,
    inferMs: 41.2,
    totalMs: 44.1,
  });
});

test('VAD bounds trim only outer silence and retain internal pauses', () => {
  const samples = Float32Array.from(
    { length: 2_048 },
    (_, index) => index / 2_048
  );
  const segments = [
    { start: 256, samples: samples.slice(256, 700) },
    { start: 1_200, samples: samples.slice(1_200, 1_500) },
  ];
  const accepted = [];
  const vad = {
    acceptWaveform(window) {
      accepted.push(window);
    },
    clear() {},
    flush() {},
    front() {
      return segments[0];
    },
    isEmpty() {
      return segments.length === 0;
    },
    pop() {
      segments.shift();
    },
    reset() {},
  };

  const trimmed = trimSilence(vad, samples, undefined, { padSamples: 0 });

  assert.equal(accepted.length, 4);
  assert.equal(trimmed.length, 1_500 - 256);
  assert.deepEqual(trimmed, samples.slice(256, 1_500));
});

function fakeVad(segments) {
  return {
    acceptWaveform() {},
    clear() {},
    flush() {},
    front: () => segments[0],
    isEmpty: () => segments.length === 0,
    pop: () => segments.shift(),
    reset() {},
  };
}

test('VAD bounds keep a margin so soft first and last sounds survive', () => {
  const samples = Float32Array.from({ length: 48_000 }, (_, index) => index);
  const vad = fakeVad([{ start: 16_000, samples: samples.slice(16_000, 24_000) }]);

  const trimmed = trimSilence(vad, samples, undefined, { padSamples: 4_800 });

  assert.equal(trimmed[0], 16_000 - 4_800);
  assert.equal(trimmed.at(-1), 24_000 + 4_800 - 1);
});

test('the margin is clamped to the capture', () => {
  const samples = Float32Array.from({ length: 10_000 }, (_, index) => index);
  const vad = fakeVad([{ start: 1_000, samples: samples.slice(1_000, 9_500) }]);

  const trimmed = trimSilence(vad, samples, undefined, { padSamples: 4_800 });

  assert.equal(trimmed.length, 10_000);
});

test('a short capture the VAD missed is decoded whole, a long one is not', () => {
  const short = new Float32Array(16_000 * 2).fill(0.01);
  assert.equal(trimSilence(fakeVad([]), short).length, short.length);

  const long = new Float32Array(16_000 * 20);
  assert.equal(trimSilence(fakeVad([]), long).length, 0);
});

test('main rejects pending work, respawns once, then surfaces an error', async () => {
  const children = [];
  const states = [];
  const manager = createAsrWorkerManager({
    fork(workerPath, workerArgs) {
      assert.equal(path.basename(workerPath), 'index.js');
      assert.deepEqual(workerArgs, ['C:\\model-cache']);
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    workerPath: path.join('src', 'worker', 'index.js'),
    workerArgs: ['C:\\model-cache'],
    onStateChange: (state) => states.push(state),
  });

  manager.start();
  children[0].emit('message', { type: 'ready' });
  const interrupted = manager.transcribe({
    id: 'first',
    pcm: new Int16Array([1, 2]),
  });
  children[0].emit('exit', 9);

  await assert.rejects(interrupted, /exited unexpectedly/);
  assert.equal(children.length, 2);
  assert.equal(manager.getState().status, 'restarting');

  children[1].emit('message', { type: 'ready' });
  const completed = manager.transcribe({
    id: 'second',
    pcm: new Int16Array([3, 4]),
  });
  children[1].emit('message', {
    type: 'result',
    id: 'second',
    text: 'hello',
    lang: 'en',
    vadMs: 1,
    inferMs: 20,
    totalMs: 22,
  });
  assert.equal((await completed).text, 'hello');

  children[1].emit('exit', 7);
  assert.equal(children.length, 2);
  assert.equal(manager.getState().status, 'error');
  assert.match(manager.getState().error, /exited unexpectedly/);
  assert.ok(states.some((state) => state.status === 'ready'));
  assert.ok(states.some((state) => state.status === 'restarting'));
});

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, ms) {
      const handle = { ms, cleared: false, unref() {} };
      handle.fn = () => {
        handle.cleared = true;
        fn();
      };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      handle.cleared = true;
    },
    live: () => scheduled.filter((handle) => !handle.cleared),
  };
}

test('model unloads after the idle delay and a dictation reloads it transparently', async () => {
  const children = [];
  const timers = fakeTimers();
  const manager = createAsrWorkerManager({
    fork() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    workerPath: path.join('src', 'worker', 'index.js'),
    getUnloadAfterMs: () => 15 * 60_000,
    timers,
  });

  manager.start();
  children[0].emit('message', { type: 'ready' });
  assert.equal(timers.live().length, 1);
  assert.equal(timers.live()[0].ms, 15 * 60_000);

  timers.live()[0].fn();
  assert.equal(manager.getState().status, 'unloaded');
  assert.equal(children[0].killed, true);
  assert.equal(timers.live().length, 0);
  children[0].emit('exit', 0);
  assert.equal(manager.getState().status, 'unloaded');
  assert.equal(children.length, 1);

  const completed = manager.transcribe({ id: 'cold', pcm: new Int16Array([1]) });
  assert.equal(children.length, 2);
  assert.equal(manager.getState().status, 'loading');
  assert.equal(manager.getState().waking, true);
  children[1].emit('message', { type: 'ready' });
  await Promise.resolve();
  await Promise.resolve();
  children[1].emit('message', {
    type: 'result', id: 'cold', text: 'hi', lang: 'en', vadMs: 1, inferMs: 1, totalMs: 2,
  });
  assert.equal((await completed).text, 'hi');
  assert.equal(timers.live().length, 1, 'idle timer re-armed after the result');
});

test('unload delay of zero never arms a timer, and work in flight blocks unload', () => {
  const children = [];
  const timers = fakeTimers();
  let unloadMs = 0;
  const manager = createAsrWorkerManager({
    fork() {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    workerPath: path.join('src', 'worker', 'index.js'),
    getUnloadAfterMs: () => unloadMs,
    timers,
  });
  manager.start();
  children[0].emit('message', { type: 'ready' });
  assert.equal(timers.live().length, 0);

  unloadMs = 60_000;
  manager.refreshIdleTimer();
  assert.equal(timers.live().length, 1);
  void manager.transcribe({ id: 'busy', pcm: new Int16Array([1]) }).catch(() => {});
  assert.equal(timers.live().length, 0, 'timer cleared while transcribing');
  manager.unload();
  assert.equal(manager.getState().status, 'ready');
});
