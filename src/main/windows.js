'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  MIN_HEIGHT,
  MIN_WIDTH,
  boundsToSave,
  restoreBounds,
} = require('./window-state');

/**
 * The recording pill's geometry and lifecycle timings.
 *
 * `inset` must match --pill-inset in pill.css: the pill sits that far above the
 * bottom edge of its own window, and the window is placed so that the pill —
 * not the window — ends up `gap` pixels above the taskbar. The window itself is
 * larger than the 224x56 pill so the entry animation has somewhere to travel
 * and a long error line has somewhere to grow. tests/pill.test.js asserts the
 * CSS and this object still agree.
 *
 * `exitMs` is --dur-base plus a frame: main hides the window only after the
 * renderer's exit animation has actually finished, otherwise the pill vanishes
 * instead of leaving.
 */
const PILL = {
  width: 440,
  height: 112,
  inset: 16,
  gap: 80,
  exitMs: 200,
  /**
   * How long a hidden pill is allowed to exist before it is destroyed.
   *
   * Flowstate's standing rule is destroy, never hide — hidden windows keep
   * timers alive and fail gate G4. The pill is the one documented exception,
   * because it is shown dozens of times a day and paying window creation on
   * every key-down would put a visible stutter on the most-seen surface in the
   * app. So it is both: hidden immediately (with its rAF loop cancelled and its
   * CSS animations killed, which is the part G4 actually measures), then
   * destroyed outright once a burst of dictation is clearly over. At idle there
   * is no pill window at all.
   */
  idleDestroyMs: 30_000,
};

