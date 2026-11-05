'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAsrWorkerManager } = require('../src/main/asr-worker');
const { createAsrEngine } = require('../src/worker/asr');
const { MODEL_NAME } = require('../src/shared/model-manifest');
const { createWorkerRuntime, hotwordsEnabledFromArgs } = require('../src/worker');

const TAB = String.fromCharCode(9);
const NL = String.fromCharCode(10);
const SPEECH = new Int16Array(16_000).fill(300);

async function makeModelsDirectory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowstate-asr-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, MODEL_NAME), { recursive: true });
  await fs.writeFile(
    path.join(root, MODEL_NAME, 'tokens.txt'),
    ['<unk> 0', '▁a 1', ''].join(NL),
    'utf8',
  );
  return root;
}

// The VAD stub reports one speech segment, so every capture reaches decode.
function fakeSherpa({ failBpe = false, failStreamHotwords = false } = {}) {
  const created = { configs: [], streams: [] };
  class OfflineRecognizer {
    constructor(config) {
      if (failBpe && config.modelConfig.modelingUnit === 'bpe') {
        throw new Error('bpe boom');
      }
      created.configs.push(config);
    }

    createStream(hotwords) {
      if (hotwords !== undefined && failStreamHotwords) throw new Error('bad hotwords');
      created.streams.push(hotwords);
      return { acceptWaveform() {} };
    }

    decode() {}

    getResult() {
      return { text: ' hello ', lang: '' };
    }
  }
  class Vad {
    constructor() {
      this.queue = [];
    }

    reset() {}

    clear() {
      this.queue = [];
    }

    acceptWaveform() {}

    flush() {
      this.queue = [{ start: 0, samples: new Float32Array(16_000) }];
    }

    isEmpty() {
      return this.queue.length === 0;
    }

    front() {
      return this.queue[0];
    }

    pop() {
      this.queue.shift();
    }
  }
  return { sherpaOnnx: { OfflineRecognizer, Vad }, created };
}

test('the engine builds a beam + bpe recogniser and sends hotwords per stream', async (t) => {
  const modelsDirectory = await makeModelsDirectory(t);
  const { sherpaOnnx, created } = fakeSherpa();
  const engine = await createAsrEngine({ modelsDirectory, sherpaOnnx });

  const [config] = created.configs;
  assert.equal(config.decodingMethod, 'modified_beam_search');
  assert.equal(config.modelConfig.modelingUnit, 'bpe');
  assert.equal(config.hotwordsScore, 1);
  assert.equal(
    await fs.readFile(config.modelConfig.bpeVocab, 'utf8'),
    `<unk>${TAB}0${NL}▁a${TAB}-1${NL}`,
  );

  const result = await engine.transcribe({ pcm: SPEECH, hotwords: 'DeepSeek/Visual Studio' });
  assert.equal(result.text, 'hello');
  assert.deepEqual(created.streams, ['DeepSeek/Visual Studio']);

  await engine.transcribe({ pcm: SPEECH });
  assert.equal(created.streams.at(-1), undefined, 'no hotwords: a plain stream');
});

test('the engine decodes greedily with no bpe vocabulary when the switch is off', async (t) => {
  const modelsDirectory = await makeModelsDirectory(t);
  const { sherpaOnnx, created } = fakeSherpa();
  const engine = await createAsrEngine({ modelsDirectory, sherpaOnnx, hotwords: false });

  assert.equal(created.configs[0].decodingMethod, undefined);
  assert.equal(created.configs[0].modelConfig.modelingUnit, undefined);
  await engine.transcribe({ pcm: SPEECH, hotwords: 'DeepSeek' });
  assert.deepEqual(created.streams, [undefined]);
  await assert.rejects(fs.stat(path.join(modelsDirectory, 'hotwords')));
});

