'use strict';

const path = require('node:path');
const { validateRebindChord } = require('./hotkey');
const { computeDictionaryBudget } = require('../shared/dictionary-prompt');
const { computeSnippetConflicts } = require('../shared/snippet-conflicts');
const { LLM_PROVIDERS } = require('../shared/llm-providers');

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
});

const REVEAL_KINDS = Object.freeze(['model', 'config', 'logs']);

const THEME_MODES = Object.freeze(['system', 'light', 'dark']);
const LANGUAGES = Object.freeze(['en', 'de', 'el']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function copyObject(value) {
  return structuredClone(value);
}

function requirePlainObject(value, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object.`);
}

function requireKnownKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw new TypeError(`${label} contains unsupported key "${key}".`);
    }
  }
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean.`);
  return value;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function requireString(value, label, { allowEmpty = false, maximum = 4_096 } = {}) {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new TypeError(`${label} must be a string of at most ${maximum} characters.`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new TypeError(`${label} cannot be empty.`);
  }
  return value;
}

function validateConfigPatch(patch) {
  requirePlainObject(patch, 'Config patch');
  requireKnownKeys(
    patch,
    ['hotkey', 'audio', 'asr', 'llm', 'ui', 'system', 'history', 'onboarding'],
    'Config patch'
  );
  const result = {};

  if ('hotkey' in patch) {
    requirePlainObject(patch.hotkey, 'hotkey');
    requireKnownKeys(patch.hotkey, ['chord'], 'hotkey');
    const validation = validateRebindChord(patch.hotkey.chord);
    if (!validation.ok) throw new TypeError(validation.reason);
    result.hotkey = { chord: validation.chord };
  }

  if ('audio' in patch) {
    requirePlainObject(patch.audio, 'audio');
    requireKnownKeys(patch.audio, ['deviceId'], 'audio');
    const deviceId = patch.audio.deviceId;
    if (deviceId !== null) requireString(deviceId, 'audio.deviceId', { maximum: 1_024 });
    result.audio = { deviceId };
  }

  if ('asr' in patch) {
    requirePlainObject(patch.asr, 'asr');
    requireKnownKeys(patch.asr, ['languages', 'unloadAfterMinutes', 'hotwords'], 'asr');
    result.asr = {};
    if ('languages' in patch.asr) {
      const languages = patch.asr.languages;
      if (
        !Array.isArray(languages)
        || languages.length < 1
        || languages.length > LANGUAGES.length
        || new Set(languages).size !== languages.length
        || languages.some((language) => !LANGUAGES.includes(language))
      ) {
        throw new TypeError('asr.languages must contain unique supported language codes.');
      }
      result.asr.languages = languages.slice();
    }
    if ('hotwords' in patch.asr) {
      if (typeof patch.asr.hotwords !== 'boolean') {
        throw new TypeError('asr.hotwords must be a boolean.');
      }
      result.asr.hotwords = patch.asr.hotwords;
    }
    if ('unloadAfterMinutes' in patch.asr) {
      result.asr.unloadAfterMinutes = requireInteger(
        patch.asr.unloadAfterMinutes,
        'asr.unloadAfterMinutes',
        0,
        1_440
      );
    }
  }

  if ('llm' in patch) {
    requirePlainObject(patch.llm, 'llm');
    requireKnownKeys(
      patch.llm,
      [
        'provider',
        'apiKey',
        'baseUrl',
        'model',
        'enabled',
        'timeoutMs',
        'skipUnderWords',
        'removeFillers',
      ],
      'llm'
    );
    result.llm = {};
    if ('provider' in patch.llm) {
      const provider = requireString(patch.llm.provider, 'llm.provider', {
        maximum: 64,
      });
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(provider)) {
        throw new TypeError(
          'llm.provider must be a lowercase provider identifier.'
        );
      }
      result.llm.provider = provider;
    }
    if ('apiKey' in patch.llm) {
      result.llm.apiKey = requireString(patch.llm.apiKey, 'llm.apiKey', {
        allowEmpty: true,
      });
    }
    if ('baseUrl' in patch.llm) {
      const baseUrl = requireString(patch.llm.baseUrl, 'llm.baseUrl', {
        allowEmpty: true,
        maximum: 512,
      }).trim();
      if (baseUrl !== '' && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
        throw new TypeError('llm.baseUrl must start with http:// or https://.');
      }
      result.llm.baseUrl = baseUrl;
    }
    if ('model' in patch.llm) {
      result.llm.model = requireString(patch.llm.model, 'llm.model', {
        allowEmpty: true,
        maximum: 128,
      }).trim();
    }
    if ('enabled' in patch.llm) {
      result.llm.enabled = requireBoolean(patch.llm.enabled, 'llm.enabled');
    }
    if ('timeoutMs' in patch.llm) {
      result.llm.timeoutMs = requireInteger(
        patch.llm.timeoutMs,
        'llm.timeoutMs',
        100,
        10_000
      );
    }
    if ('skipUnderWords' in patch.llm) {
      result.llm.skipUnderWords = requireInteger(
        patch.llm.skipUnderWords,
        'llm.skipUnderWords',
        0,
        100
      );
    }
    if ('removeFillers' in patch.llm) {
      result.llm.removeFillers = requireBoolean(
        patch.llm.removeFillers,
        'llm.removeFillers'
      );
    }
  }

  if ('ui' in patch) {
    requirePlainObject(patch.ui, 'ui');
    // windowBounds is owned by the main process's window-state service. A
    // renderer may choose a theme, but it may not place arbitrary windows.
    requireKnownKeys(patch.ui, ['theme'], 'ui');
    if (!THEME_MODES.includes(patch.ui.theme)) {
      throw new TypeError('ui.theme must be system, light, or dark.');
    }
    result.ui = { theme: patch.ui.theme };
  }

  if ('system' in patch) {
    requirePlainObject(patch.system, 'system');
    requireKnownKeys(patch.system, ['autostart', 'startMinimised'], 'system');
    result.system = {};
    if ('autostart' in patch.system) {
      result.system.autostart = requireBoolean(
        patch.system.autostart,
        'system.autostart'
      );
    }
    if ('startMinimised' in patch.system) {
      result.system.startMinimised = requireBoolean(
        patch.system.startMinimised,
        'system.startMinimised'
      );
    }
  }

  if ('onboarding' in patch) {
    requirePlainObject(patch.onboarding, 'onboarding');
    requireKnownKeys(patch.onboarding, ['completed'], 'onboarding');
    result.onboarding = {
      completed: requireBoolean(patch.onboarding.completed, 'onboarding.completed'),
    };
  }

  if ('history' in patch) {
    requirePlainObject(patch.history, 'history');
    requireKnownKeys(patch.history, ['retentionDays'], 'history');
    result.history = {
      retentionDays: requireInteger(
        patch.history.retentionDays,
        'history.retentionDays',
        0,
        36_500
      ),
    };
  }

  return result;
}

