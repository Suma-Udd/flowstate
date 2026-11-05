'use strict';

const path = require('node:path');
const { createAsrEngine } = require('./asr');

const parentPort = process.parentPort;

function modelsDirectoryFromArgs(argv = process.argv) {
  const candidate = argv[2];
  return typeof candidate === 'string' && path.isAbsolute(candidate)
    ? candidate
    : undefined;
}

// argv[3] is '0' when the asr.hotwords switch is off; anything else keeps them.
function hotwordsEnabledFromArgs(argv = process.argv) {
  return argv[3] !== '0';
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createWorkerRuntime({
  port,
  loadEngine = () => createAsrEngine({
    modelsDirectory: modelsDirectoryFromArgs(),
    hotwords: hotwordsEnabledFromArgs(),
    onWarning: (message) => console.warn(`Flowstate ASR: ${message}`),
  }),
  onFatal = () => {
    setImmediate(() => process.exit(1));
  },
} = {}) {
  if (
    !port ||
    typeof port.on !== 'function' ||
    typeof port.postMessage !== 'function'
  ) {
    throw new TypeError('A utility-process parent port is required.');
  }

  let engine;
  let ready = false;
  let workQueue = Promise.resolve();

  function postError(request, message) {
    port.postMessage({
      type: 'error',
      id: typeof request?.id === 'string' ? request.id : undefined,
      message,
    });
  }

  async function processRequest(request) {
    try {
      const result = await engine.transcribe({
        pcm: request.pcm,
        hintLang: request.hintLang,
        hotwords: request.hotwords,
      });
      port.postMessage({
        type: 'result',
        id: request.id,
        text: String(result.text ?? ''),
        lang: String(result.lang ?? ''),
        vadMs: Number(result.vadMs),
        inferMs: Number(result.inferMs),
        totalMs: Number(result.totalMs),
      });
    } catch (error) {
      postError(request, errorMessage(error));
    }
  }

  port.on('message', (event) => {
    const request = event?.data;
    if (!request || request.type !== 'transcribe') {
      postError(request, 'Unsupported worker request.');
      return;
    }
    if (typeof request.id !== 'string' || request.id.length === 0) {
      postError(request, 'Transcription requests require a non-empty string id.');
      return;
    }
    if (!(request.pcm instanceof Int16Array)) {
      postError(request, 'pcm must be an Int16Array.');
      return;
    }
    if (!ready) {
      postError(request, 'ASR worker is not ready.');
      return;
    }

    workQueue = workQueue.then(
      () => processRequest(request),
      () => processRequest(request)
    );
  });

  const loaded = Promise.resolve()
    .then(() => loadEngine())
    .then((loadedEngine) => {
      if (!loadedEngine || typeof loadedEngine.transcribe !== 'function') {
        throw new TypeError('ASR engine did not provide transcribe().');
      }
      engine = loadedEngine;
      ready = true;
      port.postMessage({ type: 'ready' });
    })
    .catch((error) => {
      postError(undefined, `ASR model failed to load: ${errorMessage(error)}`);
      onFatal(error);
    });

  return {
    loaded,
    isReady: () => ready,
  };
}

if (parentPort) {
  createWorkerRuntime({ port: parentPort });
} else if (require.main === module) {
  throw new Error('Flowstate worker must be launched with Electron utilityProcess.');
}

module.exports = {
  createWorkerRuntime,
  hotwordsEnabledFromArgs,
  modelsDirectoryFromArgs,
};
