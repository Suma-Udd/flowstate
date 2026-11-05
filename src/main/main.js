'use strict';

const os = require('node:os');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  Tray,
  utilityProcess,
} = require('electron');
const { uIOhook } = require('uiohook-napi');
const { createAsrWorkerManager } = require('./asr-worker');
const { buildStreamHotwords } = require('../worker/hotwords');
const { createAutostartManager } = require('./autostart');
const { createConfigStore } = require('./config');
const { createDictionaryStore } = require('./dict-store');
const { createSnippetsStore } = require('./snippets-store');
const { createScratchStore } = require('./scratch-store');
const { createScratchRouter } = require('./scratch-inject');
const { createDictationController } = require('./dictation');
const { createHistoryDatabase } = require('./db');
const { createErrorLog, withErrorCapture } = require('./error-log');
const { createFocusTracker } = require('./focus');
const { createGlobalHotkey } = require('./hotkey');
const { createHistoryBuffer } = require('./history-buffer');
const { createNativeUser32, createPasteService } = require('./inject');
const { createRePaster } = require('./repaste');
const { createIpcBridge } = require('./ipc');
const { createUpdater } = require('./updater');
const { runSelfTest, selfTestTarget } = require('./self-check');
const { createLlmService } = require('./llm');
const { createMicrophoneService } = require('./mics');
const { createMicPreviewService } = require('./mic-preview');
const { createModelManager } = require('./model-manager');
const { createModelWindowController } = require('./model-window');
const { DEFAULT_WARM_HOLD_MS, createRecorderManager } = require('./recorder');
const { createShellBridge } = require('./shell');
const { createTestRunner } = require('./test-run');
const { createAppTray } = require('./tray');
const { createWindowManager } = require('./windows');
const { MODEL_NAME } = require('../shared/model-manifest');
const { LLM_PROVIDERS } = require('../shared/llm-providers');
const { UPDATE_MANIFEST_URL, UPDATE_PUBLIC_KEY_PEM } = require('../shared/update-key');
const { dependencies: PACKAGE_DEPENDENCIES } = require('../../package.json');

const REPOSITORY_URL = 'https://github.com/Suma-Udd/flowstate';
const DOC_TARGETS = Object.freeze({
  readme: `${REPOSITORY_URL}#readme`,
  issues: `${REPOSITORY_URL}/issues`,
  releases: `${REPOSITORY_URL}/releases`,
  license: `${REPOSITORY_URL}/blob/main/LICENSE`,
  // "Get a key" links, one per provider that has a sign-up page.
  ...Object.fromEntries(
    LLM_PROVIDERS.filter((provider) => provider.keyUrl)
      .map((provider) => [`key-${provider.id}`, provider.keyUrl])
  ),
});

app.setName('flowstate');
/* Idle footprint (gate G4): this UI is flat DOM, canvas and CSS, so the GPU
   process buys nothing and cost 136 MB once a window had been opened.
   Software rendering keeps transparent windows (the pill) working on Windows.
   Running the video capture service in-process stops the microphone list's
   enumerateDevices from leaving a 38 MB utility process behind for good. */
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-features', 'RunVideoCaptureServiceInBrowserProcess');

/* Test hook: FLOWSTATE_DATA_DIR points the whole app (config, history DB,
   dictionary, logs, scratchpad, single-instance lock) at a throwaway folder,
   so a dev build can be driven without touching the installed app's data or
   its running instance. Unset in normal use. */
if (process.env.FLOWSTATE_DATA_DIR) {
  app.setPath('appData', process.env.FLOWSTATE_DATA_DIR);
  app.setPath('userData', path.join(process.env.FLOWSTATE_DATA_DIR, 'electron-user-data'));
}

/* `--self-test=<file>` (used by the installer smoke test in CI) loads every
   native module from inside the packaged app, writes a report and exits. It
   gets its own throwaway profile so it never collides with a running Flowstate. */
const selfTestFile = selfTestTarget(process.argv);
if (selfTestFile) {
  app.setPath('userData', path.join(os.tmpdir(), `flowstate-self-test-${process.pid}`));
}

