'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const html = read('src', 'renderer', 'model-download', 'index.html');
const css = read('src', 'renderer', 'model-download', 'model-download.css');
const renderer = read('src', 'renderer', 'model-download', 'model-download.js');
const preload = read('src', 'main', 'model-preload.js');
const main = read('src', 'main', 'model-window.js');
const appMain = read('src', 'main', 'main.js');
const { CHANNELS: appChannels } = require('../src/main/ipc');
const { CHANNELS: setupChannels } = require('../src/main/model-window');

test('first-run copy explains the local model, storage, progress, and cancel', () => {
  assert.match(html, /Parakeet/);
  assert.match(html, /transcribes entirely on this\s+computer/i);
  assert.match(html, /Local AppData/);
  assert.match(html, /<progress\b/);
  assert.match(html, /data-cancel/);
  assert.match(renderer, /Resume download/);
  assert.match(renderer, /SHA-256 integrity digest/);
});

test('the first-run renderer stays inside the Flowstate token system', () => {
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b/i);
  assert.doesNotMatch(css, /\b(?:box-)?shadow\s*:/i);
  assert.doesNotMatch(css, /\b\d+(?:\.\d+)?(?:px|rem|ms|s)\b/i);
  assert.doesNotMatch(css, /\b(?:transition|animation)(?:-[\w-]+)?\s*:/i);
  assert.match(html, /styles\/tokens\.css/);
  assert.match(html, /styles\/base\.css/);
});

test('the first-run bridge exposes only model status, download, and cancel', () => {
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.match(preload, /exposeInMainWorld\('flowModel'/);
  assert.doesNotMatch(preload, /\bipcRenderer\.send\(/);
  for (const channel of [
    'flowstate:model-setup-cancel',
    'flowstate:model-setup-download',
    'flowstate:model-setup-status',
    'flowstate:model-setup-status-changed',
  ]) {
    assert.match(main, new RegExp(channel));
    assert.match(preload, new RegExp(channel));
  }
});

test('the setup window cannot double-register an app IPC channel', () => {
  const appChannelNames = new Set(Object.values(appChannels));
  const collisions = Object.values(setupChannels).filter((channel) =>
    appChannelNames.has(channel)
  );
  assert.deepEqual(collisions, []);
});

test('production startup keeps the model in Local AppData and gates the worker', () => {
  assert.match(appMain, /process\.env\.LOCALAPPDATA/);
  assert.match(
    appMain,
    /path\.join\(localAppData,\s*'flowstate',\s*'models'\)/
  );
  assert.match(appMain, /modelManager\.getState\(\)\.phase !== 'ready'/);
  assert.match(appMain, /workerArgs:\s*\[modelsDirectory,/);
});
