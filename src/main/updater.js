'use strict';

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { isNewerVersion, sha256Matches, verifyManifest } = require('../shared/update-verify');

const FIRST_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MANIFEST_TIMEOUT_MS = 15_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const INSTALLER_NAME = 'Flowstate-Setup.exe';

const MESSAGES = Object.freeze({
  'no-network': 'Could not reach the update server. Check your connection and try again.',
  'no-release': 'No release is published yet.',
  malformed: 'The update information was not in the expected format.',
  'insecure-url': 'The update link was not secure, so it was ignored.',
  'bad-signature': 'The update information failed its signature check, so it was ignored.',
  'download-failed': 'The download did not finish. Try again in a moment.',
  'bad-checksum': 'The downloaded file did not match its checksum, so it was discarded.',
  'install-failed': 'The installer could not be started.',
});

function messageFor(code) {
  return MESSAGES[code] ?? 'Something went wrong while updating.';
}

class UpdateFailure extends Error {
  constructor(code) {
    super(messageFor(code));
    this.name = 'UpdateFailure';
    this.code = code;
  }
}

function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '')}"`;
}

/*
 * Checks GitHub for a signed latest.json, downloads the installer it names,
 * verifies the checksum and the signature, then runs it silently.
 *
 * Nothing here is trusted until verifyManifest() passes: the manifest, the
 * download URL and the checksum are all covered by the Ed25519 signature, and
 * the file is hashed while it downloads and compared before it is ever run.
 */
