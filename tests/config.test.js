'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  CURRENT_CONFIG_VERSION,
  DEFAULT_CONFIG,
  createConfigStore,
} = require('../src/main/config');

async function tempConfig(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flowstate-config-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    filePath: path.join(directory, 'config.json'),
    store: createConfigStore({ directory }),
  };
}

test('first load returns and persists the schema defaults', async (t) => {
  const { filePath, store } = await tempConfig(t);

  const config = await store.load();
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));

  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(persisted, DEFAULT_CONFIG);
  assert.equal(config.version, CURRENT_CONFIG_VERSION);
});

test('nested config updates round-trip without replacing sibling defaults', async (t) => {
  const { directory, store } = await tempConfig(t);
  await store.load();

  const updated = await store.update({
    audio: { deviceId: 'microphone-1' },
    llm: { enabled: false },
    ui: { theme: 'dark' },
  });

  const reloaded = createConfigStore({ directory });
  const roundTrip = await reloaded.load();

  assert.deepEqual(roundTrip, updated);
  assert.equal(roundTrip.audio.deviceId, 'microphone-1');
  assert.equal(roundTrip.llm.enabled, false);
  assert.equal(roundTrip.llm.timeoutMs, DEFAULT_CONFIG.llm.timeoutMs);
  assert.equal(roundTrip.ui.theme, 'dark');
  assert.deepEqual(roundTrip.hotkey, DEFAULT_CONFIG.hotkey);
});

test('back-to-back settings writes are serialised without losing either patch', async (t) => {
  const { directory, store } = await tempConfig(t);
  await store.load();

  await Promise.all([
    store.update({ audio: { deviceId: 'desk-microphone' } }),
    store.update({ system: { startMinimised: false } }),
    store.update({ history: { retentionDays: 30 } }),
  ]);

  const reloaded = await createConfigStore({ directory }).load();
  assert.equal(reloaded.audio.deviceId, 'desk-microphone');
  assert.equal(reloaded.system.startMinimised, false);
  assert.equal(reloaded.history.retentionDays, 30);
});

test('a version 0 config migrates to version 1 and is rewritten', async (t) => {
  const { filePath, store } = await tempConfig(t);
  const v0 = {
    hotkey: { chord: ['Alt', 'Space'] },
    system: { autostart: false, startMinimised: false },
    ui: { theme: 'light' },
  };
  await fs.writeFile(filePath, JSON.stringify(v0), 'utf8');

  const migrated = await store.load();
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));

  assert.equal(migrated.version, CURRENT_CONFIG_VERSION);
  assert.deepEqual(migrated.hotkey.chord, ['Alt', 'Space']);
  assert.equal(migrated.system.autostart, false);
  assert.equal(migrated.system.startMinimised, false);
  assert.equal(migrated.ui.theme, 'light');
  assert.deepEqual(migrated.asr, DEFAULT_CONFIG.asr);
  assert.deepEqual(persisted, migrated);
});
