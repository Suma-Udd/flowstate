import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createPrerollRing } from '../src/renderer/recorder/audio-utils.mjs';

const require = createRequire(import.meta.url);
const { ChordLatch, createGlobalHotkey } = require('../src/main/hotkey.js');
const { createDictationController } = require('../src/main/dictation.js');

const CTRL = 29;
const WIN = 3675;
const C = 46;

const ramp = (start, count) =>
  Float32Array.from({ length: count }, (_, index) => start + index);

test('pre-roll ring returns exactly the newest samples across chunk edges', () => {
  const ring = createPrerollRing(10);
  ring.push(ramp(0, 4));
  ring.push(ramp(4, 4));
  ring.push(ramp(8, 4));
  assert.deepEqual(Array.from(ring.tail()), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(Array.from(ring.tail(3)), [9, 10, 11]);
  assert.deepEqual(Array.from(ring.tail(0)), []);
});

test('pre-roll ring stays bounded and never returns more than it holds', () => {
  const ring = createPrerollRing(8);
  for (let index = 0; index < 1000; index += 1) ring.push(ramp(index * 4, 4));
  assert.ok(ring.length < 8 + 4, `ring grew to ${ring.length}`);
  assert.equal(ring.tail().length, 8);
  assert.equal(ring.tail().at(-1), 3999);

  const young = createPrerollRing(100);
  young.push(ramp(0, 5));
  assert.equal(young.tail().length, 5);
  young.clear();
  assert.equal(young.length, 0);
  assert.equal(young.tail().length, 0);
});

test('pre-roll ring rejects non-Float32 chunks', () => {
  assert.throws(() => createPrerollRing(4).push([1, 2]), TypeError);
  assert.throws(() => createPrerollRing(-1), RangeError);
});

function latchHarness() {
  const events = [];
  const latch = new ChordLatch({
    chord: ['Ctrl', 'Meta'],
    onArm: () => events.push('arm'),
    onDisarm: () => events.push('disarm'),
    onDown: () => events.push('down'),
    onUp: (reason) => events.push(`up:${reason}`),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  return { events, latch };
}

test('the first chord key arms, the second becomes the press, no disarm between', () => {
  const { events, latch } = latchHarness();
  latch.handleKeyDown(CTRL);
  latch.handleKeyDown(CTRL); // auto-repeat must not re-arm
  latch.handleKeyDown(WIN);
  latch.handleKeyUp(WIN);
  assert.deepEqual(events, ['arm', 'down', 'up:keyup']);
});

test('Ctrl+C is withdrawn the moment a non-chord key arrives', () => {
  const { events, latch } = latchHarness();
  latch.handleKeyDown(CTRL);
  latch.handleKeyDown(C);
  latch.handleKeyUp(C);
  latch.handleKeyUp(CTRL);
  assert.deepEqual(events, ['arm', 'disarm']);
});

test('releasing the lone chord key withdraws the arm', () => {
  const { events, latch } = latchHarness();
  latch.handleKeyDown(WIN);
  latch.handleKeyUp(WIN);
  assert.deepEqual(events, ['arm', 'disarm']);
});

test('a plain non-chord key never arms', () => {
  const { events, latch } = latchHarness();
  latch.handleKeyDown(C);
  latch.handleKeyUp(C);
  assert.deepEqual(events, []);
});

test('stopping the latch while armed withdraws the arm', () => {
  const { events, latch } = latchHarness();
  latch.handleKeyDown(CTRL);
  latch.stop();
  assert.deepEqual(events, ['arm', 'disarm']);
});

test('arm and disarm are wired through the global hotkey', () => {
  const calls = [];
  const hook = {
    handlers: {},
    on(name, handler) { this.handlers[name] = handler; },
    off() {},
    start() {},
    stop() {},
  };
  const hotkey = createGlobalHotkey({
    hook,
    onArm: () => calls.push('arm'),
    onDisarm: () => calls.push('disarm'),
  });
  hotkey.start();
  hook.handlers.keydown({ keycode: CTRL });
  hook.handlers.keyup({ keycode: CTRL });
  assert.deepEqual(calls, ['arm', 'disarm']);
  // Rebuilding the latch (chord change) keeps the callbacks.
  hotkey.updateChord(['Ctrl', 'Alt']);
  hook.handlers.keydown({ keycode: CTRL });
  assert.deepEqual(calls, ['arm', 'disarm', 'arm']);
});

function controllerHarness({ workerState = { status: 'ready' }, enabled = true } = {}) {
  const calls = { prewarm: [], cancelPrewarm: 0, wake: 0 };
  const controller = createDictationController({
    recorder: {
      start: () => new Promise(() => {}),
      stop: () => new Promise(() => {}),
      cancel() {},
      prewarm: (options) => calls.prewarm.push(options),
      cancelPrewarm: () => { calls.cancelPrewarm += 1; },
    },
    worker: {
      getState: () => workerState,
      wake: () => { calls.wake += 1; },
      transcribe: () => new Promise(() => {}),
    },
    injector: { pasteText: async () => ({ ok: true }) },
    windows: {
      showPill() {}, setPillState() {}, pushPillAmplitude() {}, hidePill() {},
    },
    focus: { captureAtKeyDown: () => ({ exe: 'x.exe' }) },
    getConfig: () => ({ audio: { deviceId: 'mic-1' }, llm: {} }),
    isEnabled: () => enabled,
    logger: { log() {}, error() {}, warn() {} },
    timers: { setTimeout: () => 1, clearTimeout() {} },
  });
  return { calls, controller };
}

test('arming opens the configured microphone but never loads the ASR model', () => {
  const { calls, controller } = controllerHarness({
    workerState: { status: 'unloaded' },
  });
  controller.handleHotkeyArm();
  assert.deepEqual(calls.prewarm, [{ deviceId: 'mic-1' }]);
  assert.equal(calls.wake, 0);
});

test('disarm releases the speculative microphone', () => {
  const { calls, controller } = controllerHarness();
  controller.handleHotkeyArm();
  controller.handleHotkeyDisarm();
  assert.equal(calls.cancelPrewarm, 1);
});

test('arming is ignored while disabled or while a dictation is running', () => {
  const disabled = controllerHarness({ enabled: false });
  disabled.controller.handleHotkeyArm();
  assert.deepEqual(disabled.calls.prewarm, []);

  const busy = controllerHarness();
  busy.controller.handleHotkeyDown();
  busy.controller.handleHotkeyArm();
  assert.deepEqual(busy.calls.prewarm, []);
  // A disarm during a real dictation must not touch the recorder.
  busy.controller.handleHotkeyDisarm();
  assert.equal(busy.calls.cancelPrewarm, 0);
});

test('a recorder without prewarm support does not break arming', () => {
  const controller = createDictationController({
    recorder: { start: async () => {}, stop: async () => {}, cancel() {} },
    worker: { getState: () => ({ status: 'ready' }), transcribe: async () => ({}) },
    injector: { pasteText: async () => ({}) },
    windows: { showPill() {} },
    focus: { captureAtKeyDown: () => ({}) },
    getConfig: () => ({}),
    logger: { log() {}, error() {} },
  });
  controller.handleHotkeyArm();
  controller.handleHotkeyDisarm();
});
