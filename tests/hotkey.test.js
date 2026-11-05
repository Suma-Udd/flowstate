'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  ChordLatch,
  DEFAULT_WATCHDOG_MS,
  compileChord,
  createGlobalHotkey,
  validateRebindChord,
} = require('../src/main/hotkey');

class FakeHook extends EventEmitter {
  starts = 0;
  stops = 0;
  start() { this.starts += 1; }
  stop() { this.stops += 1; }
}

function timerHarness() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    timers: {
      setTimeout(callback, delay) {
        const id = next++;
        pending.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    fire() {
      assert.equal(pending.size, 1);
      const [[id, timer]] = pending;
      pending.delete(id);
      timer.callback();
    },
  };
}

test('default Ctrl+Win chord accepts either side without duplicate events', () => {
  const events = [];
  const timer = timerHarness();
  const latch = new ChordLatch({
    onDown: () => events.push('down'),
    onUp: (reason) => events.push(`up:${reason}`),
    setTimer: timer.timers.setTimeout,
    clearTimer: timer.timers.clearTimeout,
  });

  latch.handleKeyDown(3613);
  latch.handleKeyDown(3675);
  latch.handleKeyDown(3675);
  latch.handleKeyUp(3613);

  assert.deepEqual(events, ['down', 'up:keyup']);
  assert.equal(timer.pending.size, 0);
});

test('configurable chords support modifiers plus an ordinary key', () => {
  const events = [];
  const latch = new ChordLatch({
    chord: ['Ctrl', 'Shift', 'X'],
    onDown: () => events.push('down'),
    onUp: () => events.push('up'),
  });

  latch.handleKeyDown(29);
  latch.handleKeyDown(42);
  latch.handleKeyDown(45);
  latch.handleKeyUp(45);
  assert.deepEqual(events, ['down', 'up']);
  assert.equal(compileChord(['control', 'win']).label, 'Ctrl+Meta');
});

test('120-second watchdog releases once and suppresses repeats until release', () => {
  const events = [];
  const timer = timerHarness();
  const latch = new ChordLatch({
    onDown: () => events.push('down'),
    onUp: (reason) => events.push(`up:${reason}`),
    onWatchdog: () => events.push('watchdog'),
    setTimer: timer.timers.setTimeout,
    clearTimer: timer.timers.clearTimeout,
  });

  latch.handleKeyDown(29);
  latch.handleKeyDown(3676);
  assert.equal([...timer.pending.values()][0].delay, DEFAULT_WATCHDOG_MS);
  timer.fire();
  latch.handleKeyDown(3676);
  latch.handleKeyUp(3676);
  latch.handleKeyUp(29);
  assert.deepEqual(events, ['down', 'watchdog', 'up:watchdog']);
});

test('a bad live chord update leaves the existing global hook working', () => {
  const hook = new FakeHook();
  const events = [];
  const globalHotkey = createGlobalHotkey({
    hook,
    onDown: () => events.push('down'),
  });
  globalHotkey.start();

  assert.throws(() => globalHotkey.updateChord(['Ctrl', 'Banana']), /Unsupported/);
  assert.equal(globalHotkey.isStarted(), true);
  hook.emit('keydown', { keycode: 29 });
  hook.emit('keydown', { keycode: 3675 });

  assert.deepEqual(events, ['down']);
  assert.equal(hook.stops, 0);
  globalHotkey.stop();
});

test('rebind validation explains bare modifiers and Windows-reserved chords', () => {
  assert.deepEqual(validateRebindChord(['Ctrl']), {
    ok: false,
    reason: 'A modifier key cannot be used on its own. Add another key.',
  });
  assert.deepEqual(validateRebindChord(['Meta', 'L']), {
    ok: false,
    reason: 'Windows reserves Meta+L. Choose a different shortcut.',
  });
  assert.deepEqual(validateRebindChord(['Ctrl', 'Shift', 'X']), {
    ok: true,
    chord: ['Ctrl', 'Shift', 'X'],
    label: 'Ctrl+Shift+X',
  });
});

test('rebind mode captures the next overlapping chord and suppresses dictation', () => {
  const hook = new FakeHook();
  const dictations = [];
  const results = [];
  const globalHotkey = createGlobalHotkey({
    hook,
    onDown: () => dictations.push('down'),
  });
  globalHotkey.start();
  globalHotkey.startRebind((result) => results.push(result));

  hook.emit('keydown', { keycode: 29 });
  hook.emit('keydown', { keycode: 42 });
  hook.emit('keydown', { keycode: 45 });
  hook.emit('keyup', { keycode: 45 });
  hook.emit('keyup', { keycode: 42 });
  hook.emit('keyup', { keycode: 29 });

  assert.deepEqual(dictations, []);
  assert.deepEqual(results, [{
    status: 'accepted',
    chord: ['Ctrl', 'Shift', 'X'],
    label: 'Ctrl+Shift+X',
  }]);
  assert.equal(globalHotkey.isRebinding(), false);
  globalHotkey.stop();
});
