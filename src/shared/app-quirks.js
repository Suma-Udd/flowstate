'use strict';

const path = require('node:path');

const DEFAULT_APP_QUIRK = Object.freeze({
  pasteChord: 'ctrl+v',
  restoreDelayMs: 120,
  note: 'Conservative delay measured across the Spike C target set.',
});

function quirk(note) {
  return Object.freeze({
    pasteChord: 'ctrl+v',
    restoreDelayMs: 120,
    note,
  });
}

// Keep every Spike C target explicit. Most currently use the conservative
// default; the entries record the evidence so a later optimisation does not
// accidentally turn a machine-specific lower bound into a production value.
const APP_QUIRKS = Object.freeze({
  'notepad.exe': quirk('Spike C passed with Unicode text at 120 ms.'),
  'chrome.exe': quirk(
    'Chromium address bars and textareas use the conservative default.'
  ),
  'opera.exe': quirk(
    'Opera GX was the accepted Chromium proxy and passed at 120 ms.'
  ),
  'code.exe': quirk(
    'VS Code consumes clipboard data asynchronously; restoring at 0 ms failed.'
  ),
  'discord.exe': quirk(
    'Discord passed by hand at 120 ms; no lower threshold was measured.'
  ),
  'windowsterminal.exe': quirk(
    'Windows Terminal passed at 0 ms, but retains the cross-app safety margin.'
  ),
});

function normaliseExecutable(executable) {
  if (typeof executable !== 'string' || executable.trim().length === 0) {
    return '';
  }
  return path.win32.basename(executable.trim()).toLowerCase();
}

function getAppQuirk(executable) {
  return APP_QUIRKS[normaliseExecutable(executable)] ?? DEFAULT_APP_QUIRK;
}

module.exports = {
  APP_QUIRKS,
  DEFAULT_APP_QUIRK,
  getAppQuirk,
  normaliseExecutable,
};
