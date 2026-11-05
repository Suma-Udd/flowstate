'use strict';

const fs = require('node:fs');
const path = require('node:path');

/*
 * `Flowstate.exe --self-test=<result file>` loads every native module the app
 * depends on, from inside the packaged app, and writes a JSON report. The
 * installer smoke test in CI runs it on a freshly installed copy, so a missing
 * DLL, a module left inside the archive, or a binary built for the wrong
 * Electron fails the build instead of failing on someone's PC.
 *
 * It touches no settings, no history and no microphone.
 */

const SELF_TEST_FLAG = '--self-test=';

function selfTestTarget(argv) {
  const flag = argv.find((argument) => argument.startsWith(SELF_TEST_FLAG));
  return flag ? flag.slice(SELF_TEST_FLAG.length) : null;
}

function checkSqlite() {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  try {
    db.exec('CREATE VIRTUAL TABLE probe USING fts5(text)');
    db.prepare('INSERT INTO probe (text) VALUES (?)').run('hello flowstate');
    const row = db.prepare('SELECT count(*) AS n FROM probe WHERE probe MATCH ?').get('flowstate');
    if (row.n !== 1) throw new Error('full-text search returned the wrong answer');
    return 'ok (FTS5)';
  } finally {
    db.close();
  }
}

function checkHook() {
  const { uIOhook } = require('uiohook-napi');
  if (!uIOhook || typeof uIOhook.start !== 'function') {
    throw new Error('uiohook-napi loaded without its API');
  }
  return 'ok';
}

function checkKoffi() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const getForegroundWindow = user32.func('void *GetForegroundWindow()');
  getForegroundWindow();
  return 'ok';
}

function checkSherpa({ utilityProcess, timers = { setTimeout, clearTimeout } }) {
  // sherpa-onnx runs in a utility process in the real app, so it is loaded in
  // one here: the same loader, the same DLL search path.
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, '..', 'worker', 'self-check.js'));
    const timer = timers.setTimeout(() => {
      child.kill();
      reject(new Error('sherpa-onnx did not load within 20 seconds'));
    }, 20_000);
    child.once('message', (message) => {
      timers.clearTimeout(timer);
      child.kill();
      if (message && message.ok) resolve(message.detail);
      else reject(new Error(message?.error ?? 'sherpa-onnx failed to load'));
    });
    child.once('exit', (code) => {
      timers.clearTimeout(timer);
      reject(new Error(`the speech worker exited early (code ${code})`));
    });
  });
}

async function runSelfTest({ argv, utilityProcess, versions, now = () => new Date() }) {
  const target = selfTestTarget(argv);
  if (!target) return null;

  const checks = {
    'better-sqlite3': checkSqlite,
    'uiohook-napi': checkHook,
    koffi: checkKoffi,
    'sherpa-onnx-node': () => checkSherpa({ utilityProcess }),
  };

  const results = {};
  let ok = true;
  for (const [name, check] of Object.entries(checks)) {
    try {
      results[name] = await check();
    } catch (error) {
      ok = false;
      results[name] = `FAILED: ${error.message}`;
    }
  }

  const report = { ok, at: now().toISOString(), versions, results };
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

module.exports = { SELF_TEST_FLAG, runSelfTest, selfTestTarget };