const hasSingleInstanceLock = selfTestFile ? true : app.requestSingleInstanceLock();
let appLogger;
let appTray;
let configStore;
let dictionaryStore;
let snippetsStore;
let scratchStore;
const scratchSession = { active: false, setActive(value) { this.active = value === true; } };
let dictationController;
let dictationEnabled = true;
let errorLog;
let historyStore;
let llmService;
let updater;
let hotkeyManager;
let ipcBridge;
let microphoneService;
let microphonePreviewService;
let modelManager;
let modelWindowController;
let openRequested = false;
let recorderManager;
let runtimeStarted = false;
let shellBridge;
let testRunner;
let windowManager;
let workerManager;

function needsOnboarding() {
  return configStore?.get().onboarding?.completed === false;
}

function openMainWindow() {
  const onboarding = needsOnboarding();
  // The first-run setup downloads the model itself; the small download window
  // is only for someone whose model went missing after setup.
  if (!onboarding && modelManager && modelManager.getState().phase !== 'ready') {
    modelWindowController?.open();
    return;
  }
  if (windowManager) {
    windowManager.openMain(onboarding ? '/welcome' : '/dictation');
  } else {
    openRequested = true;
  }
}

/* Only the first run of the setup says this, and only once ever: with no key,
   cleanup is skipped and the raw transcript is pasted. Say so kindly, so it
   never looks like a bug. */
function maybeExplainRawTranscript(result) {
  const reason = result?.cleanup?.reason;
  if (reason !== 'missing-key' && reason !== 'not-configured') return;
  if (!configStore || configStore.get().ui.notices.rawTranscript === true) return;
  void configStore.update({ ui: { notices: { rawTranscript: true } } }).catch(() => {});
  try {
    new Notification({
      title: 'Flowstate pasted your words as heard',
      body: 'Add a cleanup key in Settings to also fix punctuation and filler words. '
        + 'Your speech never leaves this PC.',
      silent: true,
    }).show();
  } catch {
    // A notification is a courtesy, never a dependency.
  }
}

function stopWorker() {
  workerManager?.stop();
  workerManager = undefined;
}

function stopDictationRuntime() {
  hotkeyManager?.stop();
  hotkeyManager = undefined;
  dictationController?.dispose();
  dictationController = undefined;
  recorderManager?.dispose();
  recorderManager = undefined;
  testRunner = undefined;
  runtimeStarted = false;
}

function startWorker(modelsDirectory) {
  const workerPath = path.join(__dirname, '..', 'worker', 'index.js');
  workerManager = createAsrWorkerManager({
    fork: (...args) => utilityProcess.fork(...args),
    workerPath,
    workerArgs: [modelsDirectory, configStore.get().asr.hotwords === false ? '0' : '1'],
    getHotwords: () => (
      configStore.get().asr.hotwords === false
        ? ''
        : buildStreamHotwords(dictionaryStore?.list() ?? [])
    ),
    getUnloadAfterMs: () => configStore.get().asr.unloadAfterMinutes * 60_000,
    onStateChange: ({ status, error }) => {
      if (status === 'ready') {
        console.log('Flowstate ASR worker ready.');
      } else if (status === 'error') {
        (appLogger ?? console).error(`Flowstate ASR worker unavailable: ${error}`);
        dialog.showErrorBox(
          'Speech recognition unavailable',
          error || 'The speech recognition worker stopped unexpectedly.'
        );
      }
    },
  });
  workerManager.start();
  configStore.on('change', () => workerManager?.refreshIdleTimer());
}