test('the engine falls back to greedy decoding when the hotword recogniser cannot load', async (t) => {
  const modelsDirectory = await makeModelsDirectory(t);
  const { sherpaOnnx, created } = fakeSherpa({ failBpe: true });
  const warnings = [];
  const engine = await createAsrEngine({
    modelsDirectory, sherpaOnnx, onWarning: (message) => warnings.push(message),
  });

  assert.equal(created.configs.length, 1);
  assert.equal(created.configs[0].decodingMethod, undefined);
  assert.match(warnings[0], /Hotwords unavailable.*bpe boom/u);
  await engine.transcribe({ pcm: SPEECH, hotwords: 'DeepSeek' });
  assert.deepEqual(created.streams, [undefined], 'hotwords are not sent to a greedy recogniser');
});

test('a stream that rejects the hotwords still decodes, without them', async (t) => {
  const modelsDirectory = await makeModelsDirectory(t);
  const { sherpaOnnx, created } = fakeSherpa({ failStreamHotwords: true });
  const warnings = [];
  const engine = await createAsrEngine({
    modelsDirectory, sherpaOnnx, onWarning: (message) => warnings.push(message),
  });

  const result = await engine.transcribe({ pcm: SPEECH, hotwords: 'x' });
  assert.equal(result.text, 'hello');
  assert.deepEqual(created.streams, [undefined]);
  assert.match(warnings[0], /rejected.*bad hotwords/u);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
  }

  kill() {}

  postMessage(message) {
    this.messages.push(message);
  }
}

test('the manager attaches the current hotwords to every transcribe request', () => {
  const child = new FakeChild();
  let terms = 'DeepSeek';
  const manager = createAsrWorkerManager({
    fork: () => child,
    workerPath: path.join('src', 'worker', 'index.js'),
    getHotwords: () => terms,
  });
  manager.start();
  child.emit('message', { type: 'ready' });

  manager.transcribe({ id: 'one', pcm: new Int16Array([1]) });
  terms = 'DeepSeek/Kubernetes';
  manager.transcribe({ id: 'two', pcm: new Int16Array([1]) });

  assert.deepEqual(child.messages.map((m) => m.hotwords), ['DeepSeek', 'DeepSeek/Kubernetes']);
});

test('a throwing or non-string hotwords source never blocks a dictation', () => {
  for (const getHotwords of [() => { throw new Error('dictionary gone'); }, () => 42, undefined]) {
    const child = new FakeChild();
    const manager = createAsrWorkerManager({
      fork: () => child,
      workerPath: path.join('src', 'worker', 'index.js'),
      ...(getHotwords ? { getHotwords } : {}),
    });
    manager.start();
    child.emit('message', { type: 'ready' });
    manager.transcribe({ id: 'a', pcm: new Int16Array([1]) });
    assert.equal(child.messages[0].hotwords, '');
  }
});

test('the worker runtime hands request hotwords to the engine', async () => {
  const port = new EventEmitter();
  port.messages = [];
  port.postMessage = (message) => port.messages.push(message);
  const seen = [];
  const runtime = createWorkerRuntime({
    port,
    loadEngine: async () => ({
      async transcribe(request) {
        seen.push(request.hotwords);
        return { text: 'x', lang: 'en', vadMs: 1, inferMs: 1, totalMs: 2 };
      },
    }),
    onFatal() {},
  });
  await runtime.loaded;
  port.emit('message', {
    data: { type: 'transcribe', id: 'r1', pcm: new Int16Array([1]), hotwords: 'DeepSeek' },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ['DeepSeek']);
});

test('the worker argument turns hotwords off only for an explicit 0', () => {
  assert.equal(hotwordsEnabledFromArgs(['e', 'w', '/m', '0']), false);
  assert.equal(hotwordsEnabledFromArgs(['e', 'w', '/m', '1']), true);
  assert.equal(hotwordsEnabledFromArgs(['e', 'w', '/m']), true);
});

test('main passes the dictionary, and the config switch, to the worker manager', async () => {
  const main = await fs.readFile(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8');
  assert.match(main, /getHotwords:/u);
  assert.match(main, /buildStreamHotwords\(dictionaryStore/u);
  assert.match(main, /asr\.hotwords === false/u);
});
