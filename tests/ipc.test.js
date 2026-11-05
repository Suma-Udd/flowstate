'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { createAutostartManager } = require('../src/main/autostart');
const { DEFAULT_CONFIG } = require('../src/main/config');
const {
  CHANNELS,
  createIpcBridge,
  publicConfig,
  validateConfigPatch,
} = require('../src/main/ipc');
const {
  CHANNELS: MIC_CHANNELS,
  createMicrophoneService,
  normaliseDevices,
} = require('../src/main/mics');

const PRELOAD = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'main', 'preload.js'),
  'utf8'
);

function merge(base, patch) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && result[key]
      && typeof result[key] === 'object'
      && !Array.isArray(result[key])
    ) {
      result[key] = merge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

class FakeIpc {
  handlers = new Map();
  handle(channel, callback) {
    assert.equal(this.handlers.has(channel), false, `${channel} registered twice`);
    this.handlers.set(channel, callback);
  }
  removeHandler(channel) {
    this.handlers.delete(channel);
  }
  invoke(channel, event, ...args) {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler(event, ...args);
  }
}

class FakeSender extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.sent = [];
    this.destroyed = false;
  }
  isDestroyed() {
    return this.destroyed;
  }
  send(channel, payload) {
    this.sent.push([channel, payload]);
  }
}

class FakeConfig extends EventEmitter {
  constructor() {
    super();
    this.value = structuredClone(DEFAULT_CONFIG);
    this.value.llm.apiKey = 'x';
    this.failWrites = false;
    this.filePath = 'C:\\fake\\config.json';
  }
  get() {
    return structuredClone(this.value);
  }
  async update(patch) {
    if (this.failWrites) throw new Error('disk is full');
    this.value = merge(this.value, patch);
    const snapshot = this.get();
    this.emit('change', snapshot);
    return snapshot;
  }
}

class FakeMics extends EventEmitter {
  watches = 0;
  releases = 0;
  async list() {
    return [{ deviceId: 'default', label: 'Desk microphone', isDefault: true }];
  }
  watch() {
    this.watches += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releases += 1;
    };
  }
  onChange(listener) {
    this.on('change', listener);
    return () => this.off('change', listener);
  }
}

class FakeModel extends EventEmitter {
  state = { phase: 'ready', percent: 100 };
  downloads = 0;
  cancels = 0;
  getState() {
    return structuredClone(this.state);
  }
  async download() {
    this.downloads += 1;
    return this.getState();
  }
  cancel() {
    this.cancels += 1;
    return true;
  }
  onStatus(listener) {
    this.on('status', listener);
    return () => this.off('status', listener);
  }
  getModelsDirectory() {
    return 'C:\\fake\\models';
  }
}

class FakeHistory {
  entries = [];
  clears = 0;
  recent(count) {
    return this.entries.slice(0, count);
  }
  clear() {
    this.clears += 1;
    this.entries = [];
  }
}

class FakeDictionary {
  terms = [];
  nextId = 1;

  list() {
    return this.terms.map((t) => ({ ...t }));
  }

  async add(input) {
    if (!input || !input.term) throw new TypeError('A dictionary term needs a spelling.');
    const key = input.term.trim().toLowerCase();
    if (this.terms.some((t) => t.term.toLowerCase() === key)) {
      throw new Error(`"${input.term}" is already in the dictionary.`);
    }
    const record = {
      id: `t-${this.nextId++}`,
      term: input.term,
      soundsLike: input.soundsLike ?? null,
      lang: input.lang ?? null,
      addedAt: '2026-07-27',
      corrections: 0,
    };
    this.terms.push(record);
    return { ...record };
  }

  async update(id, input) {
    const index = this.terms.findIndex((t) => t.id === id);
    if (index === -1) throw new Error('That dictionary term no longer exists.');
    this.terms[index] = { ...this.terms[index], term: input.term, soundsLike: input.soundsLike ?? null, lang: input.lang ?? null };
    return { ...this.terms[index] };
  }

  async remove(id) {
    const index = this.terms.findIndex((t) => t.id === id);
    if (index === -1) return false;
    this.terms.splice(index, 1);
    return true;
  }

  async import(payload) {
    const list = Array.isArray(payload) ? payload : payload?.terms ?? [];
    let added = 0;
    let skipped = 0;
    for (const item of list) {
      try {
        await this.add(item);
        added += 1;
      } catch {
        skipped += 1;
      }
    }
    return { added, skipped };
  }

  export() {
    return { version: 1, terms: this.list() };
  }
}

class FakeSnippets {
  snippets = [];
  nextId = 1;

  #key(trigger, appScope) {
    return `${trigger.trim().toLowerCase()} ${appScope || ''}`;
  }

  list() {
    return this.snippets.map((s) => ({ ...s }));
  }

  async add(input) {
    if (!input || !input.trigger) throw new TypeError('A snippet needs a trigger phrase.');
    if (!input.expansion) throw new TypeError('A snippet needs an expansion.');
    const key = this.#key(input.trigger, input.appScope ?? null);
    if (this.snippets.some((s) => this.#key(s.trigger, s.appScope) === key)) {
      throw new Error(`"${input.trigger}" already has a snippet in that scope.`);
    }
    const record = {
      id: `s-${this.nextId++}`,
      trigger: input.trigger,
      expansion: input.expansion,
      appScope: input.appScope ?? null,
      createdAt: '2026-07-27',
      uses: 0,
      lastUsed: null,
    };
    this.snippets.push(record);
    return { ...record };
  }

  async update(id, input) {
    const index = this.snippets.findIndex((s) => s.id === id);
    if (index === -1) throw new Error('That snippet no longer exists.');
    this.snippets[index] = {
      ...this.snippets[index],
      trigger: input.trigger,
      expansion: input.expansion,
      appScope: input.appScope ?? null,
    };
    return { ...this.snippets[index] };
  }

  async remove(id) {
    const index = this.snippets.findIndex((s) => s.id === id);
    if (index === -1) return false;
    this.snippets.splice(index, 1);
    return true;
  }

  async import(payload) {
    const list = Array.isArray(payload) ? payload : payload?.snippets ?? [];
    let added = 0;
    let skipped = 0;
    for (const item of list) {
      try {
        await this.add(item);
        added += 1;
      } catch {
        skipped += 1;
      }
    }
    return { added, skipped };
  }

  export() {
    return { version: 1, snippets: this.list() };
  }
}

