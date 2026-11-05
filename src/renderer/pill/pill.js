/* ==========================================================================
   Flowstate — the recording pill controller (issue #11)

   Vanilla JS, no framework, no bundler, no build step. Loaded as a classic
   script by pill.html and demo.html, and required directly by
   tests/pill.test.js — hence the UMD-ish tail at the bottom.

   What this file is responsible for:

     - the five states, and which glyph and body each one shows;
     - the waveform: amplitude arrives from main at ~30Hz, the bars are drawn
       at 60fps, and the gap between the two is interpolated rather than
       stepped, so the wave never looks like a bar chart being nudged;
     - the animation loop's lifecycle. The loop runs only while the pill is
       actually listening AND actually on screen. Everything else — thinking,
       pasting, error, hidden, exited — is zero JS per frame.

   That last point is the hard rule of this issue. A requestAnimationFrame loop
   ticking against a hidden window is the single easiest way to fail gate G4's
   idle flatline, so `setRendering(false)` cancels the frame, stills the CSS
   animations via data-anim, and parks the bars at their floor.

   The controller never sends anything back to main. The pill is an indicator,
   not a window: it takes state and amplitude, and that is the entire contract.
   ========================================================================== */

(function (root, factory) {
  'use strict';
  var api = factory();
  /* Node (tests) gets module.exports; the browser gets a global. Same file,
     so what the tests exercise is what the window runs. */
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.FlowPill = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* The five states, in the order the state machine in the engine notes walks
     them. Anything not in this list is rejected rather than rendered, because
     an unknown data-state would style as "no state at all" — an invisible pill
     during a live dictation. */
  var STATES = ['idle-armed', 'listening', 'thinking', 'pasting', 'error'];

  /* Text is the confirmation, never the signal: each state is meant to read in
     peripheral vision from its shape and colour alone. These strings are what
     the user sees when they do look, and what a screen reader announces. */
  var LABELS = {
    'idle-armed': 'Ready',
    listening: 'Listening',
    thinking: 'Thinking',
    pasting: 'Pasted',
    error: 'Something went wrong',
  };

  var BARS = 28;

  /* One waveform slot per ~60fps frame, advanced from the frame delta rather
     than per callback, so the wave scrolls at the same speed on a 144Hz
     monitor as on a 60Hz one. */
  var SLOT_MS = 16;

  /* Interpolation time constant. At 30Hz input a sample lands every ~33ms, so
     the smoothing has to bridge about that much without flattening the speech
     that makes the wave worth looking at: at 55ms the syllables washed out and
     the pill read as a level meter rather than a voice. */
  var SMOOTH_MS = 38;

  /* A silent bar is still a bar: the wave should read as a quiet line, not as
     an empty pill. */
  var FLOOR = 0.06;

  /* A frame delta longer than this means the loop was parked (window occluded,
     machine asleep). Interpolating across it would snap the wave, so the frame
     is treated as a fresh start. */
  var MAX_DT = 100;

  function clamp01(value) {
    var n = Number(value);
    if (!isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  /* Amplitude is linear RMS; loudness is not. The exponent lifts ordinary
     speech off the floor so the wave moves at conversational volume instead of
     only on a shout. */
  function shape(amplitude) {
    return FLOOR + (1 - FLOOR) * Math.pow(clamp01(amplitude), 0.65);
  }

  /**
   * Scrolling amplitude buffer. Pure: no DOM, no timers, no rAF — the tests
   * drive it directly with a synthetic clock.
   */
  function createWaveform(barCount) {
    var slots = new Array(barCount);
    var level = FLOOR;
    var target = FLOOR;
    var carry = 0;

    function reset() {
      for (var i = 0; i < barCount; i++) slots[i] = FLOOR;
      level = FLOOR;
      target = FLOOR;
      carry = 0;
    }

    reset();

    return {
      size: barCount,
      /** Newest sample from main. Amplitude is 0..1. */
      push: function (amplitude) {
        target = shape(amplitude);
      },
      /**
       * Advances by a frame delta in ms and returns the bar values, oldest
       * first. Exponential smoothing on a time constant rather than a fixed
       * per-frame fraction, so the shape does not depend on the refresh rate.
       *
       * Under prefers-reduced-motion the interpolation itself is skipped: the
       * level jumps straight to the latest sample instead of easing toward it
       * 60 times a second. tokens.css/base.css already stop every CSS
       * animation in the app this way, but the waveform is drawn by this
       * loop, not a keyframe, so the same intent has to be applied here by
       * hand. The bars still move — they are the primary "you are being
       * heard" signal in listening, not decoration — they just stop being
       * smoothed for smoothness's own sake.
       */
      advance: function (dtMs, reducedMotion) {
        var dt = dtMs > 0 ? Math.min(dtMs, MAX_DT) : 0;
        if (reducedMotion) {
          level = target;
        } else {
          var k = 1 - Math.exp(-dt / SMOOTH_MS);
          level += (target - level) * k;
        }

        carry += dt;
        var steps = Math.floor(carry / SLOT_MS);
        if (steps > 0) {
          carry -= steps * SLOT_MS;
          if (steps > barCount) steps = barCount;
          for (var i = 0; i < steps; i++) {
            slots.shift();
            slots.push(level);
          }
        }
        return slots;
      },
      values: function () {
        return slots.slice();
      },
      reset: reset,
    };
  }

  /**
   * Binds a waveform and the five states to a `.pill-stage` element.
   *
   * Options: { root, doc, raf, caf, bars }. The injectable clock and document
   * are what let tests run the real loop without a browser.
   */
  function createPill(options) {
    var opts = options || {};
    var stage = opts.root;
    if (!stage) throw new Error('createPill needs a root element');

    var doc = opts.doc || stage.ownerDocument || (typeof document !== 'undefined' ? document : null);
    var raf = opts.raf || function (cb) { return requestAnimationFrame(cb); };
    var caf = opts.caf || function (handle) { return cancelAnimationFrame(handle); };

    /* A function, not a snapshot: the OS setting can change while a dictation
       is in progress, same as the theme can. Tests inject a plain function;
       the browser default reads the live media query on every frame, which
       is cheap — matchMedia's own result is cached by the engine, this just
       reads .matches off it. */
    var reducedMotion = typeof opts.reducedMotion === 'function'
      ? opts.reducedMotion
      : function () {
          var view = doc && doc.defaultView;
          return Boolean(view && typeof view.matchMedia === 'function'
            && view.matchMedia('(prefers-reduced-motion: reduce)').matches);
        };

    var pill = stage.querySelector('[data-pill]');
    var wave = stage.querySelector('[data-pill-wave]');
    var text = stage.querySelector('[data-pill-text]');
    var announce = stage.querySelector('[data-pill-announce]');

    var waveform = createWaveform(opts.bars || BARS);
    var bars = [];
    for (var i = 0; i < waveform.size; i++) {
      var bar = doc.createElement('span');
      bar.className = 'pill-bar';
      bar.style.setProperty('--a', String(FLOOR));
      wave.appendChild(bar);
      bars.push(bar);
    }

    var state = 'idle-armed';
    var visible = false;    // entry/exit animation — is the pill on screen
    var rendering = true;   // is the window itself showing anything at all
    var frame = null;
    var lastTs = 0;
    var destroyed = false;

    function paint(values) {
      for (var i = 0; i < bars.length; i++) {
        bars[i].style.setProperty('--a', values[i].toFixed(3));
      }
    }

    /* The loop earns its existence only in `listening`, and only while the
       pill is both animated-in and on a window that is actually being drawn. */
    function shouldRun() {
      return !destroyed && rendering && visible && state === 'listening';
    }

    function tick(timestamp) {
      if (!shouldRun()) {
        frame = null;
        return;
      }
      var ts = typeof timestamp === 'number' ? timestamp : lastTs + SLOT_MS;
      var dt = lastTs ? ts - lastTs : SLOT_MS;
      lastTs = ts;
      paint(waveform.advance(dt, reducedMotion()));
      frame = raf(tick);
    }

    function sync() {
      if (shouldRun()) {
        if (frame === null) {
          lastTs = 0;
          frame = raf(tick);
        }
        return;
      }
      if (frame !== null) {
        caf(frame);
        frame = null;
      }
      lastTs = 0;
    }

    function setState(next, detail) {
      if (STATES.indexOf(next) === -1) {
        throw new Error('unknown pill state: ' + next);
      }
      var was = state;
      state = next;
      pill.setAttribute('data-state', state);

      var reason = detail && detail.reason ? String(detail.reason) : '';
      var label = state === 'error' && reason ? reason : LABELS[state];
      text.textContent = label;
      /* aria-live only fires on a change, and the visible text is empty for
         two of the five states, so the announcement lives in its own node. */
      if (announce) announce.textContent = LABELS[state] + (reason ? ': ' + reason : '');

      /* Entering `listening` starts from silence rather than from whatever the
         last dictation left in the buffer. */
      if (state === 'listening' && was !== 'listening') {
        waveform.reset();
        paint(waveform.values());
      }
      sync();
    }

    function setAmplitude(amplitude) {
      waveform.push(amplitude);
    }

    /** Entry (true) and exit (false) animation. 180ms, transform and opacity. */
    function setVisible(next) {
      visible = Boolean(next);
      stage.setAttribute('data-visible', visible ? 'true' : 'false');
      sync();
    }

    /**
     * Window-level visibility. False means the window is hidden or occluded:
     * cancel the frame, kill the CSS animations, park the bars. This is the
     * gate G4 contract.
     */
    function setRendering(next) {
      rendering = Boolean(next);
      stage.setAttribute('data-anim', rendering ? 'on' : 'off');
      if (!rendering) {
        waveform.reset();
        paint(waveform.values());
      }
      sync();
    }

    /* A hidden Electron window fires visibilitychange, so the renderer stops
       itself even if main never says a word. main sends the message anyway —
       two independent stops, because this is the one thing that must not be
       left running. */
    var onVisibilityChange = null;
    if (doc && typeof doc.addEventListener === 'function') {
      onVisibilityChange = function () { setRendering(!doc.hidden); };
      doc.addEventListener('visibilitychange', onVisibilityChange);
    }

    stage.setAttribute('data-visible', 'false');
    stage.setAttribute('data-anim', 'on');
    pill.setAttribute('data-state', state);
    text.textContent = LABELS[state];

    return {
      setState: setState,
      setAmplitude: setAmplitude,
      setVisible: setVisible,
      setRendering: setRendering,
      state: function () { return state; },
      /** Test and demo seam — the values currently on the bars. */
      bars: function () {
        return bars.map(function (el) { return Number(el.style.getPropertyValue('--a')); });
      },
      isRunning: function () { return frame !== null; },
      destroy: function () {
        destroyed = true;
        sync();
        if (onVisibilityChange) doc.removeEventListener('visibilitychange', onVisibilityChange);
      },
    };
  }

  return {
    STATES: STATES,
    LABELS: LABELS,
    BARS: BARS,
    FLOOR: FLOOR,
    createPill: createPill,
    createWaveform: createWaveform,
  };
});