function createWindowManager({
  BrowserWindow,
  screen,
  preloadPath = path.join(__dirname, 'preload.js'),
  rendererPath = path.join(__dirname, '..', 'renderer', 'index.html'),
  pillPreloadPath = path.join(__dirname, 'pill-preload.js'),
  pillRendererPath = path.join(__dirname, '..', 'renderer', 'pill', 'pill.html'),
  timers = { setTimeout, clearTimeout },
  pill: pillOptions = {},
  /* Size and position across launches. Injected rather than reading config
     directly so the geometry stays testable without a config file. */
  windowState = { load: () => null, save: () => {} },
  /* Called when the window is maximised or restored, so the custom titlebar can
     swap its glyph. main forwards this to the shell bridge. */
  onWindowState = () => {},
  /* Bounds are saved on a trailing debounce: a drag across the desktop fires
     hundreds of move events, and this is a JSON write. Event-driven, not a
     poll — nothing is scheduled unless the user moved something. */
  saveDebounceMs = 400,
}) {
  const windows = new Map();
  const pill = { ...PILL, ...pillOptions };
  let saveTimer = null;

  function loadRenderer(window, route) {
    const url = pathToFileURL(rendererPath);
    url.hash = route;
    return window.loadURL(url.toString());
  }

  /**
   * The size of the page, not of the window.
   *
   * On Windows a frameless window still carries an invisible resize border, so at
   * 125% scaling `getBounds()` reports two pixels more than the page actually
   * has. Saving that and restoring it as the window size would hand the page two
   * pixels it did not have, every launch. Content bounds round-trip exactly, and
   * they are also what the 900x640 minimum is about: usable layout space.
   */
  function contentBoundsOf(window) {
    return typeof window.getContentBounds === 'function'
      ? window.getContentBounds()
      : window.getBounds();
  }

  function isMaximised(window) {
    return typeof window.isMaximized === 'function' && window.isMaximized();
  }

  /* The last geometry the window had while it was not maximised. A maximised
     window's content box is the whole screen, and there is no
     getNormalContentBounds to ask, so it is tracked as it changes instead. */
  let normalBounds = null;

  function persistBounds(window) {
    if (!window || window.isDestroyed()) return;
    const maximised = isMaximised(window);
    if (!maximised) normalBounds = contentBoundsOf(window);
    const saved = boundsToSave(normalBounds, { maximised });
    if (saved) windowState.save(saved);
  }

  function schedulePersist(window) {
    saveTimer = cancel(saveTimer);
    saveTimer = timers.setTimeout(() => {
      saveTimer = null;
      persistBounds(window);
    }, saveDebounceMs);
  }

  function open(name = 'main', route = '/dictation') {
    const existing = windows.get(name);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) {
        existing.restore();
      }
      existing.show();
      existing.focus();
      /* Opening Settings from the tray while the window is already up reloads it
         on the requested route. The shell holds no state a reload would lose —
         everything on screen comes from main — so this is cheaper than adding a
         navigate channel the renderer would have to be trusted with. */
      void loadRenderer(existing, route);
      return existing;
    }

    const restored = restoreBounds(
      windowState.load(),
      screen && typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : []
    );

    const window = new BrowserWindow({
      title: 'Flowstate',
      /* Every size here is the page's, not the window's: it is the layout that
         has a 900x640 minimum, and it is what the review screenshots are taken
         at. See contentBoundsOf for why this also stops a two-pixel drift. */
      useContentSize: true,
      width: restored.width,
      height: restored.height,
      ...(restored.x === undefined ? {} : { x: restored.x, y: restored.y }),
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      show: false,
      /* Frameless: the titlebar is drawn by the renderer, per the design notes.
         The window stays resizable from its edges — Windows keeps the resize
         borders on a frameless window, it is only the caption that goes. */
      frame: false,
      /* Electron's default, stated on purpose: an occluded or minimised window
         must stop being drawn. Gate G4 measures a 10-minute idle flatline, and a
         GUI nobody is looking at may not cost a single frame. */
      backgroundThrottling: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    windows.set(name, window);

    /* Pin the page to exactly the size that was restored.
       `useContentSize` alone is not enough: on a fractional display scale the
       constructor lands a few pixels off what it was given — 1100x700 comes back
       as 1105x704 — and since that is what gets saved on the way out, the window
       grows every launch. Measured at 125%: 1100 -> 1105 -> 1108 -> 1113 over
       four launches. setContentBounds is exact, so the round-trip is stable. */
    if (typeof window.setContentBounds === 'function') {
      const current = contentBoundsOf(window);
      window.setContentBounds({
        x: restored.x === undefined ? current.x : restored.x,
        y: restored.y === undefined ? current.y : restored.y,
        width: restored.width,
        height: restored.height,
      });
    }

    normalBounds = contentBoundsOf(window);
    window.removeMenu();

    /* show: false plus ready-to-show is what keeps the launch flash-free: the
       first frame is painted off-screen in the right theme, and only then does
       the window appear. Setting a backgroundColor here instead would mean a
       literal colour in the main process, drifting from tokens.css. */
    window.once('ready-to-show', () => {
      if (window.isDestroyed()) return;
      // Captured before maximising, so restoring the window has somewhere to go.
      normalBounds = contentBoundsOf(window);
      if (restored.maximised && typeof window.maximize === 'function') window.maximize();
      window.show();
    });

    if (typeof window.on === 'function') {
      window.on('resize', () => schedulePersist(window));
      window.on('move', () => schedulePersist(window));
      window.on('maximize', () => {
        persistBounds(window);
        onWindowState(window);
      });
      window.on('unmaximize', () => {
        persistBounds(window);
        onWindowState(window);
      });
    }

    window.once('close', () => {
      // The debounce may still be pending, and this is the last chance to write.
      saveTimer = cancel(saveTimer);
      persistBounds(window);
    });

    window.once('closed', () => {
      windows.delete(name);
    });

    void loadRenderer(window, route).catch((error) => {
      console.error(`Flowstate renderer failed to load: ${error.message}`);
      if (!window.isDestroyed()) {
        window.destroy();
      }
    });

    return window;
  }

  /* ------------------------------------------------------------------------
     The recording pill

     Frameless, transparent, always-on-top, click-through, no taskbar entry,
     and never focused. It is an indicator, not a window: the user is typing
     into something else and the pill must not interrupt that for an instant.
     ------------------------------------------------------------------------ */

  let pillWindow;
  let pillReady = false;
  let pillQueue = [];
  let exitTimer = null;
  let destroyTimer = null;

  function cancel(timer) {
    if (timer !== null) timers.clearTimeout(timer);
    return null;
  }

  /**
   * The display the user is working on. The cursor is the cheapest honest
   * proxy for that — a second monitor is a common setup here, and a pill that
   * always lands on the primary display would be off-screen half the time.
   */
  function activeDisplay() {
    if (!screen) {
      throw new Error('createWindowManager needs Electron\'s screen module to place the pill');
    }
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
      return screen.getPrimaryDisplay();
    }
  }

  /** Bottom-centre, with the pill's own bottom edge `gap` above the taskbar. */
  function pillBounds() {
    const area = activeDisplay().workArea; // workArea already excludes the taskbar
    return {
      x: Math.round(area.x + (area.width - pill.width) / 2),
      y: Math.round(area.y + area.height - pill.gap + pill.inset - pill.height),
      width: pill.width,
      height: pill.height,
    };
  }

  function sendToPill(channel, payload) {
    if (!pillWindow || pillWindow.isDestroyed()) return;
    if (!pillReady) {
      // A stale amplitude sample is worse than a dropped one — it would draw a
      // waveform from before the window existed. State and visibility do have
      // to survive the wait, or a pill created at key-down never comes up.
      if (channel !== 'pill:amplitude') pillQueue.push([channel, payload]);
      return;
    }
    pillWindow.webContents.send(channel, payload);
  }

  function ensurePillWindow() {
    if (pillWindow && !pillWindow.isDestroyed()) return pillWindow;

    pillReady = false;
    pillQueue = [];

    pillWindow = new BrowserWindow({
      ...pillBounds(),
      title: 'Flowstate',
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      roundedCorners: false, // the OS must not clip our own transparent canvas
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false, // it must never take focus from what the user is typing into
      alwaysOnTop: true,
      acceptFirstMouse: false,
      webPreferences: {
        preload: pillPreloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Click-through. Without this the pill would swallow a click on whatever it
    // happens to be floating over.
    pillWindow.setIgnoreMouseEvents(true);
    // Above full-screen apps as well, or the pill silently stops existing the
    // moment someone dictates into a maximised video call.
    pillWindow.setAlwaysOnTop(true, 'screen-saver');

    pillWindow.webContents.once('did-finish-load', () => {
      pillReady = true;
      const queued = pillQueue;
      pillQueue = [];
      for (const [channel, payload] of queued) sendToPill(channel, payload);
    });

    pillWindow.once('closed', () => {
      pillWindow = undefined;
      pillReady = false;
      pillQueue = [];
      exitTimer = cancel(exitTimer);
      destroyTimer = cancel(destroyTimer);
    });

    void pillWindow.loadURL(pathToFileURL(pillRendererPath).toString()).catch((error) => {
      console.error(`Flowstate pill failed to load: ${error.message}`);
      destroyPill();
    });

    return pillWindow;
  }

  function scheduleDestroy() {
    destroyTimer = cancel(destroyTimer);
    destroyTimer = timers.setTimeout(() => {
      destroyTimer = null;
      destroyPill();
    }, pill.idleDestroyMs);
  }

  /** Shows the pill in `state`, without ever taking focus. */
  function showPill(state = 'idle-armed', detail) {
    exitTimer = cancel(exitTimer);
    destroyTimer = cancel(destroyTimer);

    const window = ensurePillWindow();
    // The user may have moved to another monitor since the last dictation, and
    // the taskbar may have moved with them.
    window.setBounds(pillBounds());
    if (!window.isVisible()) {
      // showInactive, never show: show() would steal focus from the app the
      // text is about to be pasted into.
      window.showInactive();
    }
    setPillState(state, detail);
    sendToPill('pill:visibility', true);
    return window;
  }

  function setPillState(state, detail) {
    sendToPill('pill:state', { state, reason: detail && detail.reason });
  }

  /** Amplitude for the waveform, 0..1. Pushed at ~30Hz during `listening`. */
  function pushPillAmplitude(amplitude) {
    sendToPill('pill:amplitude', amplitude);
  }

  /**
   * Plays the exit animation, then hides. The window survives a little longer
   * so a burst of dictations does not pay for window creation each time; see
   * PILL.idleDestroyMs for why it is not simply left hidden forever.
   */
  function hidePill() {
    if (!pillWindow || pillWindow.isDestroyed()) return;
    sendToPill('pill:visibility', false);
    exitTimer = cancel(exitTimer);
    exitTimer = timers.setTimeout(() => {
      exitTimer = null;
      if (pillWindow && !pillWindow.isDestroyed()) pillWindow.hide();
      scheduleDestroy();
    }, pill.exitMs);
  }

  function destroyPill() {
    exitTimer = cancel(exitTimer);
    destroyTimer = cancel(destroyTimer);
    if (pillWindow && !pillWindow.isDestroyed()) {
      pillWindow.destroy();
    }
    pillWindow = undefined;
    pillReady = false;
    pillQueue = [];
  }

  function destroyAll() {
    destroyPill();
    saveTimer = cancel(saveTimer);
    for (const window of windows.values()) {
      if (!window.isDestroyed()) {
        window.destroy();
      }
    }
    windows.clear();
  }

  return {
    openMain: (route = '/dictation') => open('main', route),
    openSettings: () => open('main', '/settings/general'),
    showPill,
    setPillState,
    pushPillAmplitude,
    hidePill,
    destroyPill,
    pillBounds,
    isPillOpen: () => Boolean(pillWindow && !pillWindow.isDestroyed()),
    destroyAll,
    count: () => windows.size,
  };
}

module.exports = {
  createWindowManager,
  PILL,
};
