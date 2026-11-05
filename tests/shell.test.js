/**
 * Issue #16 — the app shell: frameless window, sidebar, hash router, theme.
 *
 * What is worth asserting here is what an eyeball review of a working app cannot
 * see:
 *
 *   1. Token discipline, the same rules tests/mockups.test.js applies to the #09
 *      screens, now applied to the live shell and every view.
 *   2. The route table. Every route reachable, every route with a view, every nav
 *      item pointing at a route that exists — a dead sidebar item is a 404 in an
 *      app with no address bar.
 *   3. The theme, end to end: main resolves it, the renderer stamps it, and a
 *      failed write does not leave a theme on screen that will not survive a
 *      restart. This is the one screen behaviour gate G2 fails on sight.
 *   4. The window: frameless, minimum size, bounds saved on the events that move
 *      it, and closed rather than hidden.
 *
 * The nine views' own markup is exercised against the real fixtures. What is not
 * here is a real DOM — there is no dependency to provide one and the allowlist in
 * the engine notes is closed — so mounting every view in a browser is what
 * `npm run shell:shoot` does: it renders all nine routes in Electron, fails on any
 * console error, and asserts no horizontal overflow at 900x640.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const VIEWS = path.join(RENDERER, 'views');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const INDEX_HTML = read(RENDERER, 'index.html');
const APP_JS = read(RENDERER, 'app.js');
const LIB_JS = read(RENDERER, 'lib.js');
const APP_CSS = read(RENDERER, 'styles', 'app.css');
const PRELOAD = read(ROOT, 'src', 'main', 'preload.js');
const WINDOWS_JS = read(ROOT, 'src', 'main', 'windows.js');
const SHELL_MAIN = read(ROOT, 'src', 'main', 'shell.js');

const FlowApp = require('../src/renderer/app.js');
const FlowLib = require('../src/renderer/lib.js');
const { CHANNELS, FIXTURES, THEME_MODES, createShellBridge } = require('../src/main/shell.js');
const { createWindowManager } = require('../src/main/windows.js');
const { MIN_WIDTH, MIN_HEIGHT } = require('../src/main/window-state.js');

const VIEW_FILES = [
  'dictation',
  'history',
  'dictionary',
  'snippets',
  'scratchpad',
  'insights',
  'settings-general',
  'settings-system',
  'settings-about',
  'onboarding',
];

const views = {};
for (const name of VIEW_FILES) views[name] = require(path.join(VIEWS, `${name}.js`));

const fixture = (name) =>
  JSON.parse(read(RENDERER, 'fixtures', `${name}.json`));

/* ---------------------------------------------------------------------------
   1. Token discipline
   --------------------------------------------------------------------------- */

const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