function createUpdater({
  currentVersion,
  manifestUrl,
  publicKeyPem,
  fetchImpl = globalThis.fetch,
  downloadDirectory,
  spawnProcess,
  executablePath,
  prepareForInstall = async () => {},
  quitApp = () => {},
  logger = console,
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
  now = () => Date.now(),
} = {}) {
  if (typeof currentVersion !== 'string') throw new TypeError('currentVersion is required.');
  if (typeof manifestUrl !== 'string') throw new TypeError('manifestUrl is required.');
  if (typeof publicKeyPem !== 'string') throw new TypeError('publicKeyPem is required.');
  if (typeof downloadDirectory !== 'string') throw new TypeError('downloadDirectory is required.');

  const events = new EventEmitter();
  let state = Object.freeze({
    phase: 'idle',
    currentVersion,
    lastCheckedAt: null,
  });
  let manifest = null;
  let installerPath = null;
  let busy = false;
  let startTimer = null;
  let interval = null;
  let downloadController = null;

  function setState(patch) {
    state = Object.freeze({ ...state, ...patch });
    events.emit('state', state);
    return state;
  }

  async function fetchWithTimeout(url, options = {}, ms = MANIFEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = timers.setTimeout(() => controller.abort(), ms);
    try {
      return await fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
      timers.clearTimeout(timer);
    }
  }

  async function readManifest() {
    let response;
    try {
      response = await fetchWithTimeout(manifestUrl, {
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        redirect: 'follow',
      });
    } catch {
      throw new UpdateFailure('no-network');
    }
    if (response.status === 404) throw new UpdateFailure('no-release');
    if (!response.ok) throw new UpdateFailure('no-network');

    let text;
    try {
      text = await response.text();
    } catch {
      throw new UpdateFailure('no-network');
    }
    if (text.length > MAX_MANIFEST_BYTES) throw new UpdateFailure('malformed');

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new UpdateFailure('malformed');
    }
    const verdict = verifyManifest(parsed, publicKeyPem);
    if (!verdict.ok) throw new UpdateFailure(verdict.reason);
    return verdict.manifest;
  }

  /**
   * Look for a newer release. `manual` makes errors visible; a background
   * check that fails stays quiet, because "no internet" is not news.
   */
  async function check({ manual = false } = {}) {
    if (busy || ['downloading', 'verifying', 'installing'].includes(state.phase)) {
      return state;
    }
    busy = true;
    if (manual) setState({ phase: 'checking', error: undefined });
    try {
      const found = await readManifest();
      const checkedAt = now();
      if (isNewerVersion(found.version, currentVersion)) {
        manifest = found;
        installerPath = null;
        return setState({
          phase: 'available',
          version: found.version,
          notes: found.notes,
          progress: 0,
          error: undefined,
          lastCheckedAt: checkedAt,
        });
      }
      manifest = null;
      return setState({
        phase: 'up-to-date',
        version: undefined,
        notes: undefined,
        error: undefined,
        lastCheckedAt: checkedAt,
      });
    } catch (error) {
      const code = error instanceof UpdateFailure ? error.code : 'no-network';
      logger.warn?.(`Flowstate update check failed (${code}).`);
      if (manual) {
        return setState({ phase: 'error', error: messageFor(code), errorCode: code });
      }
      // Background failure: keep whatever the card was showing.
      if (state.phase === 'checking') setState({ phase: 'idle' });
      return state;
    } finally {
      busy = false;
    }
  }

  async function download() {
    if (!manifest) throw new UpdateFailure('malformed');
    await fsp.mkdir(downloadDirectory, { recursive: true });
    const target = path.join(downloadDirectory, `Flowstate-Setup-${manifest.version}.exe`);
    const partial = `${target}.part`;
    await fsp.rm(partial, { force: true });

    downloadController = new AbortController();
    let response;
    try {
      response = await fetchImpl(manifest.url, {
        signal: downloadController.signal,
        redirect: 'follow',
      });
    } catch {
      throw new UpdateFailure('download-failed');
    }
    if (!response.ok || !response.body) throw new UpdateFailure('download-failed');

    const total = Number(response.headers?.get?.('content-length')) || 0;
    const hash = crypto.createHash('sha256');
    const output = fs.createWriteStream(partial);
    let received = 0;
    let lastReport = 0;

    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        received += value.length;
        if (!output.write(value)) {
          await new Promise((resolve) => output.once('drain', resolve));
        }
        const stamp = now();
        if (total > 0 && stamp - lastReport > 100) {
          lastReport = stamp;
          setState({ progress: Math.min(1, received / total) });
        }
      }
      await new Promise((resolve, reject) => {
        output.once('error', reject);
        output.end(resolve);
      });
    } catch {
      output.destroy();
      await fsp.rm(partial, { force: true });
      throw new UpdateFailure('download-failed');
    } finally {
      downloadController = null;
    }

    setState({ phase: 'verifying', progress: 1 });
    if (!sha256Matches(manifest.sha256, hash.digest('hex'))) {
      await fsp.rm(partial, { force: true });
      throw new UpdateFailure('bad-checksum');
    }
    await fsp.rename(partial, target);
    return target;
  }

  /** Download, verify, then hand over to the installer and quit. */
  async function install() {
    if (state.phase !== 'available' && state.phase !== 'error') return state;
    if (!manifest) return state;
    if (busy) return state;
    busy = true;
    try {
      setState({ phase: 'downloading', progress: 0, error: undefined });
      installerPath = await download();

      setState({ phase: 'installing' });
      await prepareForInstall();
      launchInstaller(installerPath);
      // Give the batch file a moment to start before this process goes away.
      timers.setTimeout(quitApp, 400);
      return state;
    } catch (error) {
      const code = error instanceof UpdateFailure ? error.code : 'install-failed';
      logger.error?.(`Flowstate update failed (${code}).`);
      return setState({ phase: 'error', error: messageFor(code), errorCode: code });
    } finally {
      busy = false;
    }
  }

  /*
   * A small batch file outlives this process: wait for the app to exit, run
   * the installer silently and wait for it, then start the new version. The
   * installer is already verified, and the batch file contains only paths.
   */
  function launchInstaller(installer) {
    if (typeof spawnProcess !== 'function') throw new UpdateFailure('install-failed');
    const script = path.join(downloadDirectory, 'apply-update.cmd');
    const lines = [
      '@echo off',
      'ping -n 4 127.0.0.1 >nul',
      `start "" /wait ${quoteForCmd(installer)} /S`,
      `start "" ${quoteForCmd(executablePath)}`,
      `del ${quoteForCmd(installer)} >nul 2>&1`,
      '(goto) 2>nul & del "%~f0"',
    ];
    fs.writeFileSync(script, `${lines.join('\r\n')}\r\n`, 'ascii');
    const child = spawnProcess('cmd.exe', ['/c', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref?.();
  }

  function cancelDownload() {
    downloadController?.abort();
  }

  /** Dismiss the card until the next check finds something. */
  function dismiss() {
    if (state.phase === 'available' || state.phase === 'error') {
      setState({ phase: 'idle' });
    }
    return state;
  }

  function start() {
    if (startTimer || interval) return;
    startTimer = timers.setTimeout(() => {
      startTimer = null;
      void check();
    }, FIRST_CHECK_DELAY_MS);
    interval = timers.setInterval(() => void check(), CHECK_INTERVAL_MS);
    interval.unref?.();
  }

  function stop() {
    if (startTimer) timers.clearTimeout(startTimer);
    if (interval) timers.clearInterval(interval);
    startTimer = null;
    interval = null;
    cancelDownload();
  }

  return Object.freeze({
    cancelDownload,
    check,
    dismiss,
    getState: () => state,
    install,
    onState(listener) {
      events.on('state', listener);
      return () => events.off('state', listener);
    },
    start,
    stop,
  });
}

module.exports = {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  INSTALLER_NAME,
  UpdateFailure,
  createUpdater,
};
