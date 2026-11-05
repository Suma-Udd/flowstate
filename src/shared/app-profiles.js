'use strict';

const { normaliseExecutable } = require('./app-quirks');

function profile(id, label, rules) {
  return Object.freeze({
    id,
    label,
    rules: Object.freeze(rules.slice()),
  });
}

const DEFAULT_APP_PROFILE = profile('default', 'plain text', [
  'Use clear, natural prose.',
  'Fix grammar and punctuation without changing the meaning or structure.',
  'Preserve paragraph breaks and list structure when the speaker dictated them.',
]);

const APP_PROFILES = Object.freeze({
  'code.exe': profile('code-editor', 'code editor', [
    'Preserve code, identifiers, casing, symbols, punctuation, and line breaks.',
    'Do not correct or add punctuation inside code.',
    'Only clean obvious dictated prose surrounding code.',
  ]),
  'windowsterminal.exe': profile('terminal', 'terminal', [
    'Return a bare command only.',
    'Never add Markdown, code fences, commentary, a shell prompt, or a trailing period.',
    'Preserve flags, slashes, quotes, pipes, redirects, environment variables, and casing.',
  ]),
  'discord.exe': profile('discord', 'Discord', [
    'Use casual conversational formatting and light, natural punctuation.',
    'Do not make the message formal.',
    'Never add a greeting, signoff, emoji, or reaction unless it was dictated.',
  ]),
  'chrome.exe': profile('browser', 'browser', [
    'Use neutral plain text suitable for a browser text field.',
    'Preserve URLs, search queries, form values, and paragraph breaks.',
    'Do not add Markdown or a signoff.',
  ]),
  'notepad.exe': profile('notepad', 'Notepad', [
    'Use clean plain text with normal grammar and punctuation.',
    'Preserve paragraph breaks, lists, and line breaks.',
    'Do not add Markdown decoration or a signoff.',
  ]),
});

function getAppProfile(executable) {
  return APP_PROFILES[normaliseExecutable(executable)] ?? DEFAULT_APP_PROFILE;
}

module.exports = {
  APP_PROFILES,
  DEFAULT_APP_PROFILE,
  getAppProfile,
};
