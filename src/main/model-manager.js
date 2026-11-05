'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  MODEL_ARCHIVE,
  MODEL_NAME,
  REQUIRED_MODEL_FILES,
  SILERO_VAD,
} = require('../shared/model-manifest');

const MANIFEST_FILENAME = '.flowstate-model.json';

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

async function pathExists(filePath, fileSystem = fs) {
  try {
    await fileSystem.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function hashFile(filePath, {
  createHashImpl = createHash,
  createReadStreamImpl = createReadStream,
} = {}) {
  return new Promise((resolve, reject) => {
    const hash = createHashImpl('sha256');
    const input = createReadStreamImpl(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function runTar(archivePath, destination, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(
      'tar',
      ['-xf', archivePath, '-C', destination],
      { windowsHide: true, stdio: 'ignore' }
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Model extraction failed: tar exited with code ${code}.`));
      }
    });
  });
}

function createModelManager({
  modelsDirectory,
  fetchImpl = globalThis.fetch,
  fileSystem = fs,
  createReadStreamImpl = createReadStream,
  spawnProcess = spawn,
  modelArchive = MODEL_ARCHIVE,
  vadAsset = SILERO_VAD,
  requiredModelFiles = REQUIRED_MODEL_FILES,
  modelName = MODEL_NAME,
  logger = console,
  createId = randomUUID,
  now = Date.now,
} = {}) {
  if (typeof modelsDirectory !== 'string' || !path.isAbsolute(modelsDirectory)) {
    throw new TypeError('modelsDirectory must be an absolute path.');
  }
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl must be a function.');
  }

  const events = new EventEmitter();
  const modelDirectory = path.join(modelsDirectory, modelName);
  const manifestPath = path.join(modelsDirectory, MANIFEST_FILENAME);
  const archivePath = path.join(modelsDirectory, modelArchive.filename);
  const archivePartialPath = `${archivePath}.partial`;
  const vadPath = path.join(modelsDirectory, vadAsset.filename);
  const vadPartialPath = `${vadPath}.partial`;
  const totalDownloadBytes = modelArchive.bytes + vadAsset.bytes;

  let abortController;
  let activeDownload;
  let lastProgressAt = 0;
  let state = Object.freeze({
    phase: 'checking',
    receivedBytes: 0,
    totalBytes: totalDownloadBytes,
    percent: 0,
    error: null,
    modelsDirectory,
  });

  function publish(patch, force = false) {
    const next = {
      ...state,
      ...patch,
      totalBytes: totalDownloadBytes,
    };
    next.receivedBytes = Math.max(
      0,
      Math.min(totalDownloadBytes, Number(next.receivedBytes) || 0)
    );
    next.percent = Math.round(
      (next.receivedBytes / totalDownloadBytes) * 1_000
    ) / 10;
    state = Object.freeze(next);

    const timestamp = now();
    if (force || timestamp - lastProgressAt >= 100 || next.percent === 100) {
      lastProgressAt = timestamp;
      events.emit('status', state);
    }
    return state;
  }

  async function statOrNull(filePath) {
    try {
      return await fileSystem.stat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function validateModelDirectory(directory = modelDirectory) {
    const problems = [];
    for (const requirement of requiredModelFiles) {
      const details = await statOrNull(path.join(directory, requirement.filename));
      if (!details?.isFile()) {
        problems.push(`${requirement.filename} is missing`);
      } else if (details.size < requirement.minimumBytes) {
        problems.push(
          `${requirement.filename} is ${details.size} bytes; expected at least ` +
          `${requirement.minimumBytes}`
        );
      }
    }
    return problems;
  }

  async function validateVad() {
    const details = await statOrNull(vadPath);
    if (!details?.isFile() || details.size !== vadAsset.bytes) {
      return false;
    }
    return (
      await hashFile(vadPath, { createReadStreamImpl })
    ).toLowerCase() === vadAsset.sha256.toLowerCase();
  }

  async function hasInstallManifest() {
    try {
      const parsed = JSON.parse(await fileSystem.readFile(manifestPath, 'utf8'));
      return (
        parsed.version === 1
        && parsed.modelName === modelName
        && parsed.modelArchiveSha256 === modelArchive.sha256
        && parsed.vadSha256 === vadAsset.sha256
      );
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return false;
      throw error;
    }
  }

  async function isInstalled() {
    const [problems, validVad, validManifest] = await Promise.all([
      validateModelDirectory(),
      validateVad(),
      hasInstallManifest(),
    ]);
    return problems.length === 0 && validVad && validManifest;
  }

  async function cleanupOrphans() {
    const entries = await fileSystem.readdir(modelsDirectory, {
      withFileTypes: true,
    });
    await Promise.all(entries.map(async (entry) => {
      const isStagingDirectory =
        entry.isDirectory() && entry.name.startsWith('.install-');
      const isTemporaryManifest =
        entry.isFile()
        && entry.name.startsWith(`${MANIFEST_FILENAME}.`)
        && entry.name.endsWith('.tmp');
      if (isStagingDirectory || isTemporaryManifest) {
        await fileSystem.rm(path.join(modelsDirectory, entry.name), {
          recursive: isStagingDirectory,
          force: true,
        });
      }
    }));
  }

  async function inspect() {
    await fileSystem.mkdir(modelsDirectory, { recursive: true });
    await cleanupOrphans();
    if (await isInstalled()) {
      return publish({
        phase: 'ready',
        receivedBytes: totalDownloadBytes,
        error: null,
      }, true);
    }

    const existing = await Promise.all([
      statOrNull(modelDirectory),
      statOrNull(vadPath),
      statOrNull(manifestPath),
    ]);
    const phase = existing.some(Boolean) ? 'corrupt' : 'missing';
    return publish({
      phase,
      receivedBytes: 0,
      error:
        phase === 'corrupt'
          ? 'The local speech model is incomplete or failed its integrity check.'
          : null,
    }, true);
  }

  async function verifiedFile(filePath, asset) {
    const details = await statOrNull(filePath);
    if (!details?.isFile() || details.size !== asset.bytes) return false;
    const digest = await hashFile(filePath, { createReadStreamImpl });
    return digest.toLowerCase() === asset.sha256.toLowerCase();
  }

  async function downloadAsset({
    asset,
    destination,
    partial,
    completedBefore,
    label,
  }) {
    if (await verifiedFile(destination, asset)) {
      publish({ receivedBytes: completedBefore + asset.bytes }, true);
      return;
    }

    const partialDetails = await statOrNull(partial);
    let offset = partialDetails?.isFile() ? partialDetails.size : 0;
    if (offset > asset.bytes) {
      await fileSystem.rm(partial, { force: true });
      offset = 0;
    }

    if (offset < asset.bytes) {
      const headers = offset > 0 ? { Range: `bytes=${offset}-` } : undefined;
      const response = await fetchImpl(asset.url, {
        headers,
        redirect: 'follow',
        signal: abortController.signal,
      });
      if (!response.ok || !response.body) {
        throw new Error(
          `${label} download failed: HTTP ${response.status} ${response.statusText}.`
        );
      }

      let append = offset > 0 && response.status === 206;
      if (append) {
        const contentRange = response.headers?.get?.('content-range') ?? '';
        if (!contentRange.startsWith(`bytes ${offset}-`)) {
          throw new Error(`${label} server returned an invalid resume range.`);
        }
      } else if (offset > 0 && response.status === 200) {
        offset = 0;
        append = false;
      } else if (offset > 0) {
        throw new Error(
          `${label} download could not resume: HTTP ${response.status}.`
        );
      }

      const output = await fileSystem.open(partial, append ? 'a' : 'w');
      let received = offset;
      publish({ phase: 'downloading', receivedBytes: completedBefore + received }, true);
      try {
        for await (const chunk of response.body) {
          if (abortController.signal.aborted) {
            const abortError = new Error('Download cancelled.');
            abortError.name = 'AbortError';
            throw abortError;
          }
          const buffer = Buffer.from(chunk);
          await output.write(buffer);
          received += buffer.length;
          if (received > asset.bytes) {
            throw new Error(`${label} download exceeded its expected size.`);
          }
          publish({
            phase: 'downloading',
            receivedBytes: completedBefore + received,
          });
        }
      } finally {
        await output.close();
      }

      if (received !== asset.bytes) {
        throw new Error(
          `${label} download stopped at ${received} of ${asset.bytes} bytes; ` +
          'retry to resume.'
        );
      }
    }

    publish({
      phase: 'verifying',
      receivedBytes: completedBefore + asset.bytes,
    }, true);
    const digest = await hashFile(partial, { createReadStreamImpl });
    if (digest.toLowerCase() !== asset.sha256.toLowerCase()) {
      await fileSystem.rm(partial, { force: true });
      throw new Error(
        `${label} failed SHA-256 verification. The corrupt download was removed.`
      );
    }

    await fileSystem.rm(destination, { force: true });
    await fileSystem.rename(partial, destination);
  }

  async function writeInstallManifest() {
    const temporary = `${manifestPath}.${createId()}.tmp`;
    const contents = JSON.stringify({
      version: 1,
      modelName,
      modelArchiveSha256: modelArchive.sha256,
      vadSha256: vadAsset.sha256,
      installedAt: new Date(now()).toISOString(),
    }, null, 2);
    await fileSystem.writeFile(temporary, `${contents}\n`, 'utf8');
    await fileSystem.rm(manifestPath, { force: true });
    await fileSystem.rename(temporary, manifestPath);
  }

  async function installModel() {
    const stagingDirectory = path.join(
      modelsDirectory,
      `.install-${createId()}`
    );
    await fileSystem.mkdir(stagingDirectory, { recursive: true });
    try {
      await runTar(archivePath, stagingDirectory, spawnProcess);
      const stagedModel = path.join(stagingDirectory, modelName);
      const problems = await validateModelDirectory(stagedModel);
      if (problems.length > 0) {
        throw new Error(`Extracted speech model is incomplete: ${problems.join('; ')}.`);
      }

      await fileSystem.rm(modelDirectory, { recursive: true, force: true });
      await fileSystem.rename(stagedModel, modelDirectory);
      await writeInstallManifest();
      await fileSystem.rm(archivePath, { force: true });
    } finally {
      await fileSystem.rm(stagingDirectory, { recursive: true, force: true });
    }
  }

  async function performDownload() {
    await fileSystem.mkdir(modelsDirectory, { recursive: true });
    abortController = new AbortController();

    try {
      publish({ phase: 'downloading', error: null, receivedBytes: 0 }, true);
      const modelReady =
        (await validateModelDirectory()).length === 0
        && await hasInstallManifest();
      if (!modelReady) {
        await downloadAsset({
          asset: modelArchive,
          destination: archivePath,
          partial: archivePartialPath,
          completedBefore: 0,
          label: 'Speech model',
        });
      } else {
        publish({ receivedBytes: modelArchive.bytes }, true);
      }

      await downloadAsset({
        asset: vadAsset,
        destination: vadPath,
        partial: vadPartialPath,
        completedBefore: modelArchive.bytes,
        label: 'Voice activity model',
      });

      if (!modelReady) {
        publish({
          phase: 'installing',
          receivedBytes: totalDownloadBytes,
        }, true);
        await installModel();
      } else {
        await writeInstallManifest();
      }

      if (!(await isInstalled())) {
        throw new Error(
          'The downloaded speech model did not pass its final integrity check.'
        );
      }
      logger.log(`Flowstate speech model ready in ${modelsDirectory}.`);
      return publish({
        phase: 'ready',
        receivedBytes: totalDownloadBytes,
        error: null,
      }, true);
    } catch (error) {
      if (isAbortError(error)) {
        return publish({
          phase: 'cancelled',
          error: null,
        }, true);
      }
      const message = messageFrom(error);
      logger.error(`Flowstate model provisioning failed: ${message}`);
      publish({ phase: 'error', error: message }, true);
      throw error;
    } finally {
      abortController = undefined;
    }
  }

  function download() {
    if (state.phase === 'ready') return Promise.resolve(state);
    if (activeDownload) return activeDownload;
    activeDownload = performDownload().finally(() => {
      activeDownload = undefined;
    });
    return activeDownload;
  }

  function cancel() {
    if (!abortController || state.phase !== 'downloading') return false;
    abortController.abort();
    return true;
  }

  return {
    cancel,
    download,
    getModelDirectory: () => modelDirectory,
    getModelsDirectory: () => modelsDirectory,
    getState: () => state,
    inspect,
    onStatus(listener) {
      events.on('status', listener);
      return () => events.off('status', listener);
    },
  };
}

module.exports = {
  MANIFEST_FILENAME,
  createModelManager,
  hashFile,
  pathExists,
  runTar,
};
