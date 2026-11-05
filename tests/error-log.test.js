'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createErrorLog, withErrorCapture } = require('../src/main/error-log');

async function tempDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'flowstate-error-log-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('recent() is newest-first and bounded to the configured limit', async (t) => {
  const directory = await tempDirectory(t);
  const errorLog = createErrorLog({ directory, limit: 2 });

  errorLog.record('first');
  errorLog.record('second');
  errorLog.record('third');

  assert.deepEqual(
    errorLog.recent().map((entry) => entry.message),
    ['third', 'second']
  );
  assert.ok(errorLog.recent().every((entry) => typeof entry.at === 'string'));
  assert.ok(errorLog.recent().every(Object.isFrozen));
});

test('record() appends a real line to the log file on disk', async (t) => {
  const directory = await tempDirectory(t);
  const errorLog = createErrorLog({ directory });

  errorLog.record('disk is full');
  errorLog.record('worker crashed');

  const contents = await fs.readFile(errorLog.filePath, 'utf8');
  const lines = contents.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /disk is full$/);
  assert.match(lines[1], /worker crashed$/);
});

test('record() never throws even if the log directory cannot be written', () => {
  const errorLog = createErrorLog({
    directory: 'Z:\\does-not-exist\\flowstate-logs',
    fileSystem: {
      mkdirSync() { throw new Error('permission denied'); },
      appendFileSync() { throw new Error('permission denied'); },
    },
  });

  assert.doesNotThrow(() => errorLog.record('should still be remembered in memory'));
  assert.equal(errorLog.recent()[0].message, 'should still be remembered in memory');
});

test('withErrorCapture records only .error() calls, never .log() or .warn()', async (t) => {
  const directory = await tempDirectory(t);
  const errorLog = createErrorLog({ directory });
  const calls = { log: [], warn: [], error: [] };
  const base = {
    log: (...args) => calls.log.push(args),
    warn: (...args) => calls.warn.push(args),
    error: (...args) => calls.error.push(args),
  };
  const logger = withErrorCapture(base, errorLog);

  logger.log('routine state transition');
  logger.warn('autostart could not be verified');
  logger.error('Dictation failed:', new Error('no speech detected'));

  assert.equal(calls.log.length, 1);
  assert.equal(calls.warn.length, 1);
  assert.equal(calls.error.length, 1);
  assert.equal(errorLog.recent().length, 1);
  assert.match(errorLog.recent()[0].message, /Dictation failed:.*no speech detected/);
});

test('note() goes to the log file and the console but never into the recent errors', async (t) => {
  const directory = await tempDirectory(t);
  const errorLog = createErrorLog({ directory });
  const warned = [];
  const logger = withErrorCapture(
    { log() {}, warn: (...args) => warned.push(args), error() {} },
    errorLog
  );

  logger.note('cleanup rejected (new-word ["paris"])\nsecond line');

  assert.equal(warned.length, 1);
  assert.equal(errorLog.recent().length, 0);
  const contents = await fs.readFile(errorLog.filePath, 'utf8');
  assert.equal(contents.trim().split('\n').length, 1);
  assert.match(contents, /cleanup rejected \(new-word \["paris"\]\) second line/);
});
