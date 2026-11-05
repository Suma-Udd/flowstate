'use strict';

const DEFAULT_CHORD = Object.freeze(['Ctrl', 'Meta']);
const DEFAULT_WATCHDOG_MS = 120_000;

// uiohook-napi uses libuiohook's platform-independent key codes. A chord token
// may represent either side of a modifier; ordinary keys are exact.
const KEY_CODES = Object.freeze({
  Alt: Object.freeze([56, 3640]),
  Ctrl: Object.freeze([29, 3613]),
  Meta: Object.freeze([3675, 3676]),
  Shift: Object.freeze([42, 54]),
  Space: Object.freeze([57]),
  A: Object.freeze([30]),
  B: Object.freeze([48]),
  C: Object.freeze([46]),
  D: Object.freeze([32]),
  E: Object.freeze([18]),
  F: Object.freeze([33]),
  G: Object.freeze([34]),
  H: Object.freeze([35]),
  I: Object.freeze([23]),
  J: Object.freeze([36]),
  K: Object.freeze([37]),
  L: Object.freeze([38]),
  M: Object.freeze([50]),
  N: Object.freeze([49]),
  O: Object.freeze([24]),
  P: Object.freeze([25]),
  Q: Object.freeze([16]),
  R: Object.freeze([19]),
  S: Object.freeze([31]),
  T: Object.freeze([20]),
  U: Object.freeze([22]),
  V: Object.freeze([47]),
  W: Object.freeze([17]),
  X: Object.freeze([45]),
  Y: Object.freeze([21]),
  Z: Object.freeze([44]),
  '0': Object.freeze([11]),
  '1': Object.freeze([2]),
  '2': Object.freeze([3]),
  '3': Object.freeze([4]),
  '4': Object.freeze([5]),
  '5': Object.freeze([6]),
  '6': Object.freeze([7]),
  '7': Object.freeze([8]),
  '8': Object.freeze([9]),
  '9': Object.freeze([10]),
});

const ALIASES = Object.freeze({
  control: 'Ctrl',
  ctrl: 'Ctrl',
  win: 'Meta',
  windows: 'Meta',
  command: 'Meta',
  cmd: 'Meta',
  meta: 'Meta',
  option: 'Alt',
  alt: 'Alt',
  shift: 'Shift',
  space: 'Space',
});

const MODIFIERS = Object.freeze(new Set(['Alt', 'Ctrl', 'Meta', 'Shift']));
const RESERVED_CHORDS = Object.freeze(new Set([
  'L+Meta',
  'D+Meta',
  'E+Meta',
  'R+Meta',
  'I+Meta',
  'X+Meta',
  'U+Meta',
  'A+Meta',
  'S+Meta',
  'V+Meta',
  'M+Meta',
  'N+Meta',
  'Meta+Space',
  'Meta+S+Shift',
]));

function normaliseToken(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('Every hotkey chord entry must be a non-empty string.');
  }
  const trimmed = value.trim();
  const alias = ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  if (/^[a-z0-9]$/i.test(trimmed)) return trimmed.toUpperCase();
  throw new Error(`Unsupported hotkey key: ${trimmed}.`);
}

function compileChord(chord = DEFAULT_CHORD) {
  if (!Array.isArray(chord) || chord.length < 2 || chord.length > 4) {
    throw new RangeError('A hotkey chord must contain between 2 and 4 keys.');
  }

  const tokens = chord.map(normaliseToken);
  if (new Set(tokens).size !== tokens.length) {
    throw new Error('A hotkey chord cannot contain the same key twice.');
  }

  return Object.freeze({
    label: tokens.join('+'),
    tokens: Object.freeze(tokens),
    groups: Object.freeze(tokens.map((token) => KEY_CODES[token])),
  });
}

function chordSignature(tokens) {
  return tokens.slice().sort().join('+');
}

function validateRebindChord(chord) {
  if (
    Array.isArray(chord)
    && chord.length === 1
    && typeof chord[0] === 'string'
    && MODIFIERS.has(ALIASES[chord[0].trim().toLowerCase()] ?? chord[0])
  ) {
    return Object.freeze({
      ok: false,
      reason: 'A modifier key cannot be used on its own. Add another key.',
    });
  }

  let compiled;
  try {
    compiled = compileChord(chord);
  } catch (error) {
    return Object.freeze({ ok: false, reason: error.message });
  }

  if (RESERVED_CHORDS.has(chordSignature(compiled.tokens))) {
    return Object.freeze({
      ok: false,
      reason: `Windows reserves ${compiled.label}. Choose a different shortcut.`,
    });
  }

  return Object.freeze({
    ok: true,
    chord: compiled.tokens.slice(),
    label: compiled.label,
  });
}