function fakeErrorLog() {
  const entries = [];
  return {
    directory: 'C:\\fake\\logs',
    record(message) {
      entries.unshift({ at: '2026-07-27T00:00:00.000Z', message: String(message) });
    },
    recent(count = entries.length) {
      return entries.slice(0, count);
    },
  };
}

function fakeClipboard() {
  return {
    written: null,
    writeText(text) {
      this.written = text;
    },
  };
}

function fakeShell() {
  return {
    opened: [],
    externals: [],
    async openExternal(url) {
      this.externals.push(url);
    },
    async openPath(target) {
      this.opened.push(target);
      return this.failNext ? 'boom' : '';
    },
  };
}

const FAKE_VERSIONS = Object.freeze({
  appVersion: '0.1.0-test',
  electronVersion: '43.2.0',
  nodeVersion: '22.0.0',
  modelVersion: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
  sherpaVersion: '1.13.4',
  platform: 'Windows test-machine',
  configLocation: 'C:\\fake\\config.json',
  logLocation: 'C:\\fake\\logs',
});

const FAKE_DOCS = Object.freeze({
  readme: 'C:\\docs\\README.md',
  releases: 'https://example.com/releases',
});

function mount({ failWrites = false, rePaste, scratch, scratchSession, saveTextFile, llm, updater } = {}) {
  const ipc = new FakeIpc();
  const config = new FakeConfig();
  config.failWrites = failWrites;
  const dictionary = new FakeDictionary();
  const snippets = new FakeSnippets();
  const mics = new FakeMics();
  const model = new FakeModel();
  const autostart = {
    calls: [],
    async set(enabled) {
      this.calls.push(enabled);
      return { enabled };
    },
  };
  const theme = {
    state: { mode: 'system', resolved: 'light' },
    get() {
      return { ...this.state };
    },
    async set(mode) {
      this.state = { mode, resolved: mode === 'dark' ? 'dark' : 'light' };
      return this.get();
    },
  };
  const hotkey = {
    callback: null,
    cancelled: 0,
    startRebind(callback) {
      this.callback = callback;
    },
    cancelRebind() {
      if (!this.callback) return false;
      const callback = this.callback;
      this.callback = null;
      this.cancelled += 1;
      callback({ status: 'cancelled' });
      return true;
    },
    finish(result) {
      const callback = this.callback;
      this.callback = null;
      callback(result);
    },
  };
  const micPreview = new EventEmitter();
  micPreview.starts = [];
  micPreview.stops = 0;
  micPreview.start = (deviceId) => micPreview.starts.push(deviceId);
  micPreview.stop = () => { micPreview.stops += 1; };
  micPreview.onLevel = (listener) => {
    micPreview.on('level', listener);
    return () => micPreview.off('level', listener);
  };
  micPreview.onError = (listener) => {
    micPreview.on('error', listener);
    return () => micPreview.off('error', listener);
  };

  const testRunner = {
    calls: 0,
    result: { text: 'hello world', lang: 'en' },
    async run() {
      testRunner.calls += 1;
      return testRunner.result;
    },
  };

  const windowSender = new FakeSender(900);
  const window = {
    isDestroyed: () => false,
    webContents: windowSender,
  };
  const history = new FakeHistory();
  const errorLog = fakeErrorLog();
  const clipboard = fakeClipboard();
  const shell = fakeShell();
  const bridge = createIpcBridge({
    ipcMain: ipc,
    config,
    dictionary,
    snippets,
    scratch,
    scratchSession,
    saveTextFile,
    mics,
    autostart,
    theme,
    getHotkeyManager: () => hotkey,
    model,
    micPreview,
    getTestRunner: () => testRunner,
    getHistory: () => history,
    rePaste,
    errorLog,
    clipboard,
    shell,
    versions: FAKE_VERSIONS,
    docs: FAKE_DOCS,
    llm,
    updater,
    getWindows: () => [window],
  });
  return {
    autostart,
    bridge,
    clipboard,
    config,
    dictionary,
    snippets,
    errorLog,
    history,
    hotkey,
    ipc,
    micPreview,
    mics,
    model,
    shell,
    testRunner,
    theme,
    windowSender,
  };
}

