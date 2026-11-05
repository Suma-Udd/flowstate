'use strict';

/**
 * The app shell's main-process side — issue #16.
 *
 * Three things the GUI cannot do for itself, and nothing else:
 *
 *   1. Theme. main owns it: the mode lives in config, `nativeTheme.themeSource`
 *      carries it into Chromium, and System is resolved here to a concrete light
 *      or dark. The renderer only ever stamps what it is told, which is why the
 *      OS theme and the app can never disagree.
 *   2. The window controls behind the custom titlebar. Frameless means Electron
 *      draws no minimise, maximise or close, so the renderer has to ask.
 *   3. The #09 fixtures. Screens still read canned JSON, and a file:// renderer
 *      cannot fetch a sibling file. Each screen's real channel replaces its use
 *      of this one — #17 for settings, #28 for history, #30 for insights — and
 *      when the last of them lands, this handler and the fixtures go with it.
 *
 * Issue #17 defines the complete v1 bridge in `ipc.js` per the IPC contract in
 * the engine notes. This file is deliberately the small, separate subset the shell
 * needs so the two can be merged additively rather than fought over.
 *
 * Every channel validates its input. A renderer is never trusted, even though
 * we wrote it.
 */

const fsPromises = require('node:fs/promises');
const path = require('node:path');

const CHANNELS = Object.freeze({
  themeInitial: 'flowstate:theme-initial',
  themeGet: 'flowstate:theme-get',
  themeSet: 'flowstate:theme-set',
  themeSystemChanged: 'flowstate:theme-system-changed',
  windowMinimise: 'flowstate:window-minimise',
  windowToggleMaximise: 'flowstate:window-toggle-maximise',
  windowClose: 'flowstate:window-close',
  windowState: 'flowstate:window-state',
  windowStateChanged: 'flowstate:window-state-changed',
  fixture: 'flowstate:fixture',
});

const THEME_MODES = Object.freeze(['system', 'light', 'dark']);

/* The screens that still read a fixture. A closed list is also what makes the
   channel safe: a name that is not one of these cannot become a path. */
const FIXTURES = Object.freeze([
  'dictation',
  'history',
  'dictionary',
  'snippets',
  'scratchpad',
  'insights',
  'settings',
]);