function startDictationRuntime() {
  if (runtimeStarted) return;
  if (!modelManager || modelManager.getState().phase !== 'ready') {
    throw new Error('Cannot start dictation before the speech model is ready.');
  }

  runtimeStarted = true;
  startWorker(modelManager.getModelsDirectory());
  const focus = createFocusTracker();
  historyStore ??= createHistoryBuffer();
  const pasteService = createPasteService({
    clipboard,
    nativeImage,
    focus,
    history: historyStore,
    logger: appLogger,
  });
  // Dictating with the Scratchpad foreground inserts at its caret directly.
  const injector = createScratchRouter({
    injector: pasteService,
    history: historyStore,
    isActive: () => scratchSession.active,
    deliver: (text) => ipcBridge?.insertIntoScratchpad(text) === true,
    logger: appLogger,
  });
  const llm = llmService;
  recorderManager = createRecorderManager({
    BrowserWindow,
    ipcMain,
    session: session.defaultSession,
    // FLOWSTATE_WARM_HOLD_MS=0 turns the warm hold off (mic closes after each use).
    getWarmHoldMs: () => {
      const override = Number(process.env.FLOWSTATE_WARM_HOLD_MS);
      return process.env.FLOWSTATE_WARM_HOLD_MS !== undefined && Number.isFinite(override)
        ? override
        : DEFAULT_WARM_HOLD_MS;
    },
    onAmplitude: (amplitude) => dictationController?.pushAmplitude(amplitude),
  });
  dictationController = createDictationController({
    recorder: recorderManager,
    worker: workerManager,
    llm,
    injector,
    windows: windowManager,
    focus,
    getConfig: () => configStore.get(),
    getSnippets: () => snippetsStore.list(),
    getDictionaryTerms: () => dictionaryStore.list(),
    recordSnippetUses: (ids) => snippetsStore.recordUses(ids),
    recordDictionaryCorrections: (ids) =>
      dictionaryStore.recordCorrections(ids),
    recordHistoryOutcome: (outcome) => historyStore?.recordOutcome?.(outcome),
    isEnabled: () => dictationEnabled,
    onResult: (result) => {
      ipcBridge?.notifyDictationResult(result);
      maybeExplainRawTranscript(result);
    },
    logger: appLogger,
  });
  testRunner = createTestRunner({
    recorder: recorderManager,
    worker: workerManager,
    windows: windowManager,
    getConfig: () => configStore.get(),
  });
  hotkeyManager = createGlobalHotkey({
    hook: uIOhook,
    chord: configStore.get().hotkey.chord,
    onArm: () => dictationController.handleHotkeyArm(),
    onDisarm: () => dictationController.handleHotkeyDisarm(),
    onDown: () => dictationController.handleHotkeyDown(),
    onUp: (reason) => dictationController.handleHotkeyUp(reason),
    onWatchdog: () => {
      console.warn('Dictation watchdog fired after 120 seconds.');
    },
  });
  hotkeyManager.start();
  configStore.on('change', (config) => {
    if (
      JSON.stringify(hotkeyManager?.getChord())
      === JSON.stringify(config.hotkey.chord)
    ) {
      return;
    }
    try {
      hotkeyManager?.updateChord(config.hotkey.chord);
    } catch (error) {
      console.error(`Hotkey configuration rejected: ${error.message}`);
    }
  });
}

/* flowstate.db sits beside config.json. If it cannot open (locked by a
   second copy, corrupt, a newer schema from a later build), dictation must
   still work: fall back to the session-only buffer and say why, rather than
   refusing to paste. */
function openHistoryStore(configDirectory) {
  try {
    return createHistoryDatabase({
      filePath: path.join(configDirectory, 'flowstate.db'),
      getRetentionDays: () => configStore.get().history.retentionDays,
      logger: appLogger,
    });
  } catch (error) {
    appLogger.error(
      `Flowstate history database unavailable; this session's dictations ` +
        `are kept in memory only: ${error.message}`
    );
    return createHistoryBuffer();
  }
}