test('preload exposes the complete frozen v1 contract over named channels', () => {
  for (const namespace of [
    'config',
    'mics',
    'micPreview',
    'hotkey',
    'model',
    'dictation',
    'history',
    'insights',
    'dict',
    'snippets',
    'scratch',
    'theme',
    'app',
    'llm',
    'update',
  ]) {
    assert.match(
      PRELOAD,
      new RegExp(`${namespace}: Object\\.freeze`),
      `${namespace} is absent or mutable`
    );
  }
  for (const channel of Object.values(CHANNELS)) {
    assert.ok(PRELOAD.includes(channel), `preload is missing ${channel}`);
  }
  assert.doesNotMatch(PRELOAD, /\bipcRenderer\.send\(/);
  assert.doesNotMatch(PRELOAD, /require\('node:/);
});

test('config channels redact credentials and accept only the v1 renderer schema', async () => {
  const h = mount();
  const sender = new FakeSender(1);
  const event = { sender };

  const initial = await h.ipc.invoke(CHANNELS.configGet, event);
  assert.equal(initial.llm.apiKey, undefined);
  assert.equal(initial.llm.apiKeyConfigured, true);

  const updated = await h.ipc.invoke(CHANNELS.configSet, event, {
    audio: { deviceId: 'mic-2' },
    asr: { languages: ['en', 'el'], unloadAfterMinutes: 30, hotwords: false },
    llm: {
      enabled: false,
      timeoutMs: 2_500,
      skipUnderWords: 5,
      removeFillers: false,
    },
    system: { autostart: false, startMinimised: false },
    history: { retentionDays: 90 },
  });
  assert.equal(updated.audio.deviceId, 'mic-2');
  assert.deepEqual(updated.asr.languages, ['en', 'el']);
  assert.equal(updated.asr.hotwords, false);
  assert.equal(updated.llm.enabled, false);
  assert.equal(updated.llm.removeFillers, false);
  assert.equal(updated.system.autostart, false);
  assert.deepEqual(h.autostart.calls, [false]);
  assert.equal(h.windowSender.sent.at(-1)[0], CHANNELS.configChanged);
  assert.equal(h.windowSender.sent.at(-1)[1].llm.apiKey, undefined);

  for (const patch of [
    { version: 2 },
    { ui: { windowBounds: { x: 0, y: 0 } } },
    { audio: { deviceId: 42 } },
    { asr: { languages: ['en', 'en'] } },
    { asr: { hotwords: 'yes' } },
    { hotkey: { chord: ['Meta', 'L'] } },
    { llm: { provider: 'DeepSeek' } },
    { llm: { removeFillers: 'yes' } },
    { system: { autostart: 'yes' } },
    { history: { retentionDays: -1 } },
  ]) {
    await assert.rejects(
      () => h.ipc.invoke(CHANNELS.configSet, event, patch),
      /unsupported|must|reserves/i
    );
  }
  assert.throws(
    () => h.ipc.invoke(CHANNELS.configGet, event, 'unexpected'),
    /takes no arguments/
  );
  h.bridge.dispose();
});

test('a failed config write rolls the verified Run-key change back', async () => {
  const h = mount({ failWrites: true });
  await assert.rejects(
    () => h.ipc.invoke(
      CHANNELS.configSet,
      { sender: new FakeSender(2) },
      { system: { autostart: false } }
    ),
    /disk is full/
  );
  assert.deepEqual(h.autostart.calls, [false, true]);
  h.bridge.dispose();
});

test('microphone listing and device-change events are scoped to subscribers', async () => {
  const h = mount();
  const sender = new FakeSender(3);
  const event = { sender };

  assert.deepEqual(await h.ipc.invoke(CHANNELS.micsList, event), [{
    deviceId: 'default',
    label: 'Desk microphone',
    isDefault: true,
  }]);
  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.micsWatchStart, event),
    { watching: true }
  );
  assert.equal(h.mics.watches, 1);

  h.mics.emit('change', [{
    deviceId: 'usb-mic',
    groupId: 'usb',
    label: 'USB microphone',
    isDefault: false,
  }]);
  assert.deepEqual(sender.sent.at(-1), [
    CHANNELS.micsDeviceChanged,
    [{
      deviceId: 'usb-mic',
      groupId: 'usb',
      label: 'USB microphone',
      isDefault: false,
    }],
  ]);

  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.micsWatchStop, event),
    { watching: false }
  );
  assert.equal(h.mics.releases, 1);
  h.bridge.dispose();
});

test('the microphone preview is scoped to whichever sender started it most recently', async () => {
  const h = mount();
  const first = new FakeSender(10);
  const second = new FakeSender(11);

  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.micPreviewStart, { sender: first }, 'mic-a'),
    { watching: true }
  );
  assert.deepEqual(h.micPreview.starts, ['mic-a']);

  h.micPreview.emit('level', 0.42);
  assert.deepEqual(first.sent.at(-1), [CHANNELS.micPreviewLevel, 0.42]);

  // A second sender taking over (e.g. a reload) becomes the only listener.
  await h.ipc.invoke(CHANNELS.micPreviewStart, { sender: second }, 'mic-b');
  h.micPreview.emit('level', 0.9);
  assert.deepEqual(second.sent.at(-1), [CHANNELS.micPreviewLevel, 0.9]);
  assert.equal(first.sent.some((entry) => entry[1] === 0.9), false);

  h.micPreview.emit('error', 'The microphone disconnected.');
  assert.deepEqual(second.sent.at(-1), [CHANNELS.micPreviewError, 'The microphone disconnected.']);

  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.micPreviewStop, { sender: second }),
    { watching: false }
  );
  assert.equal(h.micPreview.stops, 1);
  h.bridge.dispose();
});

test('microphone preview and test-run channels refuse to run before their services exist', async () => {
  const ipc = new FakeIpc();
  const config = new FakeConfig();
  const dictionary = new FakeDictionary();
  const snippets = new FakeSnippets();
  const mics = new FakeMics();
  const model = new FakeModel();
  const bridge = createIpcBridge({
    ipcMain: ipc,
    config,
    dictionary,
    snippets,
    mics,
    autostart: { async set() { return {}; } },
    theme: { get: () => ({}), set: async () => ({}) },
    model,
    getWindows: () => [],
  });
  const event = { sender: new FakeSender(1) };

  assert.throws(
    () => ipc.invoke(CHANNELS.micPreviewStart, event, null),
    /not available yet/
  );
  assert.throws(
    () => ipc.invoke(CHANNELS.dictationTestRun, event),
    /not available yet/
  );
  bridge.dispose();
});

test('dictation.testRun delegates to the test runner and results broadcast to every window', async () => {
  const h = mount();
  const event = { sender: new FakeSender(6) };

  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.dictationTestRun, event),
    { text: 'hello world', lang: 'en' }
  );
  assert.equal(h.testRunner.calls, 1);

  h.bridge.notifyDictationResult({ text: 'hello world', lang: 'en' });
  assert.deepEqual(h.windowSender.sent.at(-1), [
    CHANNELS.dictationResult,
    { text: 'hello world', lang: 'en' },
  ]);
  h.bridge.dispose();
});

