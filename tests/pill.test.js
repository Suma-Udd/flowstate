/**
 * Issue #11 — the recording pill.
 *
 * The pill is the most-seen surface in the app and the one nobody will be
 * looking at directly, so the properties that matter are exactly the ones an
 * eyeball review will not catch:
 *
 *   1. Token discipline, the same rules tests/mockups.test.js applies to the
 *      screens: no colour literals, no raw lengths or durations, no shadow, and
 *      nothing animated but transform and opacity.
 *   2. Five states, all of them wired end to end — CSS rule, markup hook,
 *      controller label, demo button.
 *   3. The animation loop's lifecycle. "Zero CPU when hidden" is the hard rule
 *      of this issue and the single easiest way to fail gate G4, so the loop is
 *      driven here with a synthetic clock rather than trusted.
 *   4. The window is an indicator, not a window: click-through, no taskbar
 *      entry, never focusable, and placed where the design says.
 *
 * No dependencies — the allowlist in the engine notes is closed. The DOM the
 * controller talks to is small enough to fake, which is why pill.js takes its
 * document, rAF and cancel as options.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PILL_DIR = path.join(ROOT, 'src', 'renderer', 'pill');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const PILL_CSS = read(PILL_DIR, 'pill.css');
const PILL_HTML = read(PILL_DIR, 'pill.html');
const DEMO_HTML = read(PILL_DIR, 'demo.html');
const PILL_JS = read(PILL_DIR, 'pill.js');
const WINDOWS_JS = read(ROOT, 'src', 'main', 'windows.js');
const PILL_PRELOAD = read(ROOT, 'src', 'main', 'pill-preload.js');

const FlowPill = require(path.join(PILL_DIR, 'pill.js'));
const { createWindowManager, PILL } = require(path.join(ROOT, 'src', 'main', 'windows.js'));

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function styleBlocks(html) {
  return (html.match(/<style>([\s\S]*?)<\/style>/g) || [])
    .map((block) => block.replace(/^<style>|<\/style>$/g, ''))
    .join('\n');
}

const CSS_SOURCES = [
  ['pill.css', PILL_CSS],
  ['demo.html <style>', styleBlocks(DEMO_HTML)],
];

/* ---------------------------------------------------------------------------
   1. Token discipline
   --------------------------------------------------------------------------- */

