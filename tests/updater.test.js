'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createUpdater } = require('../src/main/updater');
const { signManifest } = require('../src/shared/update-verify');

const INSTALLER = Buffer.from('pretend this is an installer '.repeat(500));
const INSTALLER_SHA = crypto.createHash('sha256').update(INSTALLER).digest('hex');
const MANIFEST_URL = 'https://example.com/latest.json';
const INSTALLER_URL = 'https://example.com/Flowstate-Setup.exe';

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function bodyOf(buffer, chunk = 700) {
  let offset = 0;
  return {
    getReader() {
      return {
        async read() {
          if (offset >= buffer.length) return { done: true };
          const value = new Uint8Array(buffer.subarray(offset, offset + chunk));
          offset += chunk;
          return { done: false, value };
        },
      };
    },
  };
}

function setup(t, { current = '0.1.0', version = '0.2.0', installer = INSTALLER, manifestPatch = {}, sign = true } = {}) {
  const { publicPem, privatePem } = keys();
  const fields = { version, notes: 'Notes.', url: INSTALLER_URL, sha256: INSTALLER_SHA };
  const manifest = sign ? { ...signManifest(fields, privatePem), ...manifestPatch } : { ...fields, signature: 'x', ...manifestPatch };
  const calls = { fetched: [], spawned: [], quit: 0, prepared: 0 };
  const warnings = [];
  const state = { manifestResponse: null };

  const fetchImpl = async (url) => {
    calls.fetched.push(url);
    if (url === MANIFEST_URL) {
      if (state.manifestResponse) return state.manifestResponse;
      return { ok: true, status: 200, text: async () => JSON.stringify(manifest) };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => String(installer.length) },
      body: bodyOf(installer),
    };
  };

  const downloadDirectory = path.join(os.tmpdir(), `flowstate-updater-${crypto.randomUUID()}`);
  t.after(() => fs.rm(downloadDirectory, { recursive: true, force: true }));

  const updater = createUpdater({
    currentVersion: current,
    manifestUrl: MANIFEST_URL,
    publicKeyPem: publicPem,
    fetchImpl,
    downloadDirectory,
    executablePath: 'C:\\Apps\\Flowstate\\Flowstate.exe',
    spawnProcess: (...args) => {
      calls.spawned.push(args);
      return { unref() {} };
    },
    prepareForInstall: async () => {
      calls.prepared += 1;
    },
    quitApp: () => {
      calls.quit += 1;
    },
    logger: { warn: (m) => warnings.push(m), error: (m) => warnings.push(m) },
    timers: {
      setTimeout: (fn) => {
        fn();
        return 1;
      },
      clearTimeout() {},
      setInterval: () => ({ unref() {} }),
      clearInterval() {},
    },
  });
  return { updater, calls, state, warnings, downloadDirectory };
}

test('a newer signed release becomes an available update with its notes', async (t) => {
  const h = setup(t);
  const state = await h.updater.check({ manual: true });
  assert.equal(state.phase, 'available');
  assert.equal(state.version, '0.2.0');
  assert.equal(state.notes, 'Notes.');
});

test('the same or an older release means up to date', async (t) => {
  for (const version of ['0.1.0', '0.0.9']) {
    const h = setup(t, { version });
    assert.equal((await h.updater.check({ manual: true })).phase, 'up-to-date', version);
  }
});

test('a manifest with a bad signature is refused and never offered', async (t) => {
  const h = setup(t, { manifestPatch: { version: '9.9.9' } });
  const state = await h.updater.check({ manual: true });
  assert.equal(state.phase, 'error');
  assert.equal(state.errorCode, 'bad-signature');
  assert.equal(h.calls.fetched.includes(INSTALLER_URL), false, 'it must not download anything');
});

test('a background check that fails stays quiet; a manual one explains', async (t) => {
  const h = setup(t);
  h.state.manifestResponse = { ok: false, status: 503, text: async () => '' };
  const quiet = await h.updater.check();
  assert.equal(quiet.phase, 'idle');
  const loud = await h.updater.check({ manual: true });
  assert.equal(loud.phase, 'error');
  assert.match(loud.error, /Could not reach/);
});

test('a missing release (404) reads as "no release yet", not a crash', async (t) => {
  const h = setup(t);
  h.state.manifestResponse = { ok: false, status: 404, text: async () => '' };
  const state = await h.updater.check({ manual: true });
  assert.equal(state.errorCode, 'no-release');
});

test('install downloads, verifies, writes a launcher, stops the worker and quits', async (t) => {
  const h = setup(t);
  await h.updater.check({ manual: true });

  const state = await h.updater.install();

  assert.equal(state.phase, 'installing');
  assert.equal(h.calls.prepared, 1, 'the speech worker must be stopped before the installer runs');
  assert.equal(h.calls.quit, 1);
  assert.equal(h.calls.spawned.length, 1);
  const [command, args, options] = h.calls.spawned[0];
  assert.equal(command, 'cmd.exe');
  assert.equal(options.detached, true);
  const script = await fs.readFile(args[1], 'ascii');
  assert.match(script, /\/S/);
  assert.match(script, /Flowstate-Setup-0\.2\.0\.exe/);
  assert.match(script, /Flowstate\.exe/);
  const saved = await fs.readFile(path.join(h.downloadDirectory, 'Flowstate-Setup-0.2.0.exe'));
  assert.deepEqual(saved, INSTALLER);
});

test('a tampered download is discarded and the installer is never run', async (t) => {
  const tampered = Buffer.from(INSTALLER);
  tampered[10] ^= 0xff;
  const h = setup(t, { installer: tampered });
  await h.updater.check({ manual: true });

  const state = await h.updater.install();

  assert.equal(state.phase, 'error');
  assert.equal(state.errorCode, 'bad-checksum');
  assert.equal(h.calls.spawned.length, 0);
  assert.equal(h.calls.quit, 0);
  assert.equal(h.calls.prepared, 0);
  const left = await fs.readdir(h.downloadDirectory);
  assert.deepEqual(left, [], 'no partial or tampered file may be left behind');
});

test('a truncated download fails the checksum too', async (t) => {
  const h = setup(t, { installer: INSTALLER.subarray(0, 1000) });
  await h.updater.check({ manual: true });
  assert.equal((await h.updater.install()).errorCode, 'bad-checksum');
});

test('install does nothing when there is no update on offer', async (t) => {
  const h = setup(t);
  const state = await h.updater.install();
  assert.equal(state.phase, 'idle');
  assert.equal(h.calls.fetched.length, 0);
});

test('dismiss hides the offer without forgetting how to find the next one', async (t) => {
  const h = setup(t);
  await h.updater.check({ manual: true });
  assert.equal(h.updater.dismiss().phase, 'idle');
  assert.equal((await h.updater.check()).phase, 'available');
});

test('progress and phase changes are published to listeners', async (t) => {
  const h = setup(t);
  const phases = [];
  h.updater.onState((s) => phases.push(s.phase));
  await h.updater.check({ manual: true });
  await h.updater.install();
  assert.deepEqual(
    [...new Set(phases)],
    ['checking', 'available', 'downloading', 'verifying', 'installing']
  );
});