test('hotkey rebind persists an accepted chord and reports rejection reasons', async () => {
  const h = mount();
  const sender = new FakeSender(4);
  const event = { sender };

  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.hotkeyStartRebind, event),
    { status: 'capturing' }
  );
  h.hotkey.finish({
    status: 'accepted',
    chord: ['Ctrl', 'Shift', 'X'],
    label: 'Ctrl+Shift+X',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(h.config.get().hotkey.chord, ['Ctrl', 'Shift', 'X']);
  assert.deepEqual(sender.sent.at(-1), [
    CHANNELS.hotkeyRebindResult,
    {
      status: 'accepted',
      chord: ['Ctrl', 'Shift', 'X'],
      label: 'Ctrl+Shift+X',
    },
  ]);

  await h.ipc.invoke(CHANNELS.hotkeyStartRebind, event);
  h.hotkey.finish({
    status: 'rejected',
    chord: ['Meta', 'L'],
    reason: 'Windows reserves Meta+L. Choose a different shortcut.',
  });
  assert.match(sender.sent.at(-1)[1].reason, /Windows reserves/);
  h.bridge.dispose();
});

test('model and theme settings are callable with strict arity', async () => {
  const h = mount();
  const event = { sender: new FakeSender(5) };

  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.modelStatus, event),
    { phase: 'ready', percent: 100 }
  );
  await h.ipc.invoke(CHANNELS.modelDownload, event);
  assert.equal(h.model.downloads, 1);
  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.modelCancelDownload, event),
    {
      cancelled: true,
      status: { phase: 'ready', percent: 100 },
    }
  );
  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.themeSet, event, 'dark'),
    { mode: 'dark', resolved: 'dark' }
  );
  assert.throws(
    () => h.ipc.invoke(CHANNELS.themeSet, event, 'sepia'),
    /requires system, light, or dark/
  );
  h.bridge.dispose();
});

test('history.recent reads the in-memory buffer and history.clear empties it', async () => {
  const h = mount();
  const event = { sender: new FakeSender(7) };

  h.history.entries = [{ id: '1', text: 'hello' }, { id: '2', text: 'world' }];
  assert.deepEqual(await h.ipc.invoke(CHANNELS.historyRecent, event, 1), [
    { id: '1', text: 'hello' },
  ]);
  assert.throws(
    () => h.ipc.invoke(CHANNELS.historyRecent, event, -1),
    /non-negative integer/
  );

  assert.deepEqual(await h.ipc.invoke(CHANNELS.historyClear, event), { cleared: true });
  assert.equal(h.history.clears, 1);
  assert.deepEqual(h.history.entries, []);
  h.bridge.dispose();
});

test('history.search and history.delete reach the store with validated arguments', async () => {
  const h = mount();
  const event = { sender: new FakeSender(8) };
  const searches = [];
  const deletes = [];
  h.history.search = (query, filters) => {
    searches.push([query, filters]);
    return [{ id: '1', text: 'grüße' }];
  };
  h.history.delete = (id) => {
    deletes.push(id);
    return id === 'known';
  };

  assert.deepEqual(
    await h.ipc.invoke(CHANNELS.historySearch, event, 'grusse', { language: 'de' }),
    [{ id: '1', text: 'grüße' }]
  );
  await h.ipc.invoke(CHANNELS.historySearch, event);
  assert.deepEqual(searches, [['grusse', { language: 'de' }], ['', {}]]);
  assert.throws(() => h.ipc.invoke(CHANNELS.historySearch, event, 42), /query must be a string/);
  assert.throws(() => h.ipc.invoke(CHANNELS.historySearch, event, 'x', []), /filters must be an object/);
  assert.throws(() => h.ipc.invoke(CHANNELS.historySearch, event, 'x', {}, 'extra'), /takes a query and filters/);

  assert.deepEqual(await h.ipc.invoke(CHANNELS.historyDelete, event, 'known'), { deleted: true });
  assert.deepEqual(await h.ipc.invoke(CHANNELS.historyDelete, event, 'gone'), { deleted: false });
  assert.throws(() => h.ipc.invoke(CHANNELS.historyDelete, event, ''), /requires a dictation id/);
  assert.throws(() => h.ipc.invoke(CHANNELS.historyDelete, event, 7), /requires a dictation id/);
  assert.deepEqual(deletes, ['known', 'gone']);

  // The database reports how many rows clear removed; the buffer does not.
  h.history.clear = () => 12;
  assert.deepEqual(await h.ipc.invoke(CHANNELS.historyClear, event), { cleared: true, removed: 12 });
  h.bridge.dispose();
});

test('dict.list returns every term plus a real prompt-budget figure', async () => {
  const h = mount();
  const event = { sender: new FakeSender(11) };

  const empty = await h.ipc.invoke(CHANNELS.dictList, event);
  assert.deepEqual(empty.terms, []);
  assert.equal(empty.promptBudget.terms, 0);
  assert.equal(empty.promptBudget.chars, 0);
  assert.ok(empty.promptBudget.capChars > 0);
  assert.ok(empty.promptBudget.warnAtTerms > 0);
  assert.throws(() => h.ipc.invoke(CHANNELS.dictList, event, 'nope'), /takes no arguments/);
});