test('the pill uses no colour literals', () => {
  for (const [name, css] of CSS_SOURCES) {
    const clean = stripComments(css);
    const hex = clean.match(/#[0-9A-Fa-f]{3,8}\b/g) || [];
    assert.deepEqual(hex, [], `${name} contains colour literals: ${hex.join(', ')}`);

    const built = clean.match(/\b(?:rgba?|hsla?|oklch|lab|color-mix)\s*\(/g) || [];
    assert.deepEqual(built, [], `${name} builds colours inline: ${built.join(', ')}`);
  }

  // A hex in an inline style attribute or a JS string would slip past the
  // stylesheet sweep above, so the documents and the controller go too.
  for (const [name, source] of [
    ['pill.html', PILL_HTML],
    ['demo.html', DEMO_HTML],
    ['pill.js', PILL_JS],
  ]) {
    const clean = source.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hex = clean.match(/#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\b/g) || [];
    assert.deepEqual(hex, [], `${name} contains colour literals: ${hex.join(', ')}`);
  }
});

test('the pill hardcodes no lengths or durations', () => {
  // Every dimension the pill needs that the token scale does not carry — the
  // 56px body, the 3px bar, the 1.5s pulse — is derived with calc() over
  // tokens in the --pill-* block at the top of pill.css.
  for (const [name, css] of CSS_SOURCES) {
    const clean = stripComments(css).replace(/@media[^{]*/g, '@media ');
    const hits = clean.match(/(?<![\w-])\d*\.?\d+(?:px|ms|s)\b/g) || [];
    assert.deepEqual(hits, [], `${name} hardcodes lengths or durations: ${hits.join(', ')}`);
  }
});

test('rem appears only as a grid or box floor', () => {
  for (const [name, css] of CSS_SOURCES) {
    const clean = stripComments(css)
      .replace(/minmax\([^)]*\)/g, 'minmax()')
      .replace(/min-height:\s*\d+(?:\.\d+)?rem/g, 'min-height: floor'); // demo backdrops
    const hits = clean.match(/\d+(?:\.\d+)?rem\b/g) || [];
    assert.deepEqual(hits, [], `${name} uses rem as spacing: ${hits.join(', ')}`);
  }
});

test('the pill introduces no box-shadow', () => {
  // Elevation is --surface against whatever is behind it, plus a hairline. The
  // pill floats over the user's document, which is exactly where a shadow would
  // be most tempting and most wrong.
  for (const [name, source] of [...CSS_SOURCES, ['pill.html', PILL_HTML], ['demo.html', DEMO_HTML]]) {
    const shadows = (source.match(/box-shadow\s*:\s*([^;]+);/g) || [])
      .filter((declaration) => !/:\s*none\s*;/.test(declaration));
    assert.deepEqual(shadows, [], `${name} sets a box-shadow: ${shadows.join(', ')}`);
  }
});

test('only transform and opacity are animated', () => {
  const ALLOWED = new Set([
    'transform', 'opacity', 'color', 'background-color', 'border-color',
    'outline-color', 'text-decoration-color', 'stroke', 'fill', 'none',
  ]);

  for (const [name, css] of CSS_SOURCES) {
    const clean = stripComments(css);

    for (const [, value] of clean.matchAll(/transition\s*:\s*([^;]+);/g)) {
      for (const part of value.split(',')) {
        const property = part.trim().split(/\s+/)[0];
        assert.ok(ALLOWED.has(property), `${name} transitions "${property}"`);
      }
    }

    // Keyframes are the pill's own contribution and get the same rule: a
    // shimmer that animated width or left would jank over a live document.
    for (const [, body] of clean.matchAll(/@keyframes[^{]+\{([\s\S]*?)\n\}/g)) {
      for (const [, property] of body.matchAll(/(?<![\w-])([a-z-]+)\s*:/g)) {
        assert.ok(
          property === 'transform' || property === 'opacity',
          `${name} animates "${property}" in a keyframe`
        );
      }
    }
  }
});

test('the pill window has no theme flash', () => {
  for (const [name, html] of [['pill.html', PILL_HTML], ['demo.html', DEMO_HTML]]) {
    const script = html.indexOf('data-theme');
    const firstLink = html.indexOf('<link rel="stylesheet"');
    assert.notEqual(script, -1, `${name} has no inline theme script`);
    assert.ok(script < firstLink, `${name}: the theme script must run before the stylesheets`);
  }

  const order = ['tokens.css', 'base.css', 'pill.css'].map((file) => PILL_HTML.indexOf(file));
  assert.ok(order.every((at) => at !== -1), 'pill.html is missing a stylesheet');
  assert.ok(order[1] > order[0] && order[2] > order[1], 'pill.html loads its stylesheets out of order');
});

/* ---------------------------------------------------------------------------
   2. Five states, wired end to end
   --------------------------------------------------------------------------- */

test('all five states exist in the CSS, the markup and the controller', () => {
  assert.deepEqual(FlowPill.STATES, ['idle-armed', 'listening', 'thinking', 'pasting', 'error']);

  for (const state of FlowPill.STATES) {
    assert.match(PILL_CSS, new RegExp(`\\[data-state='${state}'\\]`), `pill.css has no rule for ${state}`);
    assert.ok(FlowPill.LABELS[state], `${state} has no label`);
  }

  // Every glyph and body variant the CSS selects has to exist in both
  // documents, or a state renders as an empty pill.
  const hooks = [...PILL_CSS.matchAll(/\[data-(glyph|body)='([a-z]+)'\]/g)]
    .map(([, group, value]) => `data-${group}="${value}"`);
  assert.ok(hooks.length >= 5, 'expected a hook per glyph and body variant');

  for (const hook of new Set(hooks)) {
    assert.ok(PILL_HTML.includes(hook), `pill.html is missing ${hook}`);
    assert.ok(DEMO_HTML.includes(hook), `demo.html is missing ${hook}`);
  }
});

test('demo.html cycles every state, hidden included', () => {
  // The definition of done for this issue is demo.html cycling all five states
  // without the engine, so the cycle is checked rather than assumed.
  const cycle = /var CYCLE = \[([\s\S]*?)\];/.exec(DEMO_HTML);
  assert.ok(cycle, 'demo.html has no CYCLE');
  for (const state of FlowPill.STATES.concat('hidden')) {
    assert.match(cycle[1], new RegExp(`state: '${state}'`), `the demo cycle never reaches ${state}`);
  }
});

test('the error state always carries a reason', () => {
  // "error: --danger with a one-line reason — always say what."
  const pill = mountPill();
  pill.setState('error', { reason: 'Microphone unavailable' });
  assert.equal(pill.text.textContent, 'Microphone unavailable');
  assert.match(pill.announce.textContent, /Microphone unavailable/);

  // With no reason the state still has to say something rather than render an
  // empty pill.
  pill.setState('error');
  assert.equal(pill.text.textContent, FlowPill.LABELS.error);
});

test('an unknown state is refused rather than rendered', () => {
  const pill = mountPill();
  assert.throws(() => pill.setState('recording'), /unknown pill state/);
  assert.equal(pill.state(), 'idle-armed', 'a refused state must not move the pill');
});

/* ---------------------------------------------------------------------------
   3. The animation loop — "zero CPU when hidden"
   --------------------------------------------------------------------------- */

/**
 * The smallest DOM the controller actually touches. Faking it rather than
 * pulling in a DOM library keeps the allowlist closed and keeps the test
 * honest about how little the pill needs from the document.
 */
function fakeDom() {
  const listeners = new Map();

  const element = (attrs = {}) => {
    const props = new Map();
    return {
      attrs: { ...attrs },
      children: [],
      textContent: '',
      className: '',
      style: {
        setProperty: (key, value) => props.set(key, value),
        getPropertyValue: (key) => props.get(key) ?? '',
      },
      setAttribute(key, value) { this.attrs[key] = String(value); },
      getAttribute(key) { return this.attrs[key] ?? null; },
      appendChild(child) { this.children.push(child); return child; },
    };
  };

  const pill = element({ 'data-pill': '' });
  const wave = element({ 'data-pill-wave': '' });
  const text = element({ 'data-pill-text': '' });
  const announce = element({ 'data-pill-announce': '' });

  const nodes = {
    '[data-pill]': pill,
    '[data-pill-wave]': wave,
    '[data-pill-text]': text,
    '[data-pill-announce]': announce,
  };

  const stage = element();
  stage.querySelector = (selector) => nodes[selector] ?? null;

  const doc = {
    hidden: false,
    createElement: () => element(),
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    /** Flips document visibility the way Electron does when a window hides. */
    setHidden(value) {
      this.hidden = value;
      const fn = listeners.get('visibilitychange');
      if (fn) fn();
    },
  };
  stage.ownerDocument = doc;

  return { stage, pill, wave, text, announce, doc };
}

/** A pill on a synthetic clock: frames only advance when the test says so. */
function mountPill(options = {}) {
  const dom = fakeDom();
  let next = 1;
  const queued = new Map();

  const raf = (cb) => {
    const handle = next++;
    queued.set(handle, cb);
    return handle;
  };
  const caf = (handle) => queued.delete(handle);

  const pill = FlowPill.createPill({ root: dom.stage, doc: dom.doc, raf, caf, ...options });

  let clock = 0;
  return Object.assign(pill, dom, {
    /** Runs `count` frames of ~16ms each. Returns how many actually ran. */
    frames(count = 1, stepMs = 16) {
      let ran = 0;
      for (let i = 0; i < count; i++) {
        const pending = [...queued.entries()];
        if (pending.length === 0) break;
        queued.clear();
        clock += stepMs;
        for (const [, cb] of pending) cb(clock);
        ran++;
      }
      return ran;
    },
    pendingFrames: () => queued.size,
  });
}

test('the loop runs only while listening', () => {
  const pill = mountPill();
  pill.setVisible(true);

  for (const state of ['idle-armed', 'thinking', 'pasting', 'error']) {
    pill.setState(state);
    assert.equal(pill.isRunning(), false, `the loop is running in ${state}`);
  }

  pill.setState('listening');
  assert.equal(pill.isRunning(), true, 'the loop is not running while listening');

  pill.setState('thinking');
  assert.equal(pill.isRunning(), false, 'the loop survived leaving listening');
  assert.equal(pill.pendingFrames(), 0, 'a frame is still queued after the loop stopped');
});

test('hiding the window stops the loop and stills the CSS', () => {
  const pill = mountPill();
  pill.setVisible(true);
  pill.setState('listening');
  pill.setAmplitude(0.9);
  pill.frames(8);
  assert.equal(pill.isRunning(), true);

  // Two independent stops, because this is the one thing that must not be left
  // running: main's explicit message, and the document's own visibilitychange.
  pill.setRendering(false);
  assert.equal(pill.isRunning(), false, 'the loop survived the window being hidden');
  assert.equal(pill.pendingFrames(), 0, 'a frame is still queued against a hidden window');
  assert.equal(pill.stage.getAttribute('data-anim'), 'off', 'the CSS animations were left running');
  assert.deepEqual(
    pill.bars().filter((value) => value !== FlowPill.FLOOR),
    [],
    'the bars were left mid-wave on a hidden window'
  );

  pill.setRendering(true);
  assert.equal(pill.isRunning(), true, 'the loop did not restart when the window came back');
  assert.equal(pill.stage.getAttribute('data-anim'), 'on');
});

test('the document going hidden stops the loop on its own', () => {
  const pill = mountPill();
  pill.setVisible(true);
  pill.setState('listening');
  assert.equal(pill.isRunning(), true);

  pill.doc.setHidden(true);
  assert.equal(pill.isRunning(), false, 'visibilitychange did not stop the loop');

  pill.doc.setHidden(false);
  assert.equal(pill.isRunning(), true, 'visibilitychange did not restart the loop');
});

test('an exited pill does not animate', () => {
  // Between dictations the pill is animated out but the window may still exist
  // for a few seconds. Nothing may tick in that gap.
  const pill = mountPill();
  pill.setVisible(true);
  pill.setState('listening');
  assert.equal(pill.isRunning(), true);

  pill.setVisible(false);
  assert.equal(pill.isRunning(), false, 'the loop kept running after the pill animated out');
});

test('reduced motion still runs the loop, just without the easing', () => {
  // The loop itself is not the thing reduced-motion turns off — see
  // pill.css's data-anim="off" for the case that is (a hidden window). Here
  // the pill is genuinely listening and must keep drawing the wave; only the
  // per-frame smoothing toward each sample is skipped.
  const pill = mountPill({ reducedMotion: () => true });
  pill.setVisible(true);
  pill.setState('listening');
  pill.setAmplitude(1);
  pill.frames(1);

  assert.equal(pill.isRunning(), true, 'reduced motion stopped the loop entirely');
  const peak = Math.max(...pill.bars());
  assert.ok(peak > 0.99, 'reduced motion left the bar easing toward the sample instead of on it');
});

test('destroy stops everything', () => {
  const pill = mountPill();
  pill.setVisible(true);
  pill.setState('listening');
  pill.destroy();
  assert.equal(pill.isRunning(), false);
  assert.equal(pill.frames(3), 0, 'frames still ran after destroy');
});

/* ---------------------------------------------------------------------------
   The waveform itself
   --------------------------------------------------------------------------- */

test('the waveform interpolates between 30Hz samples instead of stepping', () => {
  // "Interpolate between samples; do not step." At 30Hz a sample lands every
  // ~33ms while the bars are drawn every ~16ms, so a stepped wave would show
  // the same value twice and read as a bar chart being nudged.
  const wave = FlowPill.createWaveform(8);
  wave.push(1);

  const first = wave.advance(16).slice(-1)[0];
  const second = wave.advance(16).slice(-1)[0];

  assert.ok(first > FlowPill.FLOOR, 'the first frame did not move at all');
  assert.ok(second > first, 'the second frame did not continue toward the sample');
  assert.ok(first < 1, 'the first frame jumped straight to the sample');
});

test('prefers-reduced-motion skips the interpolation, not the signal', () => {
  // Issue #20: the wave is the primary "you are being heard" indicator in
  // listening, so reduced motion must not blank it — only the 60fps easing
  // toward each sample, which is motion for its own sake, goes away.
  const eased = FlowPill.createWaveform(8);
  eased.push(1);
  const easedFirst = eased.advance(16).slice(-1)[0];

  const reduced = FlowPill.createWaveform(8);
  reduced.push(1);
  const reducedFirst = reduced.advance(16, true).slice(-1)[0];

  assert.ok(reducedFirst > easedFirst,
    'a reduced-motion frame eased toward the sample instead of jumping to it');
  assert.ok(reducedFirst > 0.99, 'a reduced-motion frame did not land on the sample');
  assert.ok(reducedFirst <= 1, 'a reduced-motion frame overshot the sample');
});

test('the waveform scrolls on elapsed time, not on frame count', () => {
  // A 144Hz monitor must not scroll the wave 2.4x faster than a 60Hz one.
  const slow = FlowPill.createWaveform(24);
  const fast = FlowPill.createWaveform(24);

  slow.push(1);
  fast.push(1);
  slow.advance(96);                                  // one long frame
  for (let i = 0; i < 6; i++) fast.advance(16);      // six short ones

  const moved = (wave) => wave.values().filter((value) => value > FlowPill.FLOOR).length;
  assert.equal(moved(slow), moved(fast), 'the wave scrolled a different distance for the same time');
});

test('a parked loop does not snap the waveform when it resumes', () => {
  // A frame delta of several seconds means the window was occluded or the
  // machine slept. Interpolating across it would fling the bars.
  const wave = FlowPill.createWaveform(24);
  wave.push(1);
  const after = wave.advance(5000);
  assert.ok(after.every((value) => value <= 1), 'a long frame pushed a bar past full scale');
  assert.ok(
    after.filter((value) => value > FlowPill.FLOOR).length <= 24,
    'a long frame scrolled further than the buffer'
  );
});

test('amplitude is clamped and silence still draws a line', () => {
  const wave = FlowPill.createWaveform(4);

  wave.push(-3);
  wave.advance(64);
  assert.ok(wave.values().every((value) => value >= FlowPill.FLOOR), 'a negative sample went under the floor');

  wave.push(12);
  for (let i = 0; i < 30; i++) wave.advance(16);
  assert.ok(wave.values().every((value) => value <= 1), 'an out-of-range sample went over full scale');

  wave.push(NaN);
  wave.advance(16);
  assert.ok(wave.values().every((value) => Number.isFinite(value)), 'a bad sample poisoned the buffer');
});

test('entering listening starts from silence', () => {
  const pill = mountPill();
  pill.setVisible(true);
  pill.setState('listening');
  pill.setAmplitude(1);
  pill.frames(20);
  assert.ok(pill.bars().some((value) => value > FlowPill.FLOOR), 'the wave never moved');

  pill.setState('thinking');
  pill.setState('listening');
  assert.deepEqual(
    pill.bars().filter((value) => value !== FlowPill.FLOOR),
    [],
    'the next dictation started with the last one still on screen'
  );
});

test('the bars are written as a transform scale, never a height', () => {
  const pill = mountPill({ bars: 6 });
  pill.setVisible(true);
  pill.setState('listening');
  pill.setAmplitude(0.8);
  pill.frames(10);

  assert.equal(pill.wave.children.length, 6, 'the wave has the wrong number of bars');

  // A bar is a full-height box scaled on transform. Sizing one by its height
  // would lay out the whole wave on every frame of every dictation.
  const rule = /\.pill-bar\s*\{([^}]*)\}/.exec(stripComments(PILL_CSS));
  assert.ok(rule, 'pill.css has no .pill-bar rule');
  assert.match(rule[1], /transform:\s*scaleY\(var\(--a/, 'the bars are not scaled on transform');
  assert.match(rule[1], /height:\s*100%\s*;/, 'a bar is sized by something other than a full-height box');
});

/* ---------------------------------------------------------------------------
   4. The window is an indicator, not a window
   --------------------------------------------------------------------------- */

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.calls = [];
    this.visible = false;
    this.destroyed = false;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.sent = [];
    this.listeners = new Map();
    this.webContents = {
      send: (channel, payload) => this.sent.push([channel, payload]),
      once: (event, fn) => this.listeners.set(`wc:${event}`, fn),
    };
  }

  setIgnoreMouseEvents(value) { this.calls.push(['setIgnoreMouseEvents', value]); }
  setAlwaysOnTop(value, level) { this.calls.push(['setAlwaysOnTop', value, level]); }
  setBounds(bounds) { this.bounds = bounds; }
  showInactive() { this.visible = true; this.calls.push(['showInactive']); }
  show() { this.visible = true; this.calls.push(['show']); }
  focus() { this.calls.push(['focus']); }
  hide() { this.visible = false; this.calls.push(['hide']); }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; const fn = this.listeners.get('closed'); if (fn) fn(); }
  once(event, fn) { this.listeners.set(event, fn); }
  removeMenu() {}
  loadURL() { return Promise.resolve(); }
  /** Simulates the renderer finishing its first load. */
  finishLoad() { const fn = this.listeners.get('wc:did-finish-load'); if (fn) fn(); }
}

/* A 1920x1080 primary display with a 40px taskbar at the bottom, and a second
   display to the left with a negative origin — the arrangement that catches
   naive "centre on the primary" placement. */
const DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const LEFT_DISPLAY = { workArea: { x: -1280, y: 0, width: 1280, height: 984 } };

function mountManager({ display = DISPLAY } = {}) {
  const created = [];
  const pending = [];

  const manager = createWindowManager({
    BrowserWindow: class {
      constructor(options) {
        const window = new FakeWindow(options);
        created.push(window);
        return window;
      }
    },
    screen: {
      getCursorScreenPoint: () => ({ x: display.workArea.x + 10, y: 10 }),
      getDisplayNearestPoint: () => display,
      getPrimaryDisplay: () => DISPLAY,
    },
    timers: {
      setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; },
      clearTimeout: (handle) => { if (handle) pending[handle - 1] = null; },
    },
  });

  return {
    manager,
    created,
    pill: () => created[created.length - 1],
    /** Fires every timer main is currently waiting on. */
    runTimers() {
      const due = pending.filter(Boolean);
      pending.length = 0;
      for (const timer of due) timer.fn();
      return due.length;
    },
  };
}

test('the pill window never appears in the taskbar and never takes focus', () => {
  const { manager, pill } = mountManager();
  manager.showPill('listening');
  const window = pill();

  assert.equal(window.options.frame, false, 'the pill has a frame');
  assert.equal(window.options.transparent, true, 'the pill is not transparent');
  assert.equal(window.options.skipTaskbar, true, 'the pill would show in the taskbar');
  assert.equal(window.options.focusable, false, 'the pill can take focus');
  assert.equal(window.options.alwaysOnTop, true, 'the pill is not always on top');
  assert.equal(window.options.hasShadow, false, 'the pill has a shadow');
  assert.equal(window.options.resizable, false);

  assert.deepEqual(
    window.calls.filter(([name]) => name === 'setIgnoreMouseEvents'),
    [['setIgnoreMouseEvents', true]],
    'the pill is not click-through'
  );
  assert.ok(
    window.calls.some(([name]) => name === 'showInactive'),
    'the pill was shown with show(), which steals focus'
  );
  assert.ok(
    !window.calls.some(([name]) => name === 'show' || name === 'focus'),
    'the pill called show() or focus()'
  );

  const { webPreferences } = window.options;
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.sandbox, true);
  assert.match(webPreferences.preload, /pill-preload\.js$/, 'the pill loads the GUI preload');
});