const KEY_CODE_TO_TOKEN = Object.freeze(
  Object.fromEntries(
    Object.entries(KEY_CODES).flatMap(([token, codes]) =>
      codes.map((code) => [code, token])
    )
  )
);

class ChordLatch {
  #armed = false;
  #chord;
  #clearTimer;
  #onArm;
  #onDisarm;
  #onDown;
  #onUp;
  #onWatchdog;
  #pressed = new Set();
  #setTimer;
  #state = 'idle';
  #timer = null;
  #watchdogMs;

  constructor({
    chord = DEFAULT_CHORD,
    watchdogMs = DEFAULT_WATCHDOG_MS,
    onDown = () => {},
    onUp = () => {},
    onWatchdog = () => {},
    onArm = () => {},
    onDisarm = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (
      !Number.isFinite(watchdogMs)
      || watchdogMs <= 0
      || watchdogMs > DEFAULT_WATCHDOG_MS
    ) {
      throw new RangeError(
        `watchdogMs must be between 1 and ${DEFAULT_WATCHDOG_MS}.`
      );
    }
    for (const [name, callback] of Object.entries({
      onDown, onUp, onWatchdog, onArm, onDisarm,
    })) {
      if (typeof callback !== 'function') {
        throw new TypeError(`${name} must be a function.`);
      }
    }

    this.#chord = compileChord(chord);
    this.#watchdogMs = watchdogMs;
    this.#onDown = onDown;
    this.#onUp = onUp;
    this.#onWatchdog = onWatchdog;
    this.#onArm = onArm;
    this.#onDisarm = onDisarm;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  get active() {
    return this.#state === 'active';
  }

  get chord() {
    return this.#chord.tokens;
  }

  get state() {
    return this.#state;
  }

  handleKeyDown(keycode) {
    if (!Number.isInteger(keycode)) return;
    this.#pressed.add(keycode);
    if (this.#state === 'idle' && !this.#isPressed()) {
      // Early signal: the first chord key is down, so the microphone can start
      // opening while the rest of the chord is still travelling. Any other key
      // means an ordinary shortcut (Ctrl+C), so the signal is withdrawn.
      if (this.#isChordKey(keycode)) {
        if (!this.#armed) {
          this.#armed = true;
          this.#onArm();
        }
      } else {
        this.#disarm();
      }
    }
    if (this.#state === 'idle' && this.#isPressed()) {
      this.#armed = false;
      this.#state = 'active';
      this.#onDown();
      this.#timer = this.#setTimer(() => this.#fireWatchdog(), this.#watchdogMs);
    }
  }

  handleKeyUp(keycode) {
    if (!Number.isInteger(keycode)) return;
    this.#pressed.delete(keycode);

    if (this.#armed && !this.#anyChordKeyPressed()) this.#disarm();

    if (this.#state === 'active' && !this.#isPressed()) {
      this.#stop('keyup');
    } else if (this.#state === 'suppressed' && !this.#isPressed()) {
      this.#state = 'idle';
    }
  }

  stop() {
    this.#disarm();
    if (this.#state === 'active') {
      this.#stop('shutdown');
    }
    this.#pressed.clear();
    this.#state = 'idle';
  }

  #disarm() {
    if (!this.#armed) return;
    this.#armed = false;
    this.#onDisarm();
  }

  #isChordKey(keycode) {
    return this.#chord.groups.some((group) => group.includes(keycode));
  }

  #anyChordKeyPressed() {
    return this.#chord.groups.some((group) =>
      group.some((keycode) => this.#pressed.has(keycode))
    );
  }

  #fireWatchdog() {
    if (this.#state !== 'active') return;
    this.#timer = null;
    this.#state = 'suppressed';
    this.#onWatchdog();
    this.#onUp('watchdog');
  }

  #isPressed() {
    return this.#chord.groups.every((group) =>
      group.some((keycode) => this.#pressed.has(keycode))
    );
  }

  #stop(reason) {
    if (this.#timer !== null) {
      this.#clearTimer(this.#timer);
      this.#timer = null;
    }
    this.#state = 'idle';
    this.#onUp(reason);
  }
}