test('dict.add persists a term and rejects a case-insensitive duplicate', async () => {
  const h = mount();
  const event = { sender: new FakeSender(12) };

  const first = await h.ipc.invoke(CHANNELS.dictAdd, event, {
    term: 'Grafana',
    soundsLike: 'graph ana',
    lang: 'en',
  });
  assert.equal(first.terms.length, 1);
  assert.equal(first.terms[0].term, 'Grafana');
  assert.equal(first.promptBudget.terms, 1);
  assert.ok(first.promptBudget.chars > 0);

  await assert.rejects(
    () => h.ipc.invoke(CHANNELS.dictAdd, event, { term: 'grafana' }),
    /already in the dictionary/
  );
  assert.throws(
    () => h.ipc.invoke(CHANNELS.dictAdd, event, { term: 'x' }, 'extra'),
    /takes one term argument/
  );
});

test('dict.update edits a term and dict.remove deletes it', async () => {
  const h = mount();
  const event = { sender: new FakeSender(13) };

  const added = await h.ipc.invoke(CHANNELS.dictAdd, event, { term: 'Terraform' });
  const id = added.terms[0].id;

  const updated = await h.ipc.invoke(CHANNELS.dictUpdate, event, id, {
    term: 'Terraform',
    soundsLike: 'terra form',
  });
  assert.equal(updated.terms[0].soundsLike, 'terra form');

  const removed = await h.ipc.invoke(CHANNELS.dictRemove, event, id);
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.terms, []);

  const missing = await h.ipc.invoke(CHANNELS.dictRemove, event, 'does-not-exist');
  assert.equal(missing.removed, false);
});

test('dict.import reports how many terms landed and how many were skipped', async () => {
  const h = mount();
  const event = { sender: new FakeSender(14) };

  await h.ipc.invoke(CHANNELS.dictAdd, event, { term: 'Ryzen' });
  const result = await h.ipc.invoke(CHANNELS.dictImport, event, {
    version: 1,
    terms: [{ term: 'Kubernetes' }, { term: 'ryzen' }],
  });
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.terms.length, 2);
});

test('dict.export returns a version and every term, without mutating anything', async () => {
  const h = mount();
  const event = { sender: new FakeSender(15) };

  await h.ipc.invoke(CHANNELS.dictAdd, event, { term: 'Parakeet' });
  const exported = await h.ipc.invoke(CHANNELS.dictExport, event);
  assert.equal(exported.version, 1);
  assert.equal(exported.terms.length, 1);
  assert.equal(exported.terms[0].term, 'Parakeet');

  const stillOne = await h.ipc.invoke(CHANNELS.dictList, event);
  assert.equal(stillOne.terms.length, 1);
});

test('snippets.list returns every snippet plus real conflict data', async () => {
  const h = mount();
  const event = { sender: new FakeSender(16) };

  const empty = await h.ipc.invoke(CHANNELS.snippetsList, event);
  assert.deepEqual(empty.snippets, []);
  assert.deepEqual(empty.conflicts, []);
  assert.throws(() => h.ipc.invoke(CHANNELS.snippetsList, event, 'nope'), /takes no arguments/);
});

test('snippets.add persists a snippet and rejects a duplicate trigger in the same scope', async () => {
  const h = mount();
  const event = { sender: new FakeSender(17) };

  const first = await h.ipc.invoke(CHANNELS.snippetsAdd, event, {
    trigger: 'my work email',
    expansion: 'alex@example.com',
  });
  assert.equal(first.snippets.length, 1);
  assert.equal(first.snippets[0].trigger, 'my work email');
  assert.equal(first.conflicts.length, 0);

  await assert.rejects(
    () => h.ipc.invoke(CHANNELS.snippetsAdd, event, {
      trigger: 'MY WORK EMAIL',
      expansion: 'something else',
    }),
    /already has a snippet in that scope/
  );
  assert.throws(
    () => h.ipc.invoke(CHANNELS.snippetsAdd, event, { trigger: 'x', expansion: 'y' }, 'extra'),
    /takes one snippet argument/
  );
});

test('snippets.list surfaces a prefix conflict between two overlapping triggers', async () => {
  const h = mount();
  const event = { sender: new FakeSender(18) };

  await h.ipc.invoke(CHANNELS.snippetsAdd, event, {
    trigger: 'meeting notes',
    expansion: '## Notes',
    appScope: 'Obsidian.exe',
  });
  const withConflict = await h.ipc.invoke(CHANNELS.snippetsAdd, event, {
    trigger: 'meeting notes template',
    expansion: '## Attendees',
    appScope: 'Obsidian.exe',
  });

  assert.equal(withConflict.conflicts.length, 1);
  assert.deepEqual(withConflict.conflicts[0].triggers, ['meeting notes', 'meeting notes template']);
  assert.match(withConflict.conflicts[0].message, /is a prefix of/);
});

test('snippets.update edits a snippet and snippets.remove deletes it', async () => {
  const h = mount();
  const event = { sender: new FakeSender(19) };

  const added = await h.ipc.invoke(CHANNELS.snippetsAdd, event, {
    trigger: 'server ssh',
    expansion: 'ssh alex@10.0.0.5',
  });
  const id = added.snippets[0].id;

  const updated = await h.ipc.invoke(CHANNELS.snippetsUpdate, event, id, {
    trigger: 'server ssh',
    expansion: 'ssh alex@10.0.0.5',
  });
  assert.equal(updated.snippets[0].expansion, 'ssh alex@10.0.0.5');

  const removed = await h.ipc.invoke(CHANNELS.snippetsRemove, event, id);
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.snippets, []);

  const missing = await h.ipc.invoke(CHANNELS.snippetsRemove, event, 'does-not-exist');
  assert.equal(missing.removed, false);
});

test('snippets.import reports how many snippets landed and how many were skipped', async () => {
  const h = mount();
  const event = { sender: new FakeSender(20) };

  await h.ipc.invoke(CHANNELS.snippetsAdd, event, {
    trigger: 'flowstate repo',
    expansion: 'https://github.com/Suma-Udd/flowstate',
  });
  const result = await h.ipc.invoke(CHANNELS.snippetsImport, event, {
    version: 1,
    snippets: [
      { trigger: 'commit template', expansion: 'feat(scope): summary' },
      { trigger: 'FLOWSTATE REPO', expansion: 'duplicate' },
    ],
  });
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.snippets.length, 2);
});