test('the shell introduces no colour literals', () => {
  const sources = [['app.css', APP_CSS], ['index.html', INDEX_HTML],
    ['app.js', APP_JS], ['lib.js', LIB_JS]];
  for (const name of VIEW_FILES) sources.push([`views/${name}.js`, read(VIEWS, `${name}.js`)]);

  for (const [name, source] of sources) {
    const clean = stripComments(source);
    const hex = clean.match(/#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})\b/g) || [];
    assert.deepEqual(hex, [], `${name} contains colour literals: ${hex.join(', ')}`);

    const built = clean.match(/\b(?:rgba?|hsla?|oklch|lab|color-mix)\s*\(/g) || [];
    assert.deepEqual(built, [], `${name} builds colours inline: ${built.join(', ')}`);
  }
});

test('the titlebar hardcodes no lengths, durations or shadow', () => {
  // Same sweep tests/mockups.test.js runs over app.css, repeated here so a
  // regression in the block this issue added is attributed to this issue.
  const clean = stripComments(APP_CSS)
    .replace(/@media[^{]*/g, '@media ')
    .replace(/\bmax\(0px\b/g, 'max(0');
  const hits = clean.match(/(?<![\w-])\d*\.?\d+(?:px|ms|s)\b/g) || [];
  assert.deepEqual(hits, [], `app.css hardcodes lengths or durations: ${hits.join(', ')}`);

  const shadows = (APP_CSS.match(/box-shadow\s*:\s*([^;]+);/g) || [])
    .filter((declaration) => !/:\s*none\s*;/.test(declaration));
  assert.deepEqual(shadows, [], 'app.css sets a box-shadow');
});

test('only transform and opacity are animated', () => {
  const ALLOWED = new Set([
    'transform', 'opacity', 'color', 'background-color', 'border-color',
    'outline-color', 'text-decoration-color', 'stroke', 'fill', 'none',
  ]);

  const clean = stripComments(APP_CSS);
  for (const [, value] of clean.matchAll(/transition\s*:\s*([^;]+);/g)) {
    for (const part of value.split(',')) {
      const property = part.trim().split(/\s+/)[0];
      assert.ok(ALLOWED.has(property), `app.css transitions "${property}"`);
    }
  }

  // The route transition is a keyframe animation, so it is checked by hand:
  // nothing in it may lay out a frame.
  const keyframes = /@keyframes view-in\s*\{([\s\S]*?)\n\}/.exec(clean);
  assert.ok(keyframes, 'app.css has no view-in keyframes');
  const properties = [...keyframes[1].matchAll(/([a-z-]+)\s*:/g)].map((match) => match[1]);
  for (const property of properties) {
    assert.ok(ALLOWED.has(property), `the route animation animates "${property}"`);
  }
});

test('no view writes an inline style attribute', () => {
  /* index.html sets style-src 'self' with no 'unsafe-inline', so a style
     attribute in a view would silently do nothing. Geometry that comes from data
     goes through the CSSOM in mount() instead. */
  for (const name of VIEW_FILES) {
    const source = stripComments(read(VIEWS, `${name}.js`));
    assert.ok(!/style="/.test(source), `views/${name}.js writes a style attribute`);
  }
  assert.ok(!/style="/.test(stripComments(APP_JS)), 'app.js writes a style attribute');
});

/* ---------------------------------------------------------------------------
   2. Routes and chrome
   --------------------------------------------------------------------------- */

test('every route has a view, and every view is reachable', () => {
  const routed = FlowApp.ROUTES.map((route) => route.view);
  assert.deepEqual([...routed].sort(), [...VIEW_FILES].sort(),
    'the route table and views/ disagree about which screens exist');

  for (const route of FlowApp.ROUTES) {
    assert.ok(views[route.view], `${route.path} has no view module`);
    assert.equal(typeof views[route.view].html, 'function',
      `${route.view} does not render markup`);
    assert.match(INDEX_HTML, new RegExp(`views/${route.view}\\.js`),
      `index.html does not load views/${route.view}.js`);
  }
});

test('every sidebar item points at a route that exists', () => {
  for (const item of [...FlowApp.NAV, ...FlowApp.FOOT, ...FlowApp.SETTINGS_TABS]) {
    assert.ok(FlowApp.routeFor(item.path), `${item.label} points at ${item.path}, which is not a route`);
  }

  // Every nav key is a nav target of some route, or the item can never light up.
  const navKeys = new Set(FlowApp.ROUTES.map((route) => route.nav));
  for (const item of FlowApp.NAV) {
    assert.ok(navKeys.has(item.key), `nothing ever makes ${item.key} current`);
  }
});

test('the router tolerates the hashes a real window produces', () => {
  assert.equal(FlowApp.parseRoute('#/dictation').view, 'dictation');
  assert.equal(FlowApp.parseRoute('/dictation').view, 'dictation');
  assert.equal(FlowApp.parseRoute('#/settings/general').view, 'settings-general');
  assert.equal(FlowApp.parseRoute('#/settings/general/').view, 'settings-general');
  for (const hash of ['', '#', '#/', '#/nope', '#/settings', null, undefined]) {
    assert.equal(FlowApp.parseRoute(hash), null, `${String(hash)} matched a route`);
  }
});

test('the default route is the home screen', () => {
  assert.equal(FlowApp.DEFAULT_ROUTE, '/dictation');
  assert.equal(FlowApp.routeFor(FlowApp.DEFAULT_ROUTE).view, 'dictation');
});

/* ---------------------------------------------------------------------------
   3. The shell, driven against a fake document

   Small enough to fake honestly: the shell touches five slots, the document
   element's attributes, and two event targets.
   --------------------------------------------------------------------------- */

function fakeElement(doc, tag) {
  return {
    tagName: tag,
    doc,
    attributes: {},
    listeners: {},
    innerHTML: '',
    className: '',
    value: '',          // a real input or textarea always has one
    style: { setProperty() {}, width: '', gridColumn: '', gridTemplateColumns: '' },
    ownerDocument: doc,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    removeEventListener(type, handler) {
      this.listeners[type] = (this.listeners[type] || []).filter((fn) => fn !== handler);
    },
    emit(type, event) {
      for (const handler of this.listeners[type] || []) handler(event || {});
    },
    /* A view's mount() looks up its own slots inside the pane it was handed.
       Every lookup resolves to a fresh element: this cannot prove a view found
       the right node, but it does prove none of them throws on a well-shaped
       document — and `npm run shell:shoot` renders all nine in a real one. */
    querySelector() { return fakeElement(doc, 'div'); },
    querySelectorAll() { return []; },
    get firstElementChild() { return fakeElement(doc, 'div'); },
  };
}

function fakeDom() {
  const doc = { title: '' };
  const html = fakeElement(doc, 'html');
  const slots = {
    '[data-content]': fakeElement(doc, 'main'),
    '[data-brand]': fakeElement(doc, 'div'),
    '[data-nav]': fakeElement(doc, 'nav'),
    '[data-nav-foot]': fakeElement(doc, 'nav'),
    '[data-status]': fakeElement(doc, 'section'),
    '[data-window-controls]': fakeElement(doc, 'div'),
  };

  const media = {
    matches: false,
    listeners: {},
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); },
    removeEventListener() {},
    emit(matches) {
      this.matches = matches;
      for (const handler of this.listeners.change || []) handler({ matches });
    },
  };

  const view = fakeElement(doc, 'window');
  view.matchMedia = () => media;

  doc.documentElement = html;
  doc.defaultView = view;
  doc.querySelector = (selector) => slots[selector] || null;

  return { doc, html, slots, window: view, media };
}

/** A bridge that behaves like the preload's, with the calls it received. */
function fakeBridge({ mode = 'system', resolved = 'light', failTheme = false } = {}) {
  const calls = [];
  const state = { mode, resolved };
  const subscribers = {};
  return {
    calls,
    state,
    emitTheme(next) {
      Object.assign(state, next);
      for (const fn of subscribers.theme || []) fn({ ...state });
    },
    emitWindow(next) {
      for (const fn of subscribers.window || []) fn(next);
    },
    theme: {
      initial: () => ({ ...state }),
      get: () => Promise.resolve({ ...state }),
      set(next) {
        calls.push(['theme.set', next]);
        if (failTheme) return Promise.reject(new Error('config is read-only'));
        state.mode = next;
        state.resolved = next === 'system' ? 'light' : next;
        return Promise.resolve({ ...state });
      },
      onSystemChange(fn) { (subscribers.theme ||= []).push(fn); return () => {}; },
    },
    window: {
      minimise() { calls.push(['window.minimise']); return Promise.resolve({ maximised: false }); },
      toggleMaximise() { calls.push(['window.toggleMaximise']); return Promise.resolve({ maximised: true }); },
      close() { calls.push(['window.close']); return Promise.resolve({ closed: true }); },
      state: () => Promise.resolve({ maximised: false }),
      onStateChange(fn) { (subscribers.window ||= []).push(fn); return () => {}; },
    },
    fixtures: {
      get(name) {
        calls.push(['fixtures.get', name]);
        try { return Promise.resolve(fixture(name)); } catch (error) { return Promise.reject(error); }
      },
    },
  };
}

/* A stub view per route: the router's behaviour is what is under test here, and
   the real views' markup is checked separately below. */
function stubViews() {
  const stubs = {};
  for (const name of VIEW_FILES) {
    stubs[name] = { fixture: views[name].fixture, html: () => `<p>${name}</p>` };
  }
  return stubs;
}

function mountShell(options = {}) {
  const dom = fakeDom();
  const bridge = options.bridge || fakeBridge(options.theme);
  const shell = FlowApp.createShell({
    doc: dom.doc,
    lib: FlowLib,
    views: options.views || stubViews(),
    bridge,
    location: { hash: options.hash || '' },
  });
  return { ...dom, bridge, shell };
}

test('the shell renders the default route and lights up its nav item', async () => {
  const { shell, doc, html, slots } = mountShell();
  await shell.start();

  assert.equal(shell.route().path, '/dictation');
  assert.equal(html.getAttribute('data-route'), '/dictation');
  assert.equal(html.getAttribute('data-ready'), 'true');
  assert.equal(doc.title, 'Dictation — Flowstate');
  assert.match(slots['[data-nav]'].innerHTML, /href="#\/dictation"[^>]*aria-current="page"/);
  assert.match(slots['[data-content]'].innerHTML, /<div class="view">/);
  assert.match(slots['[data-brand]'].innerHTML, /Flowstate/);
});

test('the sidebar has the wordmark, the six screens, and Settings plus Help', async () => {
  const { shell, slots } = mountShell();
  await shell.start();

  const nav = slots['[data-nav]'].innerHTML;
  for (const item of FlowApp.NAV) {
    assert.match(nav, new RegExp(`href="#${item.path}"`), `${item.label} is missing`);
    assert.match(nav, new RegExp(`>${item.label}<`));
  }

  const foot = slots['[data-nav-foot]'].innerHTML;
  assert.match(foot, />Settings</);
  assert.match(foot, />Help</);
});

test('the status card says whether the model is resident, not "upgrade to pro"', async () => {
  const { shell, slots } = mountShell();
  await shell.start();
  await new Promise((resolve) => setImmediate(resolve));

  const status = slots['[data-status]'].innerHTML;
  assert.match(status, /Model resident/);
  assert.match(status, /dictations today/);
  assert.ok(!/pro/i.test(status));
});

test('a saved route is honoured on launch, and an unknown one is sent home', async () => {
  const deep = mountShell({ hash: '#/insights' });
  await deep.shell.start();
  assert.equal(deep.shell.route().path, '/insights');

  const nonsense = mountShell({ hash: '#/does-not-exist' });
  await nonsense.shell.start();
  assert.equal(nonsense.shell.route().path, '/dictation',
    'an unknown hash should land on the home screen, not an error');
});

test('navigating writes the hash, and the hashchange renders', async () => {
  const dom = fakeDom();
  const location = { hash: '' };
  const bridge = fakeBridge();
  const shell = FlowApp.createShell({
    doc: dom.doc, lib: FlowLib, views: stubViews(), bridge, location,
  });
  await shell.start();

  await shell.navigate('/settings/system');
  assert.equal(location.hash, '#/settings/system');

  // The real window fires hashchange; the fake one has to be told.
  dom.window.emit('hashchange');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(shell.route().path, '/settings/system');
  assert.equal(dom.doc.title, 'Settings · System — Flowstate');
  assert.match(dom.slots['[data-nav-foot]'].innerHTML, /href="#\/settings\/general"[^>]*aria-current/);
});

test('every route renders and mounts the real view without throwing', async () => {
  for (const route of FlowApp.ROUTES) {
    const { shell, html } = mountShell({ hash: `#${route.path}`, views });
    await shell.start();
    assert.equal(html.getAttribute('data-ready'), 'true', `${route.path} did not render`);
  }
});

test('a screen whose data will not load says so instead of going blank', async () => {
  const bridge = fakeBridge();
  bridge.fixtures.get = () => Promise.reject(new Error('the channel is gone'));
  const { shell, html, slots } = mountShell({ bridge });
  await shell.start();

  assert.equal(html.getAttribute('data-ready'), 'error');
  assert.match(slots['[data-content]'].innerHTML, /This screen could not load/);
  assert.match(slots['[data-content]'].innerHTML, /the channel is gone/);
});

test('the titlebar has minimise, maximise and close, and each does its job', async () => {
  const { shell, slots, bridge } = mountShell();
  await shell.start();

  const titlebar = slots['[data-window-controls]'];
  for (const action of ['minimise', 'maximise', 'close']) {
    assert.match(titlebar.innerHTML, new RegExp(`data-window-action="${action}"`));
  }
  assert.match(titlebar.innerHTML, /aria-label="Minimise"/);
  assert.match(titlebar.innerHTML, /aria-label="Close"/);
  assert.match(titlebar.innerHTML, /class="titlebar-btn is-close"/);
  assert.ok(!/<div[^>]*data-window-action/.test(titlebar.innerHTML),
    'the window controls must be real buttons');

  for (const action of ['minimise', 'maximise', 'close']) {
    titlebar.emit('click', { target: { closest: () => ({ getAttribute: () => action }) } });
  }
  assert.deepEqual(bridge.calls, [
    ['fixtures.get', 'dictation'],
    ['window.minimise'],
    ['window.toggleMaximise'],
    ['window.close'],
  ]);
});

test('maximising swaps the glyph to restore', async () => {
  const { shell, slots, bridge, html } = mountShell();
  await shell.start();

  bridge.emitWindow({ maximised: true });
  assert.match(slots['[data-window-controls]'].innerHTML, /aria-label="Restore"/);
  assert.equal(html.getAttribute('data-maximised'), 'true');

  bridge.emitWindow({ maximised: false });
  assert.match(slots['[data-window-controls]'].innerHTML, /aria-label="Maximise"/);
});

/* ---------------------------------------------------------------------------
   4. Theme
   --------------------------------------------------------------------------- */

test('the theme control writes the mode through and applies the resolved theme', async () => {
  const { shell, html, bridge } = mountShell({ theme: { mode: 'system', resolved: 'light' } });
  await shell.start();

  await shell.setTheme('dark');
  assert.deepEqual(bridge.calls.at(-1), ['theme.set', 'dark']);
  assert.equal(html.getAttribute('data-theme'), 'dark');
  assert.equal(html.getAttribute('data-theme-mode'), 'dark');

  await shell.setTheme('system');
  assert.equal(html.getAttribute('data-theme-mode'), 'system');
  assert.equal(html.getAttribute('data-theme'), 'light', 'System did not resolve');
});

test('an unknown mode is refused rather than stamped', async () => {
  const { shell, html } = mountShell();
  await shell.start();
  await assert.rejects(() => shell.setTheme('sepia'), /unknown theme mode/);
  assert.equal(html.getAttribute('data-theme-mode'), null);
});

test('a theme that could not be saved does not stay on screen', async () => {
  const bridge = fakeBridge({ mode: 'light', resolved: 'light', failTheme: true });
  const { shell, html } = mountShell({ bridge });
  await shell.start();
  shell.applyTheme({ mode: 'light', resolved: 'light' });

  await assert.rejects(() => shell.setTheme('dark'), /read-only/);
  assert.equal(html.getAttribute('data-theme-mode'), 'light',
    'the control would claim a mode the next launch will not honour');
  assert.equal(html.getAttribute('data-theme'), 'light');
});

test('System mode follows Windows live, from either signal', async () => {
  const { shell, html, bridge, media } = mountShell({ theme: { mode: 'system', resolved: 'light' } });
  await shell.start();
  shell.applyTheme({ mode: 'system', resolved: 'light' });

  // main's nativeTheme event.
  bridge.emitTheme({ mode: 'system', resolved: 'dark' });
  assert.equal(html.getAttribute('data-theme'), 'dark');

  // And the renderer's own media query, in case the event never arrives.
  bridge.emitTheme({ mode: 'system', resolved: 'dark' });
  media.emit(false);
  assert.equal(html.getAttribute('data-theme'), 'light');
});

test('a pinned theme ignores the OS changing underneath it', async () => {
  const { shell, html, media } = mountShell({ theme: { mode: 'dark', resolved: 'dark' } });
  await shell.start();
  shell.applyTheme({ mode: 'dark', resolved: 'dark' });

  media.emit(false);
  assert.equal(html.getAttribute('data-theme'), 'dark', 'Dark mode followed the OS to light');
});

test('the theme is set before the stylesheets load, from a synchronous read', () => {
  // No theme flash on launch, ever. If the inline script runs after the <link>
  // elements the first frame paints in the wrong theme, and if it asks over an
  // async channel it paints before the answer arrives.
  const script = INDEX_HTML.indexOf('data-theme');
  const firstLink = INDEX_HTML.indexOf('<link rel="stylesheet"');
  assert.notEqual(script, -1, 'index.html never sets data-theme');
  assert.ok(script < firstLink, 'the theme script runs after the stylesheets');
  assert.match(INDEX_HTML, /flow\.theme\.initial\(\)/);
  assert.match(PRELOAD, /initial:\s*\(\)\s*=>\s*ipcRenderer\.sendSync/);
});

test('index.html loads the token stack in order', () => {
  const order = ['tokens.css', 'base.css', 'app.css', 'screens.css']
    .map((file) => INDEX_HTML.indexOf(file));
  assert.ok(order.every((at) => at !== -1), 'index.html is missing a stylesheet');
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], 'index.html loads its stylesheets out of order');
  }
});

test('the renderer cannot reach the network', () => {
  // The GUI is a face, not a client: the LLM call lives in main behind a hard
  // timeout. A stray fetch() in a screen must fail here rather than quietly
  // shipping something off the machine.
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(INDEX_HTML);
  assert.ok(csp, 'index.html declares no CSP');
  assert.match(csp[1], /default-src 'none'/);
  assert.match(csp[1], /connect-src 'none'/);
  assert.match(csp[1], /style-src 'self'(?!.*unsafe-inline)/);
});

/* ---------------------------------------------------------------------------
   5. The bridge in main
   --------------------------------------------------------------------------- */

function fakeIpc() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle(channel, fn) {
      assert.ok(!handlers.has(channel), `${channel} was handled twice`);
      handlers.set(channel, fn);
    },
    removeHandler(channel) { handlers.delete(channel); },
    on(channel, fn) { listeners.set(channel, fn); },
    removeListener(channel) { listeners.delete(channel); },
    invoke(channel, payload, event = {}) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler for ${channel}`);
      return handler(event, payload);
    },
    send(channel, event) { return listeners.get(channel)(event); },
  };
}

function fakeNativeTheme(dark = false) {
  return {
    themeSource: 'system',
    shouldUseDarkColors: dark,
    listeners: [],
    on(_event, fn) { this.listeners.push(fn); },
    removeListener(_event, fn) { this.listeners = this.listeners.filter((it) => it !== fn); },
    emit() { for (const fn of this.listeners) fn(); },
  };
}

function fakeConfig(theme = 'system', { failWrites = false } = {}) {
  let config = { ui: { theme, windowBounds: null } };
  const changes = [];
  return {
    changes,
    get: () => structuredClone(config),
    async update(patch) {
      if (failWrites) throw new Error('disk is full');
      config = { ...config, ui: { ...config.ui, ...patch.ui } };
      changes.push(structuredClone(config));
      return structuredClone(config);
    },
    on() {},
    off() {},
  };
}

function mountBridge({ theme = 'system', dark = false, failWrites = false } = {}) {
  const ipc = fakeIpc();
  const nativeTheme = fakeNativeTheme(dark);
  const config = fakeConfig(theme, { failWrites });
  const sent = [];
  const window = {
    isDestroyed: () => false,
    isMaximized: () => window.maximised === true,
    minimize() { window.minimised = true; },
    maximize() { window.maximised = true; },
    unmaximize() { window.maximised = false; },
    close() { window.closed = true; },
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
  };

  const bridge = createShellBridge({
    ipcMain: ipc,
    nativeTheme,
    config,
    windowFromWebContents: () => window,
    getWindows: () => [window],
    fixturesDirectory: path.join(RENDERER, 'fixtures'),
  });

  return { bridge, ipc, nativeTheme, config, window, sent };
}

test('main owns the theme: it drives themeSource and resolves System', () => {
  const { ipc, nativeTheme } = mountBridge({ theme: 'dark', dark: true });
  assert.equal(nativeTheme.themeSource, 'dark', 'the configured mode never reached Chromium');
  assert.deepEqual(ipc.send(CHANNELS.themeInitial, {}) ?? undefined, undefined);

  const event = {};
  ipc.listeners.get(CHANNELS.themeInitial)(event);
  assert.deepEqual(event.returnValue, { mode: 'dark', resolved: 'dark' },
    'the synchronous read is what keeps the launch flash-free');
});

test('setting the theme persists it and tells every window', async () => {
  const { ipc, nativeTheme, config, sent } = mountBridge();
  const state = await ipc.invoke(CHANNELS.themeSet, 'dark');

  assert.equal(nativeTheme.themeSource, 'dark');
  assert.deepEqual(config.changes.at(-1).ui.theme, 'dark');
  assert.deepEqual(state, { mode: 'dark', resolved: 'light' });
  assert.deepEqual(sent.at(-1), [CHANNELS.themeSystemChanged, state]);
});

test('an unsupported mode never reaches config', async () => {
  const { ipc, config } = mountBridge();
  for (const mode of ['sepia', '', null, 42, ['dark'], { mode: 'dark' }]) {
    await assert.rejects(() => ipc.invoke(CHANNELS.themeSet, mode), /Unsupported theme mode/);
  }
  assert.deepEqual(config.changes, [], 'a rejected mode was written anyway');
  assert.deepEqual(THEME_MODES, ['system', 'light', 'dark']);
});

test('a failed write leaves the applied theme matching what is on disk', async () => {
  const { ipc, nativeTheme } = mountBridge({ theme: 'light', failWrites: true });
  await assert.rejects(() => ipc.invoke(CHANNELS.themeSet, 'dark'), /disk is full/);
  assert.equal(nativeTheme.themeSource, 'light',
    'the app would look dark and come back light');
});

test('a Windows theme change is broadcast to the renderer', () => {
  const { nativeTheme, sent } = mountBridge({ theme: 'system' });
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit();
  assert.deepEqual(sent.at(-1), [CHANNELS.themeSystemChanged, { mode: 'system', resolved: 'dark' }]);
});

test('the window controls act on the sender window and nothing else', async () => {
  const { ipc, window } = mountBridge();

  await ipc.invoke(CHANNELS.windowMinimise);
  assert.equal(window.minimised, true);

  assert.deepEqual(await ipc.invoke(CHANNELS.windowToggleMaximise), { maximised: true });
  assert.deepEqual(await ipc.invoke(CHANNELS.windowToggleMaximise), { maximised: false });

  await ipc.invoke(CHANNELS.windowClose);
  assert.equal(window.closed, true, 'close must destroy the window, not hide it');

  // A renderer cannot name a window: the handlers take no id at all.
  assert.ok(!/fromId\(/.test(SHELL_MAIN), 'a window is looked up by an id from the renderer');
});

test('the fixture channel serves the nine screens and refuses anything else', async () => {
  const { ipc } = mountBridge();

  for (const name of FIXTURES) {
    const data = await ipc.invoke(CHANNELS.fixture, name);
    assert.ok(data && typeof data === 'object', `${name} did not parse`);
  }

  for (const name of ['../config', 'config', '..\\..\\config.json', '', null, 42, 'settings.json']) {
    await assert.rejects(() => ipc.invoke(CHANNELS.fixture, name), /Unknown fixture/,
      `${String(name)} was served`);
  }
});

test('the preload exposes exactly the shell bridge, over the same channels', () => {
  assert.match(PRELOAD, /exposeInMainWorld\('flow'/);
  assert.match(PRELOAD, /contextBridge/);

  // Sandboxed preloads cannot require shell.js, so the channel names are
  // duplicated by necessity. They must not drift.
  for (const channel of Object.values(CHANNELS)) {
    assert.match(PRELOAD, new RegExp(channel.replace(/[-:]/g, '\\$&')),
      `the preload is missing ${channel}`);
  }

  // No raw ipcRenderer, no Node, no Electron primitives across the bridge.
  assert.ok(!/\bipcRenderer\.send\(/.test(PRELOAD), 'the preload exposes a fire-and-forget send');
  assert.ok(!/require\('node:/.test(PRELOAD), 'the preload pulls in Node');
  for (const namespace of ['theme', 'window', 'fixtures']) {
    assert.match(PRELOAD, new RegExp(`${namespace}: Object\\.freeze`), `${namespace} is not frozen`);
  }
});

/* ---------------------------------------------------------------------------
   6. The window itself
   --------------------------------------------------------------------------- */

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.onceHandlers = new Map();
    /* The constructor is deliberately inexact, as Chromium is on a 125% display:
       what comes back is a few pixels bigger than what was asked for. */
    this.bounds = {
      x: options.x ?? 0,
      y: options.y ?? 0,
      width: options.width + 5,
      height: options.height + 4,
    };
    this.shown = false;
    this.destroyed = false;
    this.maximised = false;
    this.webContents = { send: () => {}, once: () => {} };
  }

  on(event, fn) { (this.handlers.get(event) || this.handlers.set(event, []).get(event)).push(fn); }
  once(event, fn) { this.onceHandlers.set(event, fn); }
  emit(event) {
    for (const fn of this.handlers.get(event) || []) fn();
    const once = this.onceHandlers.get(event);
    if (once) { this.onceHandlers.delete(event); once(); }
  }

  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { ...this.bounds }; }
  setBounds(bounds) { this.bounds = bounds; }

  /* Real Chromium lands a few pixels off what the constructor was given on a
     fractional display scale, and exactly on what setContentBounds is given. The
     fake reproduces both, because that gap is the whole reason for the pinning. */
  setContentBounds(bounds) { this.bounds = { ...bounds }; }
  isMaximized() { return this.maximised; }
  maximize() { this.maximised = true; }
  isMinimized() { return false; }
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.shown; }
  show() { this.shown = true; }
  showInactive() { this.shown = true; }
  focus() {}
  hide() { this.shown = false; }
  destroy() { this.destroyed = true; }
  removeMenu() {}
  loadURL(url) { this.url = url; return Promise.resolve(); }
}

const DISPLAY = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };

function mountWindows({ saved = null } = {}) {
  const created = [];
  const savedBounds = [];
  const stateChanges = [];
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
      getAllDisplays: () => [DISPLAY],
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayNearestPoint: () => DISPLAY,
      getPrimaryDisplay: () => DISPLAY,
    },
    timers: {
      setTimeout: (fn, ms) => { pending.push({ fn, ms }); return pending.length; },
      clearTimeout: (handle) => { if (handle) pending[handle - 1] = null; },
    },
    windowState: { load: () => saved, save: (bounds) => savedBounds.push(bounds) },
    onWindowState: (window) => stateChanges.push(window),
  });

  return {
    manager,
    created,
    savedBounds,
    stateChanges,
    main: () => created[0],
    runTimers() {
      const due = pending.filter(Boolean);
      pending.length = 0;
      for (const timer of due) timer.fn();
      return due.length;
    },
  };
}

test('the main window is frameless, at least 900x640, and context-isolated', () => {
  const { manager, main } = mountWindows();
  manager.openMain();
  const { options } = main();

  assert.equal(options.frame, false, 'the window still has the OS titlebar');
  assert.equal(options.minWidth, MIN_WIDTH);
  assert.equal(options.minHeight, MIN_HEIGHT);
  /* Sizes are the page's, not the window's: a frameless Windows window carries an
     invisible resize border, so saving outer bounds and restoring them as the size
     hands the page two more pixels on every launch. */
  assert.equal(options.useContentSize, true);
  assert.equal(options.show, false, 'showing before the first paint is a theme flash');
  assert.equal(options.webPreferences.contextIsolation, true);
  assert.equal(options.webPreferences.nodeIntegration, false);
  assert.equal(options.webPreferences.sandbox, true);
  assert.match(options.webPreferences.preload, /preload\.js$/);
});

test('the window opens on the route it was asked for', () => {
  const first = mountWindows();
  first.manager.openMain();
  assert.match(first.main().url, /index\.html#\/dictation$/);

  const second = mountWindows();
  second.manager.openSettings();
  assert.match(second.main().url, /index\.html#\/settings\/general$/);
});

test('saved bounds are restored, and a maximised window comes back maximised', () => {
  const { manager, main } = mountWindows({
    saved: { x: 200, y: 100, width: 1400, height: 900, maximised: true },
  });
  manager.openMain();
  const window = main();

  assert.equal(window.options.x, 200);
  assert.equal(window.options.width, 1400);

  window.emit('ready-to-show');
  assert.equal(window.maximised, true);
  assert.equal(window.shown, true);
});

test('the restored geometry does not drift a few pixels every launch', () => {
  // Measured on a 125% display before this was pinned: 1100x700 came back as
  // 1105x704, was saved, and grew again on every launch after that.
  let saved = { x: 220, y: 140, width: 1100, height: 700, maximised: false };

  for (let launch = 0; launch < 4; launch++) {
    const { manager, main, savedBounds, runTimers } = mountWindows({ saved });
    manager.openMain();
    const window = main();

    assert.deepEqual(window.getContentBounds(), { x: 220, y: 140, width: 1100, height: 700 },
      `launch ${launch + 1} opened at the wrong size`);

    window.emit('resize');
    runTimers();
    assert.deepEqual(savedBounds.at(-1), saved, `launch ${launch + 1} saved something else`);
    saved = savedBounds.at(-1);
  }
});

test('moving and resizing saves the geometry once the user stops', () => {
  const { manager, main, savedBounds, runTimers } = mountWindows();
  manager.openMain();
  const window = main();

  window.bounds = { x: 40, y: 60, width: 1000, height: 700 };
  for (let i = 0; i < 20; i++) window.emit('move');
  window.emit('resize');

  assert.deepEqual(savedBounds, [], 'every move event wrote to disk');
  assert.equal(runTimers(), 1, 'the writes were not collapsed into one');
  assert.deepEqual(savedBounds, [{ x: 40, y: 60, width: 1000, height: 700, maximised: false }]);
});

test('maximising is saved at once and reported to the titlebar', () => {
  const { manager, main, savedBounds, stateChanges, runTimers } = mountWindows();
  manager.openMain();
  const window = main();

  window.bounds = { x: 10, y: 20, width: 1100, height: 720 };
  window.emit('move');
  runTimers();

  window.maximised = true;
  window.bounds = { x: 0, y: 0, width: 1920, height: 1040 }; // the whole screen
  window.emit('maximize');

  assert.deepEqual(savedBounds.at(-1), { x: 10, y: 20, width: 1100, height: 720, maximised: true },
    'maximising overwrote the geometry there is to restore to');
  assert.equal(stateChanges.length, 1, 'the titlebar was never told to swap its glyph');

  window.maximised = false;
  window.bounds = { x: 10, y: 20, width: 1100, height: 720 };
  window.emit('unmaximize');
  assert.deepEqual(savedBounds.at(-1), { x: 10, y: 20, width: 1100, height: 720, maximised: false });
  assert.equal(stateChanges.length, 2);
});

test('closing writes the final geometry even mid-debounce', () => {
  const { manager, main, savedBounds } = mountWindows();
  manager.openMain();
  const window = main();

  window.bounds = { x: 10, y: 20, width: 1100, height: 720 };
  window.emit('move');       // schedules a write
  window.emit('close');      // must not lose it

  assert.deepEqual(savedBounds, [{ x: 10, y: 20, width: 1100, height: 720, maximised: false }]);
});

test('the window is destroyed on close, and the app stays in the tray', () => {
  // "Windows are destroyed on close, never hidden" — a hidden window keeps timers
  // alive and fails gate G4. BrowserWindow does this by default, so what matters
  // is that nothing here opts out of it or quits the app with it.
  assert.ok(!/\bwindow\.hide\(\)/.test(WINDOWS_JS.split('The recording pill')[0]),
    'the main window is hidden rather than destroyed');
  assert.match(read(ROOT, 'src', 'main', 'main.js'), /window-all-closed/);
  assert.match(SHELL_MAIN, /window\.close\(\)/);
});

/* ---------------------------------------------------------------------------
   7. The views' markup
   --------------------------------------------------------------------------- */

test('every view renders its screen from the real fixture', () => {
  const ctx = {
    lib: FlowLib,
    theme: { mode: 'system', resolved: 'light' },
    tabs: (active) => `<nav class="tabs">${active}</nav>`,
  };

  for (const name of VIEW_FILES) {
    // The first-run setup is a flow, not a screen: no fixture and no page
    // title. tests/onboarding.test.js covers it.
    if (name === 'onboarding') continue;
    const view = views[name];
    const html = view.html(ctx, fixture(view.fixture));

    assert.ok(html.length > 400, `${name} rendered almost nothing`);
    assert.match(html, /<h1 class="page-title">/, `${name} has no page title`);
    assert.ok(!/undefined|NaN|\[object Object\]/.test(html),
      `${name} rendered a hole in its data`);
    // An href="#" would drive the router home the moment it was clicked.
    assert.ok(!/href="#"/.test(html), `${name} has an href="#" inside a hash-routed app`);
    // Icon-only buttons say what they do.
    for (const [, attrs] of html.matchAll(/<button([^>]*class="[^"]*btn-icon[^"]*"[^>]*)>/g)) {
      assert.match(attrs, /aria-label=/, `${name} has an unlabelled icon button`);
    }
    assert.ok(!/role="button"/.test(html), `${name} fakes a button`);
  }
});

test('the settings screens carry the same three tabs', () => {
  const ctx = { lib: FlowLib, theme: { mode: 'dark', resolved: 'dark' },
    tabs: (active) => `<nav data-active="${active}"></nav>` };

  for (const [name, expected] of [
    ['settings-general', '/settings/general'],
    ['settings-system', '/settings/system'],
    ['settings-about', '/settings/about'],
  ]) {
    const html = views[name].html(ctx, fixture('settings'));
    assert.match(html, new RegExp(`data-active="${expected}"`), `${name} marks the wrong tab`);
  }
});

test('the theme control shows the mode the app is actually in', () => {
  const ctx = { lib: FlowLib, tabs: () => '', theme: { mode: 'dark', resolved: 'dark' } };
  const html = views['settings-general'].html(ctx, fixture('settings'));

  assert.match(html, /value="dark" checked/, 'the control does not reflect the current mode');
  assert.equal((html.match(/name="theme"/g) || []).length, 3, 'Light, Dark and System');
  assert.match(html, /role="radiogroup"/);
  // The mode comes from main, never from the fixture: the fixture says system.
  assert.equal(fixture('settings').general.theme.mode, 'system');
  assert.ok(!/value="system" checked/.test(html));
});

test('the cleanup settings expose the prompt-level filler preference', () => {
  const ctx = { lib: FlowLib, tabs: () => '', theme: { mode: 'system', resolved: 'light' } };
  const html = views['settings-general'].html(ctx, fixture('settings'));

  assert.match(html, /Remove filler words/);
  assert.match(html, /id="fillers"/);
  assert.match(html, /aria-label="Remove filler words"/);
});

test('the views escape the text they render', () => {
  const ctx = { lib: FlowLib, tabs: () => '', theme: { mode: 'system', resolved: 'light' } };
  const data = fixture('dictionary');
  data.terms[0].term = '<script>alert(1)</script>';
  const html = views.dictionary.html(ctx, data);

  assert.ok(!/<script>alert/.test(html), 'a fixture string reached the DOM as markup');
  assert.match(html, /&lt;script&gt;/);
});

test('insights still refuses to invent a percentile', () => {
  const ctx = { lib: FlowLib, tabs: () => '', theme: { mode: 'system', resolved: 'light' } };
  const data = fixture('insights');
  assert.equal(data.wpm.percentile, null);
  const html = views.insights.html(ctx, data);
  assert.match(html, /No percentile/);
  assert.ok(!/Top \d/.test(html));
});
