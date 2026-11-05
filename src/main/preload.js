'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The GUI's complete v1 bridge and the only renderer surface.
 *
 * Sandboxed preloads cannot require local modules, so channel names are
 * duplicated from ipc.js and shell.js. Tests keep those lists from drifting.
 * No Electron or Node primitive crosses this bridge.
 */
const CHANNELS = Object.freeze({
  configGet: 'flowstate:config-get',
  configSet: 'flowstate:config-set',
  configChanged: 'flowstate:config-changed',
  micsList: 'flowstate:mics-list',
  micsWatchStart: 'flowstate:mics-watch-start',
  micsWatchStop: 'flowstate:mics-watch-stop',
  micsDeviceChanged: 'flowstate:mics-device-changed',
  micPreviewStart: 'flowstate:mic-preview-start',
  micPreviewStop: 'flowstate:mic-preview-stop',
  micPreviewLevel: 'flowstate:mic-preview-level',
  micPreviewError: 'flowstate:mic-preview-error',
  hotkeyGet: 'flowstate:hotkey-get',
  hotkeyStartRebind: 'flowstate:hotkey-start-rebind',
  hotkeyCancelRebind: 'flowstate:hotkey-cancel-rebind',
  hotkeyRebindResult: 'flowstate:hotkey-rebind-result',
  modelStatus: 'flowstate:model-status',
  modelDownload: 'flowstate:model-download',
  modelCancelDownload: 'flowstate:model-cancel-download',
  modelProgress: 'flowstate:model-progress',
  dictationStateChanged: 'flowstate:dictation-state-changed',
  dictationResult: 'flowstate:dictation-result',
  dictationTestRun: 'flowstate:dictation-test-run',
  historySearch: 'flowstate:history-search',
  historyRecent: 'flowstate:history-recent',
  historyDelete: 'flowstate:history-delete',
  historyClear: 'flowstate:history-clear',
  historyFacets: 'flowstate:history-facets',
  historyPaste: 'flowstate:history-paste',
  insightsSummary: 'flowstate:insights-summary',
  insightsStreak: 'flowstate:insights-streak',
  insightsByApp: 'flowstate:insights-by-app',
  insightsByLanguage: 'flowstate:insights-by-language',
  dictList: 'flowstate:dict-list',
  dictAdd: 'flowstate:dict-add',
  dictUpdate: 'flowstate:dict-update',
  dictRemove: 'flowstate:dict-remove',
  dictImport: 'flowstate:dict-import',
  dictExport: 'flowstate:dict-export',
  snippetsList: 'flowstate:snippets-list',
  snippetsAdd: 'flowstate:snippets-add',
  snippetsUpdate: 'flowstate:snippets-update',
  snippetsRemove: 'flowstate:snippets-remove',
  snippetsImport: 'flowstate:snippets-import',
  snippetsExport: 'flowstate:snippets-export',
  scratchGet: 'flowstate:scratch-get',
  scratchSet: 'flowstate:scratch-set',
  scratchActive: 'flowstate:scratch-active',
  scratchInsert: 'flowstate:scratch-insert',
  scratchCopy: 'flowstate:scratch-copy',
  scratchExport: 'flowstate:scratch-export',
  themeInitial: 'flowstate:theme-initial',
  themeGet: 'flowstate:theme-get',
  themeSet: 'flowstate:theme-set',
  themeSystemChanged: 'flowstate:theme-system-changed',
  appVersion: 'flowstate:app-version',
  appDiagnostics: 'flowstate:app-diagnostics',
  appOpenLogs: 'flowstate:app-open-logs',
  appReveal: 'flowstate:app-reveal',
  appOpenDoc: 'flowstate:app-open-doc',
  llmProviders: 'flowstate:llm-providers',
  llmTest: 'flowstate:llm-test',
  updateState: 'flowstate:update-state',
  updateCheck: 'flowstate:update-check',
  updateInstall: 'flowstate:update-install',
  updateDismiss: 'flowstate:update-dismiss',
  updateChanged: 'flowstate:update-changed',
  windowMinimise: 'flowstate:window-minimise',
  windowToggleMaximise: 'flowstate:window-toggle-maximise',
  windowClose: 'flowstate:window-close',
  windowState: 'flowstate:window-state',
  windowStateChanged: 'flowstate:window-state-changed',
  fixture: 'flowstate:fixture',
});