function publicConfig(config) {
  const snapshot = copyObject(config);
  const apiKey = snapshot.llm?.apiKey;
  if (snapshot.llm) {
    delete snapshot.llm.apiKey;
    snapshot.llm.apiKeyConfigured =
      typeof apiKey === 'string' && apiKey.trim().length > 0;
  }
  return snapshot;
}

function requireNoArgs(args, label) {
  if (args.length !== 0) throw new TypeError(`${label} takes no arguments.`);
}

function createIpcBridge({
  ipcMain,
  config,
  dictionary,
  snippets,
  scratch,
  scratchSession,
  saveTextFile,
  mics,
  autostart,
  theme,
  getHotkeyManager,
  model,
  micPreview,
  getTestRunner,
  getHistory,
  rePaste,
  errorLog,
  clipboard,
  shell,
  versions,
  docs,
  llm,
  updater,
  getWindows = () => [],
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new TypeError('createIpcBridge requires ipcMain.');
  }
  if (!config || typeof config.get !== 'function' || typeof config.update !== 'function') {
    throw new TypeError('createIpcBridge requires the config store.');
  }
  if (
    !dictionary
    || typeof dictionary.list !== 'function'
    || typeof dictionary.add !== 'function'
  ) {
    throw new TypeError('createIpcBridge requires the dictionary store.');
  }
  if (
    !snippets
    || typeof snippets.list !== 'function'
    || typeof snippets.add !== 'function'
  ) {
    throw new TypeError('createIpcBridge requires the snippets store.');
  }
  if (!mics || typeof mics.list !== 'function' || typeof mics.watch !== 'function') {
    throw new TypeError('createIpcBridge requires the microphone service.');
  }
  if (!autostart || typeof autostart.set !== 'function') {
    throw new TypeError('createIpcBridge requires the autostart manager.');
  }
  if (!theme || typeof theme.get !== 'function' || typeof theme.set !== 'function') {
    throw new TypeError('createIpcBridge requires the theme controller.');
  }
  if (!model || typeof model.getState !== 'function') {
    throw new TypeError('createIpcBridge requires the model manager.');
  }

  const handled = [];
  const micWatchers = new Map();
  let activeRebind = null;
  let previewSubscriber = null;

  function handle(channel, callback) {
    ipcMain.handle(channel, callback);
    handled.push(channel);
  }

  function sendToWindows(channel, payload) {
    for (const window of getWindows()) {
      if (!window || window.isDestroyed()) continue;
      window.webContents.send(channel, copyObject(payload));
    }
  }

  function senderId(event, label) {
    if (!Number.isInteger(event?.sender?.id)) {
      throw new TypeError(`${label} requires a live renderer sender.`);
    }
    return event.sender.id;
  }

  async function updateConfig(patch) {
    const validated = validateConfigPatch(patch);
    const changesAutostart =
      validated.system && Object.hasOwn(validated.system, 'autostart');
    const previousAutostart = config.get().system.autostart;

    if (changesAutostart) {
      await autostart.set(validated.system.autostart);
    }
    try {
      return publicConfig(await config.update(validated));
    } catch (error) {
      if (changesAutostart) {
        try {
          await autostart.set(previousAutostart);
        } catch {
          // Preserve the config write error. The next explicit toggle performs
          // another registry read-back and will surface a mismatch honestly.
        }
      }
      throw error;
    }
  }

  handle(CHANNELS.configGet, (_event, ...args) => {
    requireNoArgs(args, 'config.get');
    return publicConfig(config.get());
  });
  handle(CHANNELS.configSet, (_event, patch, ...rest) => {
    if (rest.length !== 0) throw new TypeError('config.set takes one patch.');
    return updateConfig(patch);
  });

  handle(CHANNELS.micsList, (_event, ...args) => {
    requireNoArgs(args, 'mics.list');
    return mics.list();
  });
  handle(CHANNELS.micsWatchStart, (event, ...args) => {
    requireNoArgs(args, 'mics.onDeviceChange');
    const id = senderId(event, 'mics.onDeviceChange');
    if (!micWatchers.has(id)) {
      const release = mics.watch();
      const sender = event.sender;
      const cleanup = () => {
        const watcher = micWatchers.get(id);
        if (!watcher) return;
        micWatchers.delete(id);
        watcher.release();
      };
      micWatchers.set(id, { sender, release, cleanup });
      if (typeof sender.once === 'function') sender.once('destroyed', cleanup);
    }
    return Object.freeze({ watching: true });
  });
  handle(CHANNELS.micsWatchStop, (event, ...args) => {
    requireNoArgs(args, 'mics.onDeviceChange unsubscribe');
    const id = senderId(event, 'mics.onDeviceChange unsubscribe');
    const watcher = micWatchers.get(id);
    if (!watcher) return Object.freeze({ watching: false });
    micWatchers.delete(id);
    watcher.release();
    if (typeof watcher.sender.removeListener === 'function') {
      watcher.sender.removeListener('destroyed', watcher.cleanup);
    }
    return Object.freeze({ watching: false });
  });

  function releasePreviewSubscriber(id) {
    if (!previewSubscriber || previewSubscriber.id !== id) return;
    if (typeof previewSubscriber.sender.removeListener === 'function') {
      previewSubscriber.sender.removeListener('destroyed', previewSubscriber.onDestroyed);
    }
    previewSubscriber = null;
  }

  handle(CHANNELS.micPreviewStart, (event, deviceId, ...rest) => {
    if (rest.length !== 0) throw new TypeError('micPreview.start takes one deviceId argument.');
    const normalisedDeviceId = deviceId === undefined ? null : deviceId;
    if (normalisedDeviceId !== null && typeof normalisedDeviceId !== 'string') {
      throw new TypeError('micPreview.start deviceId must be a string or null.');
    }
    if (!micPreview || typeof micPreview.start !== 'function') {
      throw new Error('Microphone preview is not available yet.');
    }
    const id = senderId(event, 'micPreview.start');
    const sender = event.sender;
    if (previewSubscriber && previewSubscriber.id !== id) releasePreviewSubscriber(previewSubscriber.id);

    const onDestroyed = () => {
      releasePreviewSubscriber(id);
      micPreview.stop();
    };
    previewSubscriber = { id, sender, onDestroyed };
    if (typeof sender.once === 'function') sender.once('destroyed', onDestroyed);

    micPreview.start(normalisedDeviceId);
    return Object.freeze({ watching: true });
  });
  handle(CHANNELS.micPreviewStop, (event, ...args) => {
    requireNoArgs(args, 'micPreview.stop');
    const id = senderId(event, 'micPreview.stop');
    releasePreviewSubscriber(id);
    micPreview?.stop();
    return Object.freeze({ watching: false });
  });

  handle(CHANNELS.hotkeyGet, (_event, ...args) => {
    requireNoArgs(args, 'hotkey.get');
    return Object.freeze({ chord: config.get().hotkey.chord.slice() });
  });
  handle(CHANNELS.hotkeyStartRebind, (event, ...args) => {
    requireNoArgs(args, 'hotkey.startRebind');
    const manager = getHotkeyManager?.();
    if (!manager || typeof manager.startRebind !== 'function') {
      throw new Error('Hotkey capture is not available yet.');
    }
    if (activeRebind) throw new Error('Hotkey rebind capture is already active.');

    const sender = event.sender;
    const id = senderId(event, 'hotkey.startRebind');
    const onDestroyed = () => {
      if (activeRebind?.id === id) manager.cancelRebind();
    };
    activeRebind = { id, sender, onDestroyed };
    if (typeof sender.once === 'function') sender.once('destroyed', onDestroyed);

    try {
      manager.startRebind((result) => {
        const active = activeRebind;
        activeRebind = null;
        if (active && typeof active.sender.removeListener === 'function') {
          active.sender.removeListener('destroyed', active.onDestroyed);
        }
        if (!active || active.sender.isDestroyed?.()) return;

        if (result.status !== 'accepted') {
          active.sender.send(CHANNELS.hotkeyRebindResult, result);
          return;
        }
        void config.update({ hotkey: { chord: result.chord } }).then(
          (updated) => active.sender.send(CHANNELS.hotkeyRebindResult, {
            ...result,
            chord: updated.hotkey.chord.slice(),
          }),
          (error) => active.sender.send(CHANNELS.hotkeyRebindResult, {
            status: 'rejected',
            chord: result.chord,
            reason: `The shortcut could not be saved: ${error.message}`,
          })
        );
      });
    } catch (error) {
      activeRebind = null;
      if (typeof sender.removeListener === 'function') {
        sender.removeListener('destroyed', onDestroyed);
      }
      throw error;
    }
    return Object.freeze({ status: 'capturing' });
  });
  handle(CHANNELS.hotkeyCancelRebind, (event, ...args) => {
    requireNoArgs(args, 'hotkey.cancelRebind');
    const id = senderId(event, 'hotkey.cancelRebind');
    if (!activeRebind || activeRebind.id !== id) return false;
    return Boolean(getHotkeyManager?.()?.cancelRebind());
  });

  handle(CHANNELS.modelStatus, (_event, ...args) => {
    requireNoArgs(args, 'model.status');
    return copyObject(model.getState());
  });
  handle(CHANNELS.modelDownload, (_event, ...args) => {
    requireNoArgs(args, 'model.download');
    return model.download();
  });
  handle(CHANNELS.modelCancelDownload, (_event, ...args) => {
    requireNoArgs(args, 'model.cancelDownload');
    return Object.freeze({
      cancelled: Boolean(model.cancel()),
      status: copyObject(model.getState()),
    });
  });

  handle(CHANNELS.dictationTestRun, (_event, ...args) => {
    requireNoArgs(args, 'dictation.testRun');
    const runner = getTestRunner?.();
    if (!runner || typeof runner.run !== 'function') {
      throw new Error('Test dictation is not available yet.');
    }
    return runner.run();
  });

  /* --- dictionary: durable JSON store (#24) ------------------------------
     Terms persist at %APPDATA%\flowstate\dictionary.json, atomic writes via
     the same writer config.json uses. Every mutation returns the full list
     plus the prompt-budget figures the screen shows, so the renderer never
     recomputes them and cannot show a number main did not produce. */
  function dictionaryResponse() {
    const terms = dictionary.list();
    return Object.freeze({ terms, promptBudget: computeDictionaryBudget(terms) });
  }

  handle(CHANNELS.dictList, (_event, ...args) => {
    requireNoArgs(args, 'dict.list');
    return dictionaryResponse();
  });
  handle(CHANNELS.dictAdd, (_event, term, ...rest) => {
    if (rest.length !== 0) throw new TypeError('dict.add takes one term argument.');
    return dictionary.add(term).then(dictionaryResponse);
  });
  handle(CHANNELS.dictUpdate, (_event, id, term, ...rest) => {
    if (rest.length !== 0) throw new TypeError('dict.update takes an id and a term argument.');
    return dictionary.update(id, term).then(dictionaryResponse);
  });
  handle(CHANNELS.dictRemove, (_event, id, ...rest) => {
    if (rest.length !== 0) throw new TypeError('dict.remove takes one id argument.');
    return dictionary.remove(id).then(
      (removed) => Object.freeze({ removed, ...dictionaryResponse() })
    );
  });
  handle(CHANNELS.dictImport, (_event, payload, ...rest) => {
    if (rest.length !== 0) throw new TypeError('dict.import takes one payload argument.');
    return dictionary.import(payload).then(
      (result) => Object.freeze({
        added: result.added,
        skipped: result.skipped,
        ...dictionaryResponse(),
      })
    );
  });
  handle(CHANNELS.dictExport, (_event, ...args) => {
    requireNoArgs(args, 'dict.export');
    return dictionary.export();
  });

  /* --- snippets: durable JSON store (#25) --------------------------------
     Same shape as the dictionary block above: %APPDATA%\flowstate\snippets.json,
     every mutation returns the full list plus the conflict notices the screen
     shows, so the renderer never recomputes longest-match-first overlap
     itself and cannot show a conflict main did not compute. */
  function snippetsResponse() {
    const list = snippets.list();
    return Object.freeze({ snippets: list, conflicts: computeSnippetConflicts(list) });
  }

  handle(CHANNELS.snippetsList, (_event, ...args) => {
    requireNoArgs(args, 'snippets.list');
    return snippetsResponse();
  });
  handle(CHANNELS.snippetsAdd, (_event, snippet, ...rest) => {
    if (rest.length !== 0) throw new TypeError('snippets.add takes one snippet argument.');
    return snippets.add(snippet).then(snippetsResponse);
  });
  handle(CHANNELS.snippetsUpdate, (_event, id, snippet, ...rest) => {
    if (rest.length !== 0) throw new TypeError('snippets.update takes an id and a snippet argument.');
    return snippets.update(id, snippet).then(snippetsResponse);
  });
  handle(CHANNELS.snippetsRemove, (_event, id, ...rest) => {
    if (rest.length !== 0) throw new TypeError('snippets.remove takes one id argument.');
    return snippets.remove(id).then(
      (removed) => Object.freeze({ removed, ...snippetsResponse() })
    );
  });
  handle(CHANNELS.snippetsImport, (_event, payload, ...rest) => {
    if (rest.length !== 0) throw new TypeError('snippets.import takes one payload argument.');
    return snippets.import(payload).then(
      (result) => Object.freeze({
        added: result.added,
        skipped: result.skipped,
        ...snippetsResponse(),
      })
    );
  });
  handle(CHANNELS.snippetsExport, (_event, ...args) => {
    requireNoArgs(args, 'snippets.export');
    return snippets.export();
  });

  handle(CHANNELS.themeGet, (_event, ...args) => {
    requireNoArgs(args, 'theme.get');
    return theme.get();
  });
  handle(CHANNELS.themeSet, (_event, mode, ...rest) => {
    if (rest.length !== 0 || !THEME_MODES.includes(mode)) {
      throw new TypeError('theme.set requires system, light, or dark.');
    }
    return theme.set(mode);
  });

  /* --- history: the SQLite store (#28) ----------------------------------
     db.js owns validation of queries, filters and ids as well; these
     handlers check argument counts and shapes so a malformed call fails here
     with a clear message. If flowstate.db could not open, main falls back to
     the in-memory buffer, which has no search or delete: those channels then
     say so instead of pretending to search. */
  function historyStore(capability) {
    const store = getHistory?.();
    if (!store || typeof store[capability] !== 'function') {
      throw new Error('History is not available yet.');
    }
    return store;
  }

  handle(CHANNELS.historySearch, (_event, query, filters, ...rest) => {
    if (rest.length !== 0) throw new TypeError('history.search takes a query and filters.');
    const store = historyStore('search');
    if (query !== undefined && typeof query !== 'string') {
      throw new TypeError('history.search query must be a string.');
    }
    if (filters !== undefined) requirePlainObject(filters, 'history.search filters');
    return store.search(query ?? '', filters ?? {}).map((entry) => copyObject(entry));
  });
  handle(CHANNELS.historyRecent, (_event, count, ...rest) => {
    if (rest.length !== 0) throw new TypeError('history.recent takes one count argument.');
    const store = historyStore('recent');
    const requested = count === undefined ? undefined : count;
    if (requested !== undefined && (!Number.isInteger(requested) || requested < 0)) {
      throw new TypeError('history.recent count must be a non-negative integer.');
    }
    return store.recent(requested).map((entry) => copyObject(entry));
  });
  handle(CHANNELS.historyDelete, (_event, id, ...rest) => {
    if (rest.length !== 0) throw new TypeError('history.delete takes one id argument.');
    const store = historyStore('delete');
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
      throw new TypeError('history.delete requires a dictation id.');
    }
    return Object.freeze({ deleted: store.delete(id) === true });
  });
  handle(CHANNELS.historyFacets, (_event, ...args) => {
    requireNoArgs(args, 'history.facets');
    return copyObject(historyStore('facets').facets());
  });
  /* Re-paste reads the text from the store by id: the renderer never supplies
     the string that main types into another application. */
  handle(CHANNELS.historyPaste, async (_event, id, ...rest) => {
    if (rest.length !== 0) throw new TypeError('history.paste takes one id argument.');
    const store = historyStore('get');
    if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
      throw new TypeError('history.paste requires a dictation id.');
    }
    if (typeof rePaste !== 'function') throw new Error('Re-paste is not available yet.');
    const entry = store.get(id);
    if (!entry || typeof entry.text !== 'string' || entry.text.length === 0) {
      return Object.freeze({ ok: false, code: 'not-found' });
    }
    return copyObject(await rePaste(entry.text));
  });
  /* --- scratchpad: one durable document (#32) ----------------------------
     Copy and export read the stored text, not a string from the renderer; the
     renderer saves first, so the two cannot disagree. */
  function scratchStore() {
    if (!scratch || typeof scratch.get !== 'function') {
      throw new Error('The Scratchpad is not available yet.');
    }
    return scratch;
  }

  handle(CHANNELS.scratchGet, (_event, ...args) => {
    requireNoArgs(args, 'scratch.get');
    return copyObject(scratchStore().get());
  });
  handle(CHANNELS.scratchSet, (_event, text, ...rest) => {
    if (rest.length !== 0 || typeof text !== 'string') {
      throw new TypeError('scratch.set takes one text argument.');
    }
    return scratchStore().set(text).then((saved) => copyObject(saved));
  });
  handle(CHANNELS.scratchActive, (_event, active, ...rest) => {
    if (rest.length !== 0 || typeof active !== 'boolean') {
      throw new TypeError('scratch.setActive takes one boolean.');
    }
    scratchSession?.setActive(active);
    return Object.freeze({ active });
  });
  handle(CHANNELS.scratchCopy, (_event, ...args) => {
    requireNoArgs(args, 'scratch.copy');
    const { text } = scratchStore().get();
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      throw new Error('The clipboard is not available.');
    }
    clipboard.writeText(text);
    return Object.freeze({ copied: true, length: text.length });
  });
  handle(CHANNELS.scratchExport, async (_event, ...args) => {
    requireNoArgs(args, 'scratch.export');
    if (typeof saveTextFile !== 'function') throw new Error('Export is not available yet.');
    return copyObject(await saveTextFile(scratchStore().get().text));
  });

  /* Called by the dictation router; returns false when no window took it. */
  function insertIntoScratchpad(text) {
    let delivered = false;
    for (const window of getWindows()) {
      if (!window || window.isDestroyed()) continue;
      window.webContents.send(CHANNELS.scratchInsert, text);
      delivered = true;
    }
    return delivered;
  }

  /* --- insights: aggregates over the SQLite store (#30) ------------------
     The period is a closed set, so the renderer cannot ask for an arbitrary
     window; everything else is computed in SQL by insights.js. */
  const INSIGHT_PERIODS = ['last7', 'last30', 'all'];
  function insightsStore() {
    const insights = getHistory?.()?.insights;
    if (!insights) throw new Error('Insights are not available yet.');
    return insights;
  }
  function requirePeriod(period, rest, label) {
    if (rest.length !== 0 || (period !== undefined && !INSIGHT_PERIODS.includes(period))) {
      throw new TypeError(`${label} takes an optional period: last7, last30 or all.`);
    }
    return period;
  }
  handle(CHANNELS.insightsSummary, (_event, period, ...rest) =>
    copyObject(insightsStore().summary(requirePeriod(period, rest, 'insights.summary'))));
  handle(CHANNELS.insightsStreak, (_event, ...args) => {
    requireNoArgs(args, 'insights.streak');
    return copyObject(insightsStore().streak());
  });
  handle(CHANNELS.insightsByApp, (_event, period, ...rest) =>
    insightsStore().byApp(requirePeriod(period, rest, 'insights.byApp')).map((row) => copyObject(row)));
  handle(CHANNELS.insightsByLanguage, (_event, period, ...rest) =>
    insightsStore().byLanguage(requirePeriod(period, rest, 'insights.byLanguage')).map((row) => copyObject(row)));

  handle(CHANNELS.historyClear, (_event, ...args) => {
    requireNoArgs(args, 'history.clear');
    const store = historyStore('clear');
    const removed = store.clear();
    return Object.freeze(
      Number.isInteger(removed) ? { cleared: true, removed } : { cleared: true }
    );
  });

  /* --- app: version facts, diagnostics, logs, and a closed set of paths
     safe to reveal or open. Every target is a fixed constant chosen in main,
     never a path supplied by the renderer — the same closed-list shape
     shell.js already uses for fixtures. -------------------------------- */
  function diagnosticsText(errors) {
    const lines = [
      `Flowstate ${versions?.appVersion ?? 'unknown'}`,
      `Speech model: ${versions?.modelVersion ?? 'unknown'}`,
      `sherpa-onnx: ${versions?.sherpaVersion ?? 'unknown'}`,
      `Electron: ${versions?.electronVersion ?? 'unknown'}`,
      `Node: ${versions?.nodeVersion ?? 'unknown'}`,
      `Machine: ${versions?.platform ?? 'unknown'}`,
      `Config: ${versions?.configLocation ?? 'unknown'}`,
      `Logs: ${versions?.logLocation ?? 'unknown'}`,
      '',
      errors.length === 0
        ? 'No errors in the last 7 days.'
        : 'Recent errors:',
      ...errors.map((entry) => `  ${entry.at} — ${entry.message}`),
    ];
    return lines.join('\n');
  }

  function recentErrors() {
    return errorLog && typeof errorLog.recent === 'function'
      ? errorLog.recent().map((entry) => copyObject(entry))
      : [];
  }

  // Side-effect-free: the About screen calls this on every mount to paint
  // versions, paths and the recent-errors list, so it must never touch the
  // clipboard on its own.
  handle(CHANNELS.appVersion, (_event, ...args) => {
    requireNoArgs(args, 'app.version');
    return Object.freeze({ ...copyObject(versions ?? {}), recentErrors: recentErrors() });
  });
  // The clipboard write is the point of this channel — "copy diagnostics"
  // means main puts the text on the clipboard, not merely returns it — so it
  // only ever runs from the button's own click handler, never from a mount.
  handle(CHANNELS.appDiagnostics, (_event, ...args) => {
    requireNoArgs(args, 'app.diagnostics');
    const errors = recentErrors();
    const text = diagnosticsText(errors);
    if (clipboard && typeof clipboard.writeText === 'function') {
      clipboard.writeText(text);
    }
    return Object.freeze({ ...copyObject(versions ?? {}), recentErrors: errors });
  });
  handle(CHANNELS.appOpenLogs, (_event, ...args) => {
    requireNoArgs(args, 'app.openLogs');
    if (!shell || typeof shell.openPath !== 'function' || !errorLog) {
      throw new Error('Logs are not available yet.');
    }
    return shell.openPath(errorLog.directory).then((error) => {
      if (error) throw new Error(error);
      return Object.freeze({ opened: true });
    });
  });
  handle(CHANNELS.appReveal, (_event, kind, ...rest) => {
    if (rest.length !== 0 || !REVEAL_KINDS.includes(kind)) {
      throw new TypeError(`app.reveal requires one of: ${REVEAL_KINDS.join(', ')}.`);
    }
    if (!shell || typeof shell.openPath !== 'function') {
      throw new Error('Revealing a folder is not available yet.');
    }
    const target = {
      model: () => model.getModelsDirectory?.(),
      config: () => (config.filePath ? path.dirname(config.filePath) : null),
      logs: () => errorLog?.directory,
    }[kind]();
    if (!target) throw new Error(`No ${kind} location is available yet.`);
    return shell.openPath(target).then((error) => {
      if (error) throw new Error(error);
      return Object.freeze({ opened: true });
    });
  });
  handle(CHANNELS.appOpenDoc, (_event, key, ...rest) => {
    const keys = docs ? Object.keys(docs) : [];
    if (rest.length !== 0 || !keys.includes(key)) {
      throw new TypeError(`app.openDoc requires one of: ${keys.join(', ')}.`);
    }
    const target = docs[key];
    if (/^https:\/\//.test(target)) {
      if (!shell || typeof shell.openExternal !== 'function') {
        throw new Error('Opening links is not available yet.');
      }
      return Promise.resolve(shell.openExternal(target)).then(() => Object.freeze({ opened: true }));
    }
    if (!shell || typeof shell.openPath !== 'function') {
      throw new Error('Opening documentation is not available yet.');
    }
    return shell.openPath(target).then((error) => {
      if (error) throw new Error(error);
      return Object.freeze({ opened: true });
    });
  });

  handle(CHANNELS.llmProviders, (_event, ...args) => {
    requireNoArgs(args, 'llm.providers');
    return LLM_PROVIDERS.map((provider) => Object.freeze({
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      model: provider.model,
      requiresApiKey: provider.requiresApiKey,
      keyDoc: provider.keyUrl ? `key-${provider.id}` : null,
    }));
  });
  handle(CHANNELS.llmTest, (_event, ...args) => {
    requireNoArgs(args, 'llm.test');
    if (!llm || typeof llm.test !== 'function') {
      throw new Error('Testing the cleanup service is not available yet.');
    }
    return llm.test();
  });

  function requireUpdater() {
    if (!updater) throw new Error('Updates are not available yet.');
    return updater;
  }
  handle(CHANNELS.updateState, (_event, ...args) => {
    requireNoArgs(args, 'update.state');
    return copyObject(requireUpdater().getState());
  });
  handle(CHANNELS.updateCheck, async (_event, ...args) => {
    requireNoArgs(args, 'update.check');
    return copyObject(await requireUpdater().check({ manual: true }));
  });
  handle(CHANNELS.updateInstall, (_event, ...args) => {
    requireNoArgs(args, 'update.install');
    // Not awaited: the renderer follows progress through updateChanged, and
    // the app quits before this would resolve.
    void requireUpdater().install();
    return Object.freeze({ started: true });
  });
  handle(CHANNELS.updateDismiss, (_event, ...args) => {
    requireNoArgs(args, 'update.dismiss');
    return copyObject(requireUpdater().dismiss());
  });
  const offUpdater = updater && typeof updater.onState === 'function'
    ? updater.onState((state) => sendToWindows(CHANNELS.updateChanged, state))
    : () => {};

  const onConfigChange = (next) =>
    sendToWindows(CHANNELS.configChanged, publicConfig(next));
  if (typeof config.on === 'function') config.on('change', onConfigChange);

  const offMics = mics.onChange((devices) => {
    for (const watcher of micWatchers.values()) {
      if (!watcher.sender.isDestroyed?.()) {
        watcher.sender.send(CHANNELS.micsDeviceChanged, copyObject(devices));
      }
    }
  });
  const offModel = typeof model.onStatus === 'function'
    ? model.onStatus((status) => sendToWindows(CHANNELS.modelProgress, status))
    : () => {};

  function sendToPreviewSubscriber(channel, payload) {
    if (!previewSubscriber || previewSubscriber.sender.isDestroyed?.()) return;
    previewSubscriber.sender.send(channel, payload);
  }
  const offPreviewLevel = micPreview && typeof micPreview.onLevel === 'function'
    ? micPreview.onLevel((level) => sendToPreviewSubscriber(CHANNELS.micPreviewLevel, level))
    : () => {};
  const offPreviewError = micPreview && typeof micPreview.onError === 'function'
    ? micPreview.onError((message) => sendToPreviewSubscriber(CHANNELS.micPreviewError, message))
    : () => {};

  function notifyDictationResult(result) {
    sendToWindows(CHANNELS.dictationResult, result);
  }

  function dispose() {
    for (const channel of handled) ipcMain.removeHandler(channel);
    if (typeof config.off === 'function') config.off('change', onConfigChange);
    offMics();
    offModel();
    offUpdater();
    offPreviewLevel();
    offPreviewError();
    for (const watcher of micWatchers.values()) watcher.release();
    micWatchers.clear();
    if (previewSubscriber) micPreview?.stop();
    previewSubscriber = null;
    if (activeRebind) getHotkeyManager?.()?.cancelRebind();
    activeRebind = null;
  }

  return Object.freeze({
    dispose,
    updateConfig,
    notifyDictationResult,
    insertIntoScratchpad,
  });
}

module.exports = {
  CHANNELS,
  LANGUAGES,
  REVEAL_KINDS,
  THEME_MODES,
  createIpcBridge,
  publicConfig,
  validateConfigPatch,
};