test('snippets.export returns a version and every snippet, without mutating anything', async () => {
  const h = mount();
  const event = { sender: new FakeSender(21) };

  await h.ipc.invoke(CHANNELS.snippetsAdd, event, {
    trigger: 'german signoff',
    expansion: 'Viele Grüße,\nSamuel',
  });
  const exported = await h.ipc.invoke(CHANNELS.snippetsExport, event);
  assert.equal(exported.version, 1);
  assert.equal(exported.snippets.length, 1);
  assert.equal(exported.snippets[0].trigger, 'german signoff');

  const stillOne = await h.ipc.invoke(CHANNELS.snippetsList, event);
  assert.equal(stillOne.snippets.length, 1);
});

test('app.version returns real facts and recent errors without touching the clipboard', async () => {
  const h = mount();
  const event = { sender: new FakeSender(8) };

  h.errorLog.record('Dictation failed: no speech detected.');
  const info = await h.ipc.invoke(CHANNELS.appVersion, event);

  assert.equal(info.appVersion, '0.1.0-test');
  assert.equal(info.modelVersion, 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8');
  assert.equal(info.recentErrors.length, 1);
  assert.match(info.recentErrors[0].message, /no speech detected/);
  assert.equal(h.clipboard.written, null);
  h.bridge.dispose();
});

test('app.diagnostics copies a versions/paths/errors summary to the clipboard', async () => {
  const h = mount();
  const event = { sender: new FakeSender(9) };

  h.errorLog.record('inject: target window was elevated.');
  const info = await h.ipc.invoke(CHANNELS.appDiagnostics, event);

  assert.equal(info.appVersion, '0.1.0-test');
  assert.match(h.clipboard.written, /Flowstate 0\.1\.0-test/);
  assert.match(h.clipboard.written, /inject: target window was elevated\./);
  assert.doesNotMatch(h.clipboard.written, /apiKey/i);
  h.bridge.dispose();
});

test('app.openLogs opens the real log directory', async () => {
  const h = mount();
  const event = { sender: new FakeSender(10) };

  assert.deepEqual(await h.ipc.invoke(CHANNELS.appOpenLogs, event), { opened: true });
  assert.deepEqual(h.shell.opened, ['C:\\fake\\logs']);
  h.bridge.dispose();
});

test('app.reveal only opens the closed set of real folders', async () => {
  const h = mount();
  const event = { sender: new FakeSender(11) };

  assert.deepEqual(await h.ipc.invoke(CHANNELS.appReveal, event, 'model'), { opened: true });
  assert.deepEqual(await h.ipc.invoke(CHANNELS.appReveal, event, 'config'), { opened: true });
  assert.deepEqual(h.shell.opened, ['C:\\fake\\models', 'C:\\fake']);
  assert.throws(
    () => h.ipc.invoke(CHANNELS.appReveal, event, 'system32'),
    /app\.reveal requires one of/
  );
  h.bridge.dispose();
});

test('app.openDoc only opens the closed set of documentation targets', async () => {
  const h = mount();
  const event = { sender: new FakeSender(12) };

  assert.deepEqual(await h.ipc.invoke(CHANNELS.appOpenDoc, event, 'readme'), { opened: true });
  assert.deepEqual(h.shell.opened, ['C:\\docs\\README.md']);
  assert.deepEqual(await h.ipc.invoke(CHANNELS.appOpenDoc, event, 'releases'), { opened: true });
  assert.deepEqual(h.shell.externals, ['https://example.com/releases']);
  assert.throws(
    () => h.ipc.invoke(CHANNELS.appOpenDoc, event, 'not-a-real-doc'),
    /app\.openDoc requires one of/
  );
  h.bridge.dispose();
});

test('history and app channels refuse to run before their services exist', async () => {
  const ipc = new FakeIpc();
  const config = new FakeConfig();
  const dictionary = new FakeDictionary();
  const snippets = new FakeSnippets();
  const mics = new FakeMics();
  const model = new FakeModel();
  const bridge = createIpcBridge({
    ipcMain: ipc,
    config,
    dictionary,
    snippets,
    mics,
    autostart: { async set() { return {}; } },
    theme: { get: () => ({}), set: async () => ({}) },
    model,
    getWindows: () => [],
  });
  const event = { sender: new FakeSender(13) };

  assert.throws(() => ipc.invoke(CHANNELS.historyRecent, event), /not available yet/);
  assert.throws(() => ipc.invoke(CHANNELS.historyClear, event), /not available yet/);
  assert.throws(() => ipc.invoke(CHANNELS.historySearch, event, 'x'), /not available yet/);
  assert.throws(() => ipc.invoke(CHANNELS.historyDelete, event, 'id'), /not available yet/);
  assert.throws(() => ipc.invoke(CHANNELS.appOpenLogs, event), /not available yet/);
  assert.throws(() => ipc.invoke(CHANNELS.appReveal, event, 'model'), /not available yet/);
  // No `docs` map was configured, so the closed set of valid keys is empty.
  assert.throws(() => ipc.invoke(CHANNELS.appOpenDoc, event, 'readme'), /requires one of/);
  // app.version stays honest with no versions/errorLog configured, rather than throwing.
  assert.deepEqual(await ipc.invoke(CHANNELS.appVersion, event), { recentErrors: [] });
  bridge.dispose();
});

test('microphone payloads get friendly names, defaults first, and no duplicates', () => {
  assert.deepEqual(normaliseDevices([
    { deviceId: 'usb', groupId: 'g1', label: '' },
    { deviceId: 'default', groupId: 'g2', label: 'Default - Desk microphone' },
    { deviceId: 'usb', groupId: 'duplicate', label: 'Duplicate' },
  ]), [
    {
      deviceId: 'default',
      groupId: 'g2',
      label: 'Desk microphone',
      isDefault: true,
    },
    {
      deviceId: 'usb',
      groupId: 'g1',
      label: 'Microphone 1',
      isDefault: false,
    },
  ]);
  assert.throws(() => normaliseDevices([{ label: 'missing id' }]), /deviceId/);
});

test('microphone service enumerates in a sandbox and watches devicechange live', async () => {
  const ipcMain = new EventEmitter();
  const windows = [];

  class FakeMicWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.sent = [];
      this.webContents.send = (channel, payload) => {
        this.webContents.sent.push([channel, payload]);
      };
      windows.push(this);
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit('closed');
    }
    loadFile(file) {
      this.loaded = file;
      return Promise.resolve();
    }
  }

  let nextId = 0;
  const service = createMicrophoneService({
    BrowserWindow: FakeMicWindow,
    ipcMain,
    createId: () => `request-${++nextId}`,
  });

  const listed = service.list();
  const listWindow = windows.at(-1);
  assert.equal(listWindow.options.show, false);
  assert.equal(listWindow.options.webPreferences.contextIsolation, true);
  assert.equal(listWindow.options.webPreferences.nodeIntegration, false);
  assert.equal(listWindow.options.webPreferences.sandbox, true);
  listWindow.webContents.emit('did-finish-load');
  assert.deepEqual(listWindow.webContents.sent.at(-1), [
    MIC_CHANNELS.command,
    { type: 'list', id: 'request-1' },
  ]);
  ipcMain.emit(MIC_CHANNELS.result, { sender: listWindow.webContents }, {
    id: 'request-1',
    devices: [{ deviceId: 'default', groupId: '', label: 'Default - Array mic' }],
  });
  assert.deepEqual(await listed, [{
    deviceId: 'default',
    groupId: '',
    label: 'Array mic',
    isDefault: true,
  }]);
  assert.equal(listWindow.destroyed, true, 'one-shot enumeration left a hidden window');

  const changes = [];
  service.onChange((devices) => changes.push(devices));
  const release = service.watch();
  const watchWindow = windows.at(-1);
  watchWindow.webContents.emit('did-finish-load');
  assert.deepEqual(watchWindow.webContents.sent.at(-1), [
    MIC_CHANNELS.command,
    { type: 'watch' },
  ]);
  ipcMain.emit(MIC_CHANNELS.changed, { sender: watchWindow.webContents }, [
    { deviceId: 'usb', groupId: 'usb', label: 'USB microphone' },
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0][0].label, 'USB microphone');

  release();
  assert.deepEqual(watchWindow.webContents.sent.at(-1), [
    MIC_CHANNELS.command,
    { type: 'unwatch' },
  ]);
  assert.equal(watchWindow.destroyed, true, 'unsubscribing left a hidden window');
  service.dispose();
});