function subscribe(channel, callback) {
  if (typeof callback !== 'function') {
    throw new TypeError('a subscription callback must be a function.');
  }
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

let micSubscriberCount = 0;

function subscribeToMics(callback) {
  const unsubscribe = subscribe(CHANNELS.micsDeviceChanged, callback);
  micSubscriberCount += 1;
  if (micSubscriberCount === 1) {
    void ipcRenderer.invoke(CHANNELS.micsWatchStart).catch(() => {});
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unsubscribe();
    micSubscriberCount = Math.max(0, micSubscriberCount - 1);
    if (micSubscriberCount === 0) {
      void ipcRenderer.invoke(CHANNELS.micsWatchStop).catch(() => {});
    }
  };
}

contextBridge.exposeInMainWorld('flow', Object.freeze({
  config: Object.freeze({
    get: () => ipcRenderer.invoke(CHANNELS.configGet),
    set: (patch) => ipcRenderer.invoke(CHANNELS.configSet, patch),
    onChange: (callback) => subscribe(CHANNELS.configChanged, callback),
  }),

  mics: Object.freeze({
    list: () => ipcRenderer.invoke(CHANNELS.micsList),
    onDeviceChange: subscribeToMics,
  }),

  micPreview: Object.freeze({
    start: (deviceId) => ipcRenderer.invoke(CHANNELS.micPreviewStart, deviceId ?? null),
    stop: () => ipcRenderer.invoke(CHANNELS.micPreviewStop),
    onLevel: (callback) => subscribe(CHANNELS.micPreviewLevel, callback),
    onError: (callback) => subscribe(CHANNELS.micPreviewError, callback),
  }),

  hotkey: Object.freeze({
    get: () => ipcRenderer.invoke(CHANNELS.hotkeyGet),
    startRebind: () => ipcRenderer.invoke(CHANNELS.hotkeyStartRebind),
    cancelRebind: () => ipcRenderer.invoke(CHANNELS.hotkeyCancelRebind),
    onRebindResult: (callback) => subscribe(CHANNELS.hotkeyRebindResult, callback),
  }),

  model: Object.freeze({
    status: () => ipcRenderer.invoke(CHANNELS.modelStatus),
    download: () => ipcRenderer.invoke(CHANNELS.modelDownload),
    cancelDownload: () => ipcRenderer.invoke(CHANNELS.modelCancelDownload),
    onProgress: (callback) => subscribe(CHANNELS.modelProgress, callback),
  }),

  dictation: Object.freeze({
    onStateChange: (callback) =>
      subscribe(CHANNELS.dictationStateChanged, callback),
    onResult: (callback) => subscribe(CHANNELS.dictationResult, callback),
    testRun: () => ipcRenderer.invoke(CHANNELS.dictationTestRun),
  }),

  history: Object.freeze({
    search: (query, filters) =>
      ipcRenderer.invoke(CHANNELS.historySearch, query, filters),
    recent: (count) => ipcRenderer.invoke(CHANNELS.historyRecent, count),
    delete: (id) => ipcRenderer.invoke(CHANNELS.historyDelete, id),
    clear: () => ipcRenderer.invoke(CHANNELS.historyClear),
    facets: () => ipcRenderer.invoke(CHANNELS.historyFacets),
    paste: (id) => ipcRenderer.invoke(CHANNELS.historyPaste, id),
  }),

  insights: Object.freeze({
    summary: (period) => ipcRenderer.invoke(CHANNELS.insightsSummary, period),
    streak: () => ipcRenderer.invoke(CHANNELS.insightsStreak),
    byApp: (period) => ipcRenderer.invoke(CHANNELS.insightsByApp, period),
    byLanguage: (period) => ipcRenderer.invoke(CHANNELS.insightsByLanguage, period),
  }),

  dict: Object.freeze({
    list: () => ipcRenderer.invoke(CHANNELS.dictList),
    add: (term) => ipcRenderer.invoke(CHANNELS.dictAdd, term),
    update: (id, term) => ipcRenderer.invoke(CHANNELS.dictUpdate, id, term),
    remove: (id) => ipcRenderer.invoke(CHANNELS.dictRemove, id),
    import: (json) => ipcRenderer.invoke(CHANNELS.dictImport, json),
    export: () => ipcRenderer.invoke(CHANNELS.dictExport),
  }),

  snippets: Object.freeze({
    list: () => ipcRenderer.invoke(CHANNELS.snippetsList),
    add: (snippet) => ipcRenderer.invoke(CHANNELS.snippetsAdd, snippet),
    update: (id, snippet) =>
      ipcRenderer.invoke(CHANNELS.snippetsUpdate, id, snippet),
    remove: (id) => ipcRenderer.invoke(CHANNELS.snippetsRemove, id),
    import: (json) => ipcRenderer.invoke(CHANNELS.snippetsImport, json),
    export: () => ipcRenderer.invoke(CHANNELS.snippetsExport),
  }),

  scratch: Object.freeze({
    get: () => ipcRenderer.invoke(CHANNELS.scratchGet),
    set: (text) => ipcRenderer.invoke(CHANNELS.scratchSet, text),
    // True while the editor is on screen: dictation then inserts at the caret
    // instead of pasting through the clipboard.
    setActive: (active) => ipcRenderer.invoke(CHANNELS.scratchActive, active),
    onInsert: (callback) => subscribe(CHANNELS.scratchInsert, callback),
    copy: () => ipcRenderer.invoke(CHANNELS.scratchCopy),
    export: () => ipcRenderer.invoke(CHANNELS.scratchExport),
  }),

  theme: Object.freeze({
    // Synchronous and called once from <head>, before stylesheets paint.
    initial: () => ipcRenderer.sendSync(CHANNELS.themeInitial),
    get: () => ipcRenderer.invoke(CHANNELS.themeGet),
    set: (mode) => ipcRenderer.invoke(CHANNELS.themeSet, mode),
    onSystemChange: (callback) => subscribe(CHANNELS.themeSystemChanged, callback),
  }),

  app: Object.freeze({
    version: () => ipcRenderer.invoke(CHANNELS.appVersion),
    diagnostics: () => ipcRenderer.invoke(CHANNELS.appDiagnostics),
    openLogs: () => ipcRenderer.invoke(CHANNELS.appOpenLogs),
    // A closed set of real, machine-local targets — never an arbitrary path
    // from the renderer. Mirrors the same closed-list shape shell.js already
    // uses for fixtures.
    reveal: (kind) => ipcRenderer.invoke(CHANNELS.appReveal, kind),
    openDoc: (key) => ipcRenderer.invoke(CHANNELS.appOpenDoc, key),
  }),

  llm: Object.freeze({
    providers: () => ipcRenderer.invoke(CHANNELS.llmProviders),
    test: () => ipcRenderer.invoke(CHANNELS.llmTest),
  }),

  update: Object.freeze({
    state: () => ipcRenderer.invoke(CHANNELS.updateState),
    check: () => ipcRenderer.invoke(CHANNELS.updateCheck),
    install: () => ipcRenderer.invoke(CHANNELS.updateInstall),
    dismiss: () => ipcRenderer.invoke(CHANNELS.updateDismiss),
    onChange: (callback) => subscribe(CHANNELS.updateChanged, callback),
  }),

  // Shell-only additions required by the frameless desktop window.
  window: Object.freeze({
    minimise: () => ipcRenderer.invoke(CHANNELS.windowMinimise),
    toggleMaximise: () => ipcRenderer.invoke(CHANNELS.windowToggleMaximise),
    close: () => ipcRenderer.invoke(CHANNELS.windowClose),
    state: () => ipcRenderer.invoke(CHANNELS.windowState),
    onStateChange: (callback) => subscribe(CHANNELS.windowStateChanged, callback),
  }),

  // Temporary scaffolding until each later screen lands its real data service.
  fixtures: Object.freeze({
    get: (name) => ipcRenderer.invoke(CHANNELS.fixture, name),
  }),
}));
