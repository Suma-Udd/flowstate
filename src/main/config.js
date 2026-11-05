'use strict';

const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');

const CURRENT_CONFIG_VERSION = 2;

const DEFAULT_CONFIG = Object.freeze({
  version: CURRENT_CONFIG_VERSION,
  hotkey: Object.freeze({ chord: Object.freeze(['Ctrl', 'Meta']) }),
  audio: Object.freeze({ deviceId: null }),
  asr: Object.freeze({
    languages: Object.freeze(['en', 'de', 'el']),
    unloadAfterMinutes: 15,
    hotwords: true,
  }),
  llm: Object.freeze({
    provider: 'deepseek',
    apiKey: '',
    // Empty means "use the provider's own default". Only the custom provider
    // needs both filled in.
    baseUrl: '',
    model: '',
    enabled: true,
    timeoutMs: 2500,
    skipUnderWords: 4,
    removeFillers: true,
  }),
  ui: Object.freeze({
    theme: 'system',
    windowBounds: null,
    // One-time hints that have already been shown, so they never repeat.
    notices: Object.freeze({ rawTranscript: false }),
  }),
  onboarding: Object.freeze({ completed: false }),
  system: Object.freeze({ autostart: true, startMinimised: true }),
  history: Object.freeze({ retentionDays: 0 }),
});

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeObjects(base, patch) {
  if (!isPlainObject(patch)) {
    return clone(patch);
  }

  const result = isPlainObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(value)
      ? mergeObjects(result[key], value)
      : clone(value);
  }
  return result;
}

const MIGRATIONS = new Map([
  [
    0,
    (config) => ({
      ...config,
      version: 1,
    }),
  ],
  [
    // Anyone who already has a config file has already been using the app, so
    // the first-run setup is marked done instead of being shown to them.
    1,
    (config) => ({
      ...config,
      version: 2,
      onboarding: { completed: true },
    }),
  ],
]);

function migrateConfig(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('Flowstate config must contain a JSON object.');
  }

  let config = clone(input);
  let version = config.version ?? 0;

  if (!Number.isInteger(version) || version < 0) {
    throw new TypeError('Flowstate config has an invalid version.');
  }
  if (version > CURRENT_CONFIG_VERSION) {
    throw new Error(
      `Flowstate config version ${version} is newer than supported version ${CURRENT_CONFIG_VERSION}.`
    );
  }

  while (version < CURRENT_CONFIG_VERSION) {
    const migrate = MIGRATIONS.get(version);
    if (!migrate) {
      throw new Error(`No Flowstate config migration exists for version ${version}.`);
    }

    config = migrate(config);
    const nextVersion = config.version;
    if (!Number.isInteger(nextVersion) || nextVersion <= version) {
      throw new Error(`Flowstate config migration ${version} did not advance the version.`);
    }
    version = nextVersion;
  }

  const normalised = mergeObjects(DEFAULT_CONFIG, config);
  normalised.version = CURRENT_CONFIG_VERSION;
  return normalised;
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle;

  await fs.mkdir(directory, { recursive: true });

  try {
    handle = await fs.open(tempPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

class ConfigStore extends EventEmitter {
  #config;
  #updates = Promise.resolve();

  constructor(filePath) {
    super();
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('ConfigStore requires a config file path.');
    }
    this.filePath = path.resolve(filePath);
  }

  async load() {
    let raw;
    let shouldWrite = false;

    try {
      raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
      raw = clone(DEFAULT_CONFIG);
      shouldWrite = true;
    }

    const config = migrateConfig(raw);
    if (JSON.stringify(config) !== JSON.stringify(raw)) {
      shouldWrite = true;
    }
    if (shouldWrite) {
      await writeJsonAtomic(this.filePath, config);
    }

    this.#config = config;
    return this.get();
  }

  get() {
    if (!this.#config) {
      throw new Error('Flowstate config has not been loaded.');
    }
    return clone(this.#config);
  }

  update(patch) {
    if (!isPlainObject(patch)) {
      return Promise.reject(new TypeError('Flowstate config patch must be an object.'));
    }
    const safePatch = clone(patch);
    const operation = this.#updates.then(async () => {
      if (!this.#config) {
        await this.load();
      }

      const next = migrateConfig(mergeObjects(this.#config, safePatch));
      await writeJsonAtomic(this.filePath, next);
      this.#config = next;

      const snapshot = this.get();
      this.emit('change', snapshot);
      return snapshot;
    });
    // A failed write rejects its own caller but does not poison later settings
    // updates. Serialising here also prevents two immediate controls from
    // reading the same old snapshot and silently losing one another.
    this.#updates = operation.catch(() => {});
    return operation;
  }
}

function createConfigStore({ directory, filePath } = {}) {
  const resolvedPath = filePath ?? (directory && path.join(directory, 'config.json'));
  if (!resolvedPath) {
    throw new TypeError('createConfigStore requires directory or filePath.');
  }
  return new ConfigStore(resolvedPath);
}

module.exports = {
  CURRENT_CONFIG_VERSION,
  DEFAULT_CONFIG,
  ConfigStore,
  createConfigStore,
  migrateConfig,
  writeJsonAtomic,
};