async function initialise() {
  const configDirectory = path.join(app.getPath('appData'), 'flowstate');
  configStore = createConfigStore({ directory: configDirectory });
  await configStore.load();

  dictionaryStore = createDictionaryStore({ directory: configDirectory });
  await dictionaryStore.load();

  snippetsStore = createSnippetsStore({ directory: configDirectory });
  await snippetsStore.load();

  scratchStore = createScratchStore({ directory: configDirectory });
  await scratchStore.load();

  // Created early so every later service can log through it: an error found
  // during startup is exactly the kind the About screen's diagnostics should
  // be able to show.
  errorLog = createErrorLog({ directory: path.join(configDirectory, 'logs') });
  appLogger = withErrorCapture(console, errorLog);

  historyStore = openHistoryStore(configDirectory);
  let retentionDays = configStore.get().history.retentionDays;
  configStore.on('change', (config) => {
    // Shortening retention takes effect now, not at the next restart. Every
    // other settings write (window bounds on each move) leaves it alone.
    if (config.history.retentionDays === retentionDays) return;
    retentionDays = config.history.retentionDays;
    if (typeof historyStore?.applyRetention !== 'function') return;
    try {
      historyStore.applyRetention(config.history.retentionDays);
    } catch (error) {
      appLogger.error(`Flowstate history retention failed: ${error.message}`);
    }
  });

  llmService = createLlmService({
    getConfig: () => configStore.get(),
    logger: appLogger,
  });

  updater = createUpdater({
    currentVersion: app.getVersion(),
    manifestUrl: UPDATE_MANIFEST_URL,
    publicKeyPem: UPDATE_PUBLIC_KEY_PEM,
    downloadDirectory: path.join(app.getPath('temp'), 'flowstate-update'),
    executablePath: process.execPath,
    spawnProcess: (...args) => require('node:child_process').spawn(...args),
    // The speech worker holds DLLs the installer has to replace.
    prepareForInstall: async () => {
      if (!app.isPackaged) {
        throw new Error('Updates are only installed by the packaged app.');
      }
      stopDictationRuntime();
      stopWorker();
    },
    quitApp: () => app.quit(),
    logger: appLogger,
  });

  const localAppData =
    process.env.LOCALAPPDATA
    || path.resolve(app.getPath('appData'), '..', 'Local');
  modelManager = createModelManager({
    modelsDirectory: path.join(localAppData, 'flowstate', 'models'),
    logger: appLogger,
  });
  await modelManager.inspect();

  // Real, static facts only â€” never a guessed or curated string. CPU model
  // and total RAM come from the OS actually running this process.
  const cpu = os.cpus()[0];
  const versions = Object.freeze({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    modelVersion: MODEL_NAME,
    sherpaVersion: PACKAGE_DEPENDENCIES['sherpa-onnx-node'],
    platform: `Windows ${os.release()} Â· ${cpu ? cpu.model : os.arch()} Â· `
      + `${Math.round(os.totalmem() / (1024 ** 3))} GB`,
    configLocation: configStore.filePath,
    logLocation: errorLog.directory,
  });

  /* The shell's own channels: theme, the frameless window's controls, and the
     fixtures the screens still read. Created before any window exists, because
     index.html asks for the theme synchronously during its first paint. */
  shellBridge = createShellBridge({
    ipcMain,
    nativeTheme,
    config: configStore,
    windowFromWebContents: (webContents) => BrowserWindow.fromWebContents(webContents),
    getWindows: () => BrowserWindow.getAllWindows(),
    handleTheme: false,
  });

  microphoneService = createMicrophoneService({
    BrowserWindow,
    ipcMain,
    session: session.fromPartition('mic-devices'),
  });
  // Its own session partition, never session.defaultSession: recorder.js sets
  // its own permission handler there for the real dictation capture, and
  // Electron only keeps the last handler a session receives. An isolated
  // partition means the Dictation screen's live level meter cannot fight that
  // handler for the audio-permission grant.
  microphonePreviewService = createMicPreviewService({
    BrowserWindow,
    ipcMain,
    session: session.fromPartition('mic-preview-meter'),
  });
  const autostart = createAutostartManager({
    executablePath: process.execPath,
    appPath: app.getAppPath(),
    isPackaged: app.isPackaged,
  });
  // A packaged first run must honour the schema default. Development runs only
  // touch the Run key when the user explicitly toggles the setting.
  if (app.isPackaged) {
    try {
      await autostart.set(configStore.get().system.autostart);
    } catch (error) {
      // Autostart is optional. A registry policy must not prevent offline
      // dictation from launching; the explicit settings toggle surfaces the
      // same verified failure to the user.
      console.warn(`Flowstate could not verify autostart: ${error.message}`);
    }
  }
  ipcBridge = createIpcBridge({
    ipcMain,
    config: configStore,
    dictionary: dictionaryStore,
    snippets: snippetsStore,
    scratch: scratchStore,
    scratchSession,
    saveTextFile: async (text) => {
      const parent = BrowserWindow.getFocusedWindow() ?? undefined;
      const picked = await dialog.showSaveDialog(parent, {
        title: 'Export Scratchpad',
        defaultPath: 'scratchpad.txt',
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      if (picked.canceled || !picked.filePath) return { saved: false };
      await require('node:fs/promises').writeFile(picked.filePath, text, 'utf8');
      return { saved: true, fileName: require('node:path').basename(picked.filePath) };
    },
    mics: microphoneService,
    autostart,
    theme: {
      get: () => shellBridge.getTheme(),
      set: (mode) => shellBridge.setTheme(mode),
    },
    getHotkeyManager: () => hotkeyManager,
    model: modelManager,
    micPreview: microphonePreviewService,
    getTestRunner: () => testRunner,
    getHistory: () => historyStore,
    rePaste: createRePaster({
      clipboard,
      user32: createNativeUser32(),
      getWindows: () => BrowserWindow.getAllWindows(),
      logger: appLogger,
    }),
    errorLog,
    clipboard,
    shell,
    versions,
    docs: DOC_TARGETS,
    llm: llmService,
    updater,
    getWindows: () => BrowserWindow.getAllWindows(),
  });

  // screen is only safe to touch after `ready`, which is where this runs. The
  // pill needs it to find the display the user is actually working on.
  windowManager = createWindowManager({
    BrowserWindow,
    screen,
    windowState: {
      load: () => configStore.get().ui.windowBounds,
      save: (bounds) => {
        // Geometry is not worth interrupting the user over: if the write fails,
        // the window opens at its default next time and nothing else breaks.
        void configStore
          .update({ ui: { windowBounds: bounds } })
          .catch((error) => console.error(`Flowstate could not save the window bounds: ${error.message}`));
      },
    },
    onWindowState: (window) => shellBridge?.notifyWindowState(window),
  });
  modelWindowController = createModelWindowController({
    BrowserWindow,
    ipcMain,
    modelManager,
    onReady: () => {
      try {
        startDictationRuntime();
      } catch (error) {
        errorLog?.record(`startup: ${error.message}`);
        dialog.showErrorBox(
          'Flowstate could not start dictation',
          error.message
        );
      }
    },
  });

  appTray = createAppTray({
    Menu,
    Tray,
    nativeImage,
    dictationEnabled,
    onOpen: openMainWindow,
    onSettings: () => windowManager.openSettings(),
    onDictationChange: (enabled) => {
      dictationEnabled = enabled;
      if (!enabled) dictationController.cancel();
    },
    onQuit: () => app.quit(),
  });

  // Start dictation the moment the model is ready, whichever screen asked for
  // the download (first-run setup or the small download window).
  modelManager.onStatus((status) => {
    if (status.phase !== 'ready' || runtimeStarted) return;
    try {
      startDictationRuntime();
    } catch (error) {
      errorLog?.record(`startup: ${error.message}`);
    }
  });

  const onboarding = needsOnboarding();
  if (modelManager.getState().phase === 'ready') {
    startDictationRuntime();
  } else if (!onboarding) {
    modelWindowController.open();
  }

  // Launched by the sign-in Run key and set to start minimised: stay in the
  // tray. Any other launch, and always the first one, shows the window.
  const launchedAtSignIn = process.argv.includes('--autostart');
  const stayInTray = launchedAtSignIn && configStore.get().system.startMinimised;
  if (openRequested || onboarding || !stayInTray) {
    openRequested = false;
    if (modelManager.getState().phase === 'ready' || onboarding) {
      windowManager.openMain(onboarding ? '/welcome' : '/dictation');
    }
  }
  if (app.isPackaged) updater.start();
}

if (selfTestFile) {
  app.whenReady().then(async () => {
    const report = await runSelfTest({
      argv: process.argv,
      utilityProcess,
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        packaged: app.isPackaged,
      },
    });
    app.exit(report?.ok ? 0 : 1);
  }).catch(() => app.exit(2));
} else if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', openMainWindow);
  app.on('window-all-closed', () => {
    // Tray-first app: closing the last window must not quit or retain a hidden
    // renderer. BrowserWindow close destroys the window by default.
  });
  app.on('before-quit', () => {
    updater?.stop();
    stopDictationRuntime();
    // close() flushes any dictation still queued for disk.
    historyStore?.close?.();
    historyStore = undefined;
    modelWindowController?.dispose();
    modelWindowController = undefined;
    ipcBridge?.dispose();
    ipcBridge = undefined;
    microphoneService?.dispose();
    microphoneService = undefined;
    microphonePreviewService?.dispose();
    microphonePreviewService = undefined;
    shellBridge?.dispose();
    shellBridge = undefined;
    windowManager?.destroyAll();
    stopWorker();
    appTray?.destroy();
  });
  app.whenReady().then(initialise).catch((error) => {
    dialog.showErrorBox(
      'Flowstate could not start',
      `The main process failed to initialise: ${error.message}`
    );
    app.quit();
  });
}