function createShellBridge({
  ipcMain,
  nativeTheme,
  config,
  windowFromWebContents,
  getWindows = () => [],
  fixturesDirectory = path.join(__dirname, '..', 'renderer', 'fixtures'),
  readFile = fsPromises.readFile,
  handleTheme = true,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function' || typeof ipcMain.on !== 'function') {
    throw new TypeError('createShellBridge requires ipcMain.');
  }
  if (!nativeTheme) {
    throw new TypeError('createShellBridge requires nativeTheme.');
  }
  if (!config || typeof config.get !== 'function' || typeof config.update !== 'function') {
    throw new TypeError('createShellBridge requires the config store.');
  }

  /* ----------------------------------------------------------------------
     Theme
     ---------------------------------------------------------------------- */

  function mode() {
    const configured = config.get().ui.theme;
    return THEME_MODES.includes(configured) ? configured : 'system';
  }

  function themeState() {
    return {
      mode: mode(),
      resolved: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
    };
  }

  /** Pushes the configured mode into Chromium. Idempotent. */
  function applyMode() {
    nativeTheme.themeSource = mode();
    return themeState();
  }

  function broadcast(channel, payload) {
    for (const window of getWindows()) {
      if (!window || window.isDestroyed()) continue;
      window.webContents.send(channel, payload);
    }
  }

  async function setTheme(next) {
    if (typeof next !== 'string' || !THEME_MODES.includes(next)) {
      throw new TypeError(`Unsupported theme mode: ${String(next)}`);
    }
    nativeTheme.themeSource = next;
    try {
      await config.update({ ui: { theme: next } });
    } catch (error) {
      // The theme did not persist, so it must not stay applied either: the next
      // launch would come up in the old one and the toggle would look broken.
      applyMode();
      throw error;
    }
    const state = themeState();
    broadcast(CHANNELS.themeSystemChanged, state);
    return state;
  }

  /* Windows theme changes arrive here, and only here. In System mode the
     renderer's own media query would follow themeSource as well, but the
     attribute on <html> is what the app styles from, so it has to be told. */
  const onNativeThemeUpdated = () => broadcast(CHANNELS.themeSystemChanged, themeState());
  nativeTheme.on('updated', onNativeThemeUpdated);

  /* ----------------------------------------------------------------------
     Window controls

     Always the sender's own window. Taking an id from the renderer would let a
     compromised one drive a window it does not own, and there is nothing to
     gain: a titlebar only ever means "this window".
     ---------------------------------------------------------------------- */

  function senderWindow(event) {
    if (typeof windowFromWebContents !== 'function') return null;
    const window = windowFromWebContents(event.sender);
    return window && !window.isDestroyed() ? window : null;
  }

  function stateOf(window) {
    return { maximised: Boolean(window && window.isMaximized()) };
  }

  /* ----------------------------------------------------------------------
     Fixtures — scaffolding, see the header
     ---------------------------------------------------------------------- */

  async function fixture(name) {
    if (typeof name !== 'string' || !FIXTURES.includes(name)) {
      throw new TypeError(`Unknown fixture: ${String(name)}`);
    }
    const raw = await readFile(path.join(fixturesDirectory, `${name}.json`), 'utf8');
    return JSON.parse(raw);
  }

  /* ----------------------------------------------------------------------
     Handlers
     ---------------------------------------------------------------------- */

  /* sendSync, because index.html's inline script has to know the theme before
     the first paint and a promise resolves a frame too late. It is one small
     synchronous read at window creation, and the alternative is a visible flash
     on every launch. */
  const onThemeInitial = (event) => { event.returnValue = themeState(); };
  ipcMain.on(CHANNELS.themeInitial, onThemeInitial);

  if (handleTheme) {
    ipcMain.handle(CHANNELS.themeGet, () => themeState());
    ipcMain.handle(CHANNELS.themeSet, (_event, next) => setTheme(next));
  }

  ipcMain.handle(CHANNELS.windowMinimise, (event) => {
    const window = senderWindow(event);
    if (window) window.minimize();
    return stateOf(window);
  });

  ipcMain.handle(CHANNELS.windowToggleMaximise, (event) => {
    const window = senderWindow(event);
    if (!window) return { maximised: false };
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return stateOf(window);
  });

  /* Close, not hide: closing destroys the window and the app carries on in the
     tray. A hidden window keeps timers alive and fails gate G4. */
  ipcMain.handle(CHANNELS.windowClose, (event) => {
    const window = senderWindow(event);
    if (window) window.close();
    return { closed: Boolean(window) };
  });

  ipcMain.handle(CHANNELS.windowState, (event) => stateOf(senderWindow(event)));
  ipcMain.handle(CHANNELS.fixture, (_event, name) => fixture(name));

  applyMode();

  /* Keeps the app's theme in step when the mode is changed from somewhere other
     than the theme control — a hand-edited config, or a future tray item. */
  const onConfigChange = () => applyMode();
  if (typeof config.on === 'function') config.on('change', onConfigChange);

  function dispose() {
    nativeTheme.removeListener('updated', onNativeThemeUpdated);
    if (typeof config.off === 'function') config.off('change', onConfigChange);
    ipcMain.removeListener(CHANNELS.themeInitial, onThemeInitial);
    for (const channel of [
      ...(handleTheme ? [CHANNELS.themeGet, CHANNELS.themeSet] : []),
      CHANNELS.windowMinimise,
      CHANNELS.windowToggleMaximise,
      CHANNELS.windowClose,
      CHANNELS.windowState,
      CHANNELS.fixture,
    ]) {
      ipcMain.removeHandler(channel);
    }
  }

  return {
    dispose,
    fixture,
    getTheme: themeState,
    setTheme,
    applyMode,
    notifyWindowState: (window) => {
      if (!window || window.isDestroyed()) return;
      window.webContents.send(CHANNELS.windowStateChanged, stateOf(window));
    },
  };
}

module.exports = {
  CHANNELS,
  FIXTURES,
  THEME_MODES,
  createShellBridge,
};
