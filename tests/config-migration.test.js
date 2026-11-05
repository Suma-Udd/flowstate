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

async function configFixture(t, contents) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'flowstate-config-migration-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'config.json');
  await fs.writeFile(filePath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
  return { directory, filePath };
}

test('the pre-schema #08 config upgrades cleanly to schema v1', async (t) => {
  const legacy = {
    hotkey: { chord: ['Alt', 'Space'] },
    audio: { deviceId: 'legacy-microphone' },
    asr: { languages: ['en', 'de'], unloadAfterMinutes: 30 },
    llm: {
      provider: 'deepseek',
      apiKey: '',
      enabled: false,
      timeoutMs: 2_000,
      skipUnderWords: 6,
    },
    ui: { theme: 'dark', windowBounds: null },
    system: { autostart: false, startMinimised: false },
    history: { retentionDays: 90 },
  };
  const { directory, filePath } = await configFixture(t, legacy);

  const migrated = await createConfigStore({ directory }).load();
  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const entries = await fs.readdir(directory);

  assert.equal(migrated.version, CURRENT_CONFIG_VERSION);
  assert.deepEqual(migrated.hotkey, legacy.hotkey);
  assert.deepEqual(migrated.audio, legacy.audio);
  assert.deepEqual(migrated.asr, { ...legacy.asr, hotwords: true });
  assert.deepEqual(migrated.llm, {
    ...legacy.llm,
    baseUrl: '',
    model: '',
    removeFillers: true,
  });
  assert.deepEqual(migrated.ui, { ...legacy.ui, notices: { rawTranscript: false } });
  assert.deepEqual(migrated.onboarding, { completed: true });
  assert.deepEqual(migrated.system, legacy.system);
  assert.deepEqual(migrated.history, legacy.history);
  assert.deepEqual(persisted, migrated);
  assert.deepEqual(entries, ['config.json'], 'an atomic-write temporary file was left behind');
});

test('a partial old config gains every v1 default without losing its choices', async (t) => {
  const { directory } = await configFixture(t, {
    hotkey: { chord: ['Ctrl', 'Shift', 'X'] },
    ui: { theme: 'light' },
  });

  const migrated = await createConfigStore({ directory }).load();

  assert.deepEqual(migrated.hotkey.chord, ['Ctrl', 'Shift', 'X']);
  assert.equal(migrated.ui.theme, 'light');
  assert.deepEqual(migrated.audio, DEFAULT_CONFIG.audio);
  assert.deepEqual(migrated.asr, DEFAULT_CONFIG.asr);
  assert.deepEqual(migrated.system, DEFAULT_CONFIG.system);
  assert.equal(migrated.version, CURRENT_CONFIG_VERSION);
});

test('a brand-new install starts with the first-run setup still to do', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'flowstate-config-fresh-')
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const config = await createConfigStore({ directory }).load();

  assert.equal(config.version, CURRENT_CONFIG_VERSION);
  assert.deepEqual(config.onboarding, { completed: false });
  assert.equal(config.llm.apiKey, '');
  assert.equal(config.llm.provider, 'deepseek');
});

test('a v1 config from before the setup screen counts as already set up', async (t) => {
  const { directory } = await configFixture(t, {
    version: 1,
    hotkey: { chord: ['Ctrl', 'Meta'] },
    llm: { provider: 'deepseek', apiKey: 'kept-as-is', enabled: true },
  });

  const migrated = await createConfigStore({ directory }).load();

  assert.deepEqual(migrated.onboarding, { completed: true });
  assert.equal(migrated.llm.apiKey, 'kept-as-is');
});