test('the pill sits bottom-centre, 80px above the taskbar', () => {
  const { manager } = mountManager();
  const bounds = manager.pillBounds();

  assert.equal(bounds.x, Math.round((1920 - PILL.width) / 2), 'the pill is not horizontally centred');
  // The window is taller than the pill so the entry animation has room, so it
  // is the pill's own bottom edge that has to land 80px above the taskbar.
  const pillBottom = bounds.y + bounds.height - PILL.inset;
  assert.equal(pillBottom, 1040 - PILL.gap, 'the pill is not 80px above the taskbar');
  assert.equal(PILL.gap, 80);
});

test('the pill follows the display the user is working on', () => {
  const { manager } = mountManager({ display: LEFT_DISPLAY });
  const bounds = manager.pillBounds();
  assert.equal(bounds.x, Math.round(-1280 + (1280 - PILL.width) / 2));
  assert.equal(bounds.y + bounds.height - PILL.inset, 984 - PILL.gap);
});

test('the window inset agrees with the CSS', () => {
  // windows.js places the window so that --pill-inset puts the pill exactly
  // --gap above the taskbar. If the CSS moves and this does not, the pill
  // drifts and nobody notices until gate G2.
  assert.match(PILL_CSS, /--pill-inset:\s*var\(--sp-4\)/, 'pill.css changed --pill-inset');
  assert.equal(PILL.inset, 16, 'PILL.inset no longer matches --sp-4');
  assert.match(PILL_CSS, /padding:\s*0 var\(--sp-4\) var\(--pill-inset\)/,
    'the stage no longer uses --pill-inset as its bottom padding');
});

