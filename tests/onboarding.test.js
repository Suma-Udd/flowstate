'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const FlowLib = require('../src/renderer/lib.js');
const onboarding = require('../src/renderer/views/onboarding.js');
const provider = require('../src/renderer/views/cleanup-provider.js');

const ctx = { lib: FlowLib, views: { 'cleanup-provider': provider } };

const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek', model: 'deepseek-v4-flash', requiresApiKey: true, keyDoc: 'key-deepseek' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', model: '', requiresApiKey: false, keyDoc: null },
];

test('the setup has the six steps in the promised order', () => {
  assert.deepEqual(
    onboarding.STEPS.map((step) => step.key),
    ['welcome', 'model', 'mic', 'hotkey', 'cleanup', 'try']
  );
});

test('the setup frame can be skipped and starts on the welcome button', () => {
  const html = onboarding.html(ctx);
  assert.match(html, /data-action="skip-all"/);
  assert.match(html, /data-action="back"/);
  assert.match(html, /Get started/);
  assert.match(html, /aria-current="step"/);
  assert.ok(!/style="/.test(html), 'a style attribute would be blocked by the CSP');
});

test('the cleanup form shows a saved key without ever holding it', () => {
  const html = provider.formHtml(FlowLib, PROVIDERS, {
    provider: 'deepseek', apiKeyConfigured: true, baseUrl: '', model: '',
  });
  assert.match(html, /Key saved\. Paste a new one to replace it\./);
  assert.match(html, /data-action="remove-key"/);
  assert.match(html, /data-action="get-key"/);
  assert.match(html, /data-action="test"/);
  assert.ok(!/value="[^"]*sk-/.test(html));
  assert.ok(!/data-base-url/.test(html), 'a preset provider has no base URL field');
});

test('a custom provider asks for a base URL and model, and needs no key link', () => {
  const html = provider.formHtml(FlowLib, PROVIDERS, {
    provider: 'custom', apiKeyConfigured: false, baseUrl: 'http://localhost:11434/v1', model: 'llama3.2',
  });
  assert.match(html, /data-base-url/);
  assert.match(html, /value="http:\/\/localhost:11434\/v1"/);
  assert.match(html, /value="llama3\.2"/);
  assert.match(html, /Optional for a local server/);
  assert.ok(!/data-action="get-key"/.test(html));
});

test('every failure the Test button can report has a plain-language message', () => {
  for (const reason of [
    'missing-key', 'not-configured', 'unauthorized', 'not-found', 'rate-limit',
    'timeout', 'network-error', 'malformed-response', 'http-error',
  ]) {
    assert.ok(provider.TEST_MESSAGES[reason], `${reason} has no message`);
  }
  assert.match(provider.testMessage('something-new'), /something-new/);
});

test('the setup and update styles use tokens only', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'styles', 'onboarding.css'), 'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  assert.deepEqual(css.match(/#[0-9A-Fa-f]{3,8}\b/g) || [], [], 'colour literal');
  assert.deepEqual(css.match(/\b(?:rgba?|hsla?|oklch)\s*\(/g) || [], [], 'inline colour');
  assert.deepEqual(css.match(/(?<![\w-])\d*\.?\d+(?:px|ms)\b/g) || [], [], 'hardcoded length');
  assert.ok(!/box-shadow\s*:\s*(?!none)/.test(css), 'box-shadow');
  for (const [, value] of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
    assert.match(value, /^(transform|opacity|color|background-color|border-color)\b/);
  }
});