test('autostart writes the Windows Run key and trusts only exact read-back', async () => {
  let stored = null;
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === 'add') {
      stored = args[args.indexOf('/d') + 1];
      return { stdout: '', stderr: '' };
    }
    if (args[0] === 'delete') {
      stored = null;
      return { stdout: '', stderr: '' };
    }
    if (stored === null) {
      const error = new Error('not found');
      error.code = 1;
      throw error;
    }
    return {
      stdout: `\n    Flowstate    REG_SZ    ${stored}\n`,
      stderr: '',
    };
  };
  const manager = createAutostartManager({
    executablePath: 'C:\\Program Files\\Flowstate\\Flowstate.exe',
    appPath: 'C:\\unused',
    isPackaged: true,
    run,
  });

  assert.deepEqual(await manager.set(true), {
    enabled: true,
    command: '"C:\\Program Files\\Flowstate\\Flowstate.exe" --autostart',
  });
  assert.equal(calls[0][0], 'add');
  assert.equal(calls[0][1], 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
  assert.deepEqual(await manager.set(false), { enabled: false, command: null });

  assert.deepEqual(publicConfig({
    ...structuredClone(DEFAULT_CONFIG),
    llm: { ...structuredClone(DEFAULT_CONFIG.llm), apiKey: '' },
  }).llm.apiKeyConfigured, false);
  assert.deepEqual(validateConfigPatch({ ui: { theme: 'system' } }), {
    ui: { theme: 'system' },
  });
  assert.deepEqual(validateConfigPatch({ llm: { provider: 'local' } }), {
    llm: { provider: 'local' },
  });
});

test('history.facets passes the store facets and history.paste reads the text by id', async () => {
  const pasted = [];
  const h = mount({ rePaste: async (text) => { pasted.push(text); return { ok: true, code: 'pasted' }; } });
  const event = { sender: new FakeSender(21) };
  h.history.facets = () => ({ total: 2, languages: ['de'], apps: [{ exe: 'a.exe', label: 'a' }] });
  h.history.get = (id) => (id === 'known' ? { id, text: 'Hallo Welt.' } : null);

  assert.deepEqual((await h.ipc.invoke(CHANNELS.historyFacets, event)).languages, ['de']);
  assert.throws(() => h.ipc.invoke(CHANNELS.historyFacets, event, 1));

  assert.deepEqual(await h.ipc.invoke(CHANNELS.historyPaste, event, 'known'), { ok: true, code: 'pasted' });
  assert.deepEqual(pasted, ['Hallo Welt.']);
  assert.deepEqual(await h.ipc.invoke(CHANNELS.historyPaste, event, 'gone'), { ok: false, code: 'not-found' });
  await assert.rejects(async () => h.ipc.invoke(CHANNELS.historyPaste, event, ''), /requires a dictation id/);
  await assert.rejects(async () => h.ipc.invoke(CHANNELS.historyPaste, event, 'known', 'x'), /one id argument/);
  h.bridge.dispose();
});