test('state and visibility survive the renderer still loading, amplitude does not', () => {
  const { manager, pill } = mountManager();
  manager.showPill('listening');
  const window = pill();

  // Nothing can be sent before did-finish-load; Electron drops it silently.
  assert.deepEqual(window.sent, [], 'main sent to a renderer that had not loaded');

  manager.pushPillAmplitude(0.5);
  window.finishLoad();

  const channels = window.sent.map(([channel]) => channel);
  assert.deepEqual(channels, ['pill:state', 'pill:visibility'],
    'the queue replayed the wrong messages');
  assert.deepEqual(window.sent[0][1], { state: 'listening', reason: undefined });
  assert.equal(window.sent[1][1], true);

  manager.pushPillAmplitude(0.5);
  assert.equal(window.sent.length, 3, 'amplitude is not flowing once the renderer is up');
});

test('hiding plays the exit animation before the window goes', () => {
  const { manager, pill, runTimers } = mountManager();
  manager.showPill('pasting');
  const window = pill();
  window.finishLoad();

  manager.hidePill();
  assert.equal(window.isVisible(), true, 'the window was hidden before the exit animation ran');
  assert.deepEqual(window.sent.slice(-1)[0], ['pill:visibility', false]);

  runTimers(); // the exit timer
  assert.equal(window.isVisible(), false, 'the window never hid');
  assert.equal(window.isDestroyed(), false, 'the window was destroyed instead of hidden');

  runTimers(); // the idle-destroy timer
  assert.equal(window.isDestroyed(), true, 'a hidden pill was left alive at idle');
  assert.equal(manager.isPillOpen(), false);
});