function createGlobalHotkey({
  hook,
  chord = DEFAULT_CHORD,
  watchdogMs = DEFAULT_WATCHDOG_MS,
  onDown = () => {},
  onUp = () => {},
  onWatchdog = () => {},
  onArm = () => {},
  onDisarm = () => {},
  timers = { setTimeout, clearTimeout },
} = {}) {
  if (
    !hook
    || typeof hook.on !== 'function'
    || typeof hook.off !== 'function'
    || typeof hook.start !== 'function'
    || typeof hook.stop !== 'function'
  ) {
    throw new TypeError('A uiohook-compatible hook is required.');
  }

  let latch = new ChordLatch({
    chord,
    watchdogMs,
    onDown,
    onUp,
    onWatchdog,
    onArm,
    onDisarm,
    setTimer: timers.setTimeout,
    clearTimer: timers.clearTimeout,
  });
  let rebind = null;
  let started = false;

  function finishRebind(result) {
    const active = rebind;
    rebind = null;
    latch.stop();
    if (active) active.callback(Object.freeze(result));
  }

  const keyDown = ({ keycode } = {}) => {
    if (!rebind) {
      latch.handleKeyDown(keycode);
      return;
    }
    if (!Number.isInteger(keycode)) return;
    rebind.pressed.add(keycode);
    if (!rebind.sawCodes.has(keycode)) {
      rebind.sawCodes.add(keycode);
      const token = KEY_CODE_TO_TOKEN[keycode];
      if (token && !rebind.tokens.includes(token)) {
        rebind.tokens.push(token);
      } else if (!token && rebind.unknownCode === null) {
        rebind.unknownCode = keycode;
      }
    }
  };

  const keyUp = ({ keycode } = {}) => {
    if (!rebind) {
      latch.handleKeyUp(keycode);
      return;
    }
    if (!Number.isInteger(keycode)) return;
    rebind.pressed.delete(keycode);
    if (rebind.sawCodes.size === 0 || rebind.pressed.size !== 0) return;
    if (rebind.unknownCode !== null) {
      finishRebind({
        status: 'rejected',
        reason: `That key is not supported (code ${rebind.unknownCode}).`,
      });
      return;
    }
    const validation = validateRebindChord(rebind.tokens);
    finishRebind(validation.ok
      ? {
          status: 'accepted',
          chord: validation.chord,
          label: validation.label,
        }
      : {
          status: 'rejected',
          chord: rebind.tokens.slice(),
          reason: validation.reason,
        });
  };

  function start() {
    if (started) return;
    hook.on('keydown', keyDown);
    hook.on('keyup', keyUp);
    hook.start();
    started = true;
  }

  function stop() {
    if (rebind) {
      finishRebind({ status: 'cancelled' });
    }
    latch.stop();
    if (!started) return;
    hook.off('keydown', keyDown);
    hook.off('keyup', keyUp);
    hook.stop();
    started = false;
  }

  function updateChord(nextChord) {
    // Validate before stopping the working hook. A malformed config update
    // must not silently disable the last known-good shortcut.
    compileChord(nextChord);
    const wasStarted = started;
    if (wasStarted) stop();
    latch = new ChordLatch({
      chord: nextChord,
      watchdogMs,
      onDown,
      onUp,
      onWatchdog,
      onArm,
      onDisarm,
      setTimer: timers.setTimeout,
      clearTimer: timers.clearTimeout,
    });
    if (wasStarted) start();
  }

  function startRebind(callback) {
    if (typeof callback !== 'function') {
      throw new TypeError('Hotkey rebind requires a result callback.');
    }
    if (!started) {
      throw new Error('Hotkey capture is unavailable while the global hook is stopped.');
    }
    if (rebind) {
      throw new Error('Hotkey rebind capture is already active.');
    }
    if (latch.active) {
      throw new Error('Release the current hotkey before rebinding it.');
    }
    latch.stop();
    rebind = {
      callback,
      pressed: new Set(),
      sawCodes: new Set(),
      tokens: [],
      unknownCode: null,
    };
  }

  function cancelRebind() {
    if (!rebind) return false;
    finishRebind({ status: 'cancelled' });
    return true;
  }

  return {
    cancelRebind,
    getChord: () => latch.chord.slice(),
    isRebinding: () => Boolean(rebind),
    isStarted: () => started,
    start,
    startRebind,
    stop,
    updateChord,
  };
}

module.exports = {
  ChordLatch,
  DEFAULT_CHORD,
  DEFAULT_WATCHDOG_MS,
  KEY_CODES,
  KEY_CODE_TO_TOKEN,
  RESERVED_CHORDS,
  compileChord,
  createGlobalHotkey,
  validateRebindChord,
};