test('scratch channels read, save, copy and export the stored text and route inserts', async () => {
  let stored = { text: 'saved', updatedAt: null };
  const active = [];
  const saved = [];
  const h = mount({
    scratch: {
      get: () => stored,
      set: async (text) => {
        stored = { text, updatedAt: 'now' };
        return { updatedAt: 'now' };
      },
    },
    scratchSession: { setActive: (value) => active.push(value) },
    saveTextFile: async (text) => {
      saved.push(text);
      return { saved: true, fileName: 'scratchpad.txt' };
    },
  });
  const event = { sender: new FakeSender(1) };

  assert.deepEqual(await h.ipc.invoke(CHANNELS.scratchGet, event), { text: 'saved', updatedAt: null });
  assert.deepEqual(await h.ipc.invoke(CHANNELS.scratchSet, event, 'fresh'), { updatedAt: 'now' });
  assert.throws(() => h.ipc.invoke(CHANNELS.scratchSet, event, 42), TypeError);

  await h.ipc.invoke(CHANNELS.scratchActive, event, true);
  assert.throws(() => h.ipc.invoke(CHANNELS.scratchActive, event, 'yes'), TypeError);
  assert.deepEqual(active, [true]);

  await h.ipc.invoke(CHANNELS.scratchCopy, event);
  assert.equal(h.clipboard.written, 'fresh', 'copy uses the stored text, not a renderer string');
  const exported = await h.ipc.invoke(CHANNELS.scratchExport, event);
  assert.equal(exported.saved, true);
  assert.deepEqual(saved, ['fresh']);

  assert.equal(h.bridge.insertIntoScratchpad('dictated'), true);
  assert.deepEqual(h.windowSender.sent.at(-1), [CHANNELS.scratchInsert, 'dictated']);
});

test('scratch channels say so when the store is missing', async () => {
  const h = mount();
  assert.throws(
    () => h.ipc.invoke(CHANNELS.scratchGet, { sender: new FakeSender(1) }),
    /not available/
  );
});

test('llm.providers lists the presets without leaking anything, and llm.test runs the service', async () => {
  let tested = 0;
  const h = mount({ llm: { async test() { tested += 1; return { ok: true }; } } });
  const event = { sender: new FakeSender(40) };

  const providers = await h.ipc.invoke(CHANNELS.llmProviders, event);
  assert.deepEqual(providers.map((p) => p.id), ['deepseek', 'openai', 'groq', 'openrouter', 'custom']);
  assert.equal(providers.find((p) => p.id === 'custom').requiresApiKey, false);
  assert.equal(providers.find((p) => p.id === 'groq').keyDoc, 'key-groq');
  assert.equal(providers.find((p) => p.id === 'custom').keyDoc, null);
  assert.deepEqual(await h.ipc.invoke(CHANNELS.llmTest, event), { ok: true });
  assert.equal(tested, 1);
  assert.throws(() => h.ipc.invoke(CHANNELS.llmTest, event, 'extra'), /takes no arguments/);
  h.bridge.dispose();
});

test('config accepts a custom base URL and model, and the one-time setup flag, and nothing sloppy', async () => {
  const h = mount();
  const event = { sender: new FakeSender(41) };

  const updated = await h.ipc.invoke(CHANNELS.configSet, event, {
    llm: { provider: 'custom', baseUrl: ' http://localhost:11434/v1 ', model: 'llama3.2' },
    onboarding: { completed: true },
  });
  assert.equal(updated.llm.baseUrl, 'http://localhost:11434/v1');
  assert.equal(updated.llm.model, 'llama3.2');
  assert.equal(updated.onboarding.completed, true);

  for (const patch of [
    { llm: { baseUrl: 'ftp://example.com' } },
    { llm: { baseUrl: 'javascript:alert(1)' } },
    { llm: { baseUrl: 'https://has space.example' } },
    { llm: { model: 'x'.repeat(200) } },
    { onboarding: { completed: 'yes' } },
    { onboarding: { done: true } },
  ]) {
    await assert.rejects(
      async () => h.ipc.invoke(CHANNELS.configSet, event, patch),
      undefined,
      JSON.stringify(patch)
    );
  }
  h.bridge.dispose();
});

test('update channels expose state, a manual check, install and dismiss, and push changes to windows', async () => {
  const listeners = [];
  const calls = [];
  const updater = {
    getState: () => ({ phase: 'idle', currentVersion: '0.1.0' }),
    async check(options) { calls.push(['check', options]); return { phase: 'up-to-date' }; },
    async install() { calls.push(['install']); return { phase: 'installing' }; },
    dismiss() { calls.push(['dismiss']); return { phase: 'idle' }; },
    onState(listener) { listeners.push(listener); return () => {}; },
  };
  const h = mount({ updater });
  const event = { sender: new FakeSender(42) };

  assert.deepEqual(await h.ipc.invoke(CHANNELS.updateState, event), { phase: 'idle', currentVersion: '0.1.0' });
  assert.deepEqual(await h.ipc.invoke(CHANNELS.updateCheck, event), { phase: 'up-to-date' });
  assert.deepEqual(calls[0], ['check', { manual: true }]);
  assert.deepEqual(await h.ipc.invoke(CHANNELS.updateInstall, event), { started: true });
  assert.deepEqual(await h.ipc.invoke(CHANNELS.updateDismiss, event), { phase: 'idle' });

  listeners[0]({ phase: 'available', version: '0.2.0' });
  assert.equal(h.windowSender.sent.at(-1)[0], CHANNELS.updateChanged);
  assert.equal(h.windowSender.sent.at(-1)[1].version, '0.2.0');
  h.bridge.dispose();
});

test('update channels refuse to run before an updater exists', () => {
  const h = mount();
  const event = { sender: new FakeSender(43) };
  assert.throws(() => h.ipc.invoke(CHANNELS.updateState, event), /not available yet/);
  h.bridge.dispose();
});