test('a burst of dictations reuses the window instead of rebuilding it', () => {
  // Window creation on every key-down would put a stutter on the most-seen
  // surface in the app, which is the whole reason the pill is allowed to be
  // hidden rather than destroyed between dictations.
  const { manager, created, runTimers } = mountManager();
  manager.showPill('listening');
  created[0].finishLoad();

  manager.hidePill();
  runTimers();              // exit → hide, and the idle-destroy timer is armed
  manager.showPill('listening');

  assert.equal(created.length, 1, 'the pill window was rebuilt mid-burst');
  assert.equal(created[0].isVisible(), true);

  runTimers();
  assert.equal(created[0].isDestroyed(), false, 'showing the pill did not cancel the destroy timer');
});

test('destroyAll takes the pill with it', () => {
  const { manager, pill } = mountManager();
  manager.showPill('listening');
  const window = pill();
  manager.destroyAll();
  assert.equal(window.isDestroyed(), true, 'quitting left the pill window behind');
});

/* ---------------------------------------------------------------------------
   The bridge
   --------------------------------------------------------------------------- */

test('the pill bridge is one-way', () => {
  // The pill draws five states and has nothing to say back. Nothing in its
  // preload may give the overlay renderer a way to call into main.
  assert.ok(!/ipcRenderer\.(?:invoke|send|sendSync|postMessage)/.test(PILL_PRELOAD),
    'pill-preload.js exposes a way to send to main');
  assert.match(PILL_PRELOAD, /Object\.freeze/, 'the pill bridge is mutable');
  assert.ok(!/nodeIntegration:\s*true/.test(WINDOWS_JS), 'a window enables nodeIntegration');

  // And the renderer half sends nothing either.
  assert.ok(!/flowPill\.(?:send|invoke)/.test(read(PILL_DIR, 'pill.html')),
    'pill.html calls back into main');
});
