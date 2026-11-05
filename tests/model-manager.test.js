'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  MANIFEST_FILENAME,
  createModelManager,
} = require('../src/main/model-manager');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function response(body, {
  status = 200,
  contentRange = null,
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 206 ? 'Partial Content' : 'OK',
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-range' ? contentRange : null;
      },
    },
    body: (async function* stream() {
      for (const chunk of body) yield chunk;
    }()),
  };
}

async function createHarness(t, {
  archiveBytes = Buffer.from('archive-data'),
  vadBytes = Buffer.from('vad-data'),
  fetchImpl,
  now,
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowstate-model-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const modelName = 'test-model';
  const modelArchive = {
    filename: `${modelName}.tar.bz2`,
    url: 'https://example.test/model',
    bytes: archiveBytes.length,
    sha256: sha256(archiveBytes),
  };
  const vadAsset = {
    filename: 'silero_vad.onnx',
    url: 'https://example.test/vad',
    bytes: vadBytes.length,
    sha256: sha256(vadBytes),
  };
  const requests = [];
  const defaultFetch = async (url, options = {}) => {
    requests.push({ url, options });
    const bytes = url === modelArchive.url ? archiveBytes : vadBytes;
    return response([bytes]);
  };
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    queueMicrotask(async () => {
      try {
        const destination = args[args.indexOf('-C') + 1];
        const directory = path.join(destination, modelName);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'model.bin'), 'model');
        child.emit('exit', 0);
      } catch (error) {
        child.emit('error', error);
      }
    });
    return child;
  };
  const logs = [];
  const manager = createModelManager({
    modelsDirectory: root,
    modelName,
    modelArchive,
    vadAsset,
    requiredModelFiles: [{ filename: 'model.bin', minimumBytes: 5 }],
    fetchImpl: fetchImpl ?? defaultFetch,
    spawnProcess,
    now,
    logger: {
      log: (message) => logs.push(['log', message]),
      error: (message) => logs.push(['error', message]),
    },
  });
  return {
    archiveBytes,
    logs,
    manager,
    modelArchive,
    modelName,
    requests,
    root,
    vadAsset,
    vadBytes,
  };
}

test('a partial model download resumes with an HTTP range and installs atomically', async (t) => {
  const h = await createHarness(t);
  const partial = path.join(h.root, `${h.modelArchive.filename}.partial`);
  const prefix = h.archiveBytes.subarray(0, 4);
  await fs.writeFile(partial, prefix);

  const requests = [];
  const manager = createModelManager({
    modelsDirectory: h.root,
    modelName: h.modelName,
    modelArchive: h.modelArchive,
    vadAsset: h.vadAsset,
    requiredModelFiles: [{ filename: 'model.bin', minimumBytes: 5 }],
    fetchImpl: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === h.modelArchive.url) {
        return response(
          [h.archiveBytes.subarray(prefix.length)],
          {
            status: 206,
            contentRange: `bytes ${prefix.length}-${h.archiveBytes.length - 1}/` +
              `${h.archiveBytes.length}`,
          }
        );
      }
      return response([h.vadBytes]);
    },
    spawnProcess: (_command, args) => {
      const child = new EventEmitter();
      queueMicrotask(async () => {
        const destination = args[args.indexOf('-C') + 1];
        const directory = path.join(destination, h.modelName);
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(path.join(directory, 'model.bin'), 'model');
        child.emit('exit', 0);
      });
      return child;
    },
    logger: { log() {}, error() {} },
  });

  await manager.inspect();
  const status = await manager.download();

  assert.equal(status.phase, 'ready');
  assert.equal(requests[0].options.headers.Range, `bytes=${prefix.length}-`);
  assert.equal(
    await fs.readFile(path.join(h.root, h.modelName, 'model.bin'), 'utf8'),
    'model'
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(h.root, MANIFEST_FILENAME), 'utf8'))
      .modelArchiveSha256,
    h.modelArchive.sha256
  );
  await assert.rejects(fs.access(partial), { code: 'ENOENT' });
});

test('a server that ignores Range safely restarts the partial file from zero', async (t) => {
  const h = await createHarness(t);
  const partial = path.join(h.root, `${h.modelArchive.filename}.partial`);
  await fs.writeFile(partial, h.archiveBytes.subarray(0, 3));

  await h.manager.inspect();
  const status = await h.manager.download();

  assert.equal(status.phase, 'ready');
  assert.equal(h.requests[0].options.headers.Range, 'bytes=3-');
});

test('a SHA-256 mismatch fails loudly and removes the corrupt partial file', async (t) => {
  const expected = Buffer.from('expected-data');
  const corrupt = Buffer.from('corrupt--data');
  assert.equal(corrupt.length, expected.length);
  const h = await createHarness(t, {
    archiveBytes: expected,
    fetchImpl: async (url) => (
      url.endsWith('/model') ? response([corrupt]) : response([Buffer.from('vad-data')])
    ),
  });

  await h.manager.inspect();
  await assert.rejects(
    h.manager.download(),
    /failed SHA-256 verification/
  );
  assert.equal(h.manager.getState().phase, 'error');
  assert.match(h.manager.getState().error, /corrupt download was removed/);
  await assert.rejects(
    fs.access(path.join(h.root, `${h.modelArchive.filename}.partial`)),
    { code: 'ENOENT' }
  );
});

test('cancel keeps partial bytes and the next attempt resumes them', async (t) => {
  const archiveBytes = Buffer.from('resume-this-download');
  let requestCount = 0;
  const h = await createHarness(t, {
    archiveBytes,
    now: (() => {
      let value = 0;
      return () => {
        value += 101;
        return value;
      };
    })(),
    fetchImpl: async (url, options = {}) => {
      if (!url.endsWith('/model')) return response([Buffer.from('vad-data')]);
      requestCount += 1;
      const offset = Number(options.headers?.Range?.match(/\d+/)?.[0] ?? 0);
      const remaining = archiveBytes.subarray(offset);
      return response(
        [...remaining].map((byte) => Buffer.from([byte])),
        offset > 0
          ? {
              status: 206,
              contentRange: `bytes ${offset}-${archiveBytes.length - 1}/` +
                `${archiveBytes.length}`,
            }
          : {}
      );
    },
  });

  await h.manager.inspect();
  const unsubscribe = h.manager.onStatus((status) => {
    if (status.phase === 'downloading' && status.receivedBytes > 0) {
      h.manager.cancel();
    }
  });
  const cancelled = await h.manager.download();
  unsubscribe();
  assert.equal(cancelled.phase, 'cancelled');

  const partial = path.join(h.root, `${h.modelArchive.filename}.partial`);
  const partialSize = (await fs.stat(partial)).size;
  assert.ok(partialSize > 0 && partialSize < archiveBytes.length);

  const ready = await h.manager.download();
  assert.equal(ready.phase, 'ready');
  assert.equal(requestCount, 2);
});
