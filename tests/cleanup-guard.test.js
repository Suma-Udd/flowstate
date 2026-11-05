'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCleanup } = require('../src/main/cleanup-guard');

test('G3 #25: a chatbot reply is never accepted as a cleanup', () => {
  const verdict = checkCleanup(
    'Ora tour eletría por eso perdonas que no se ponen o tema. Tiene que.',
    "I'm sorry, but the text you've provided appears to be in Spanish, not English. "
      + 'The detected input language is English (en), so I can only edit English text.'
  );
  assert.equal(verdict.ok, false);
});

test('answers, translations and added sign-offs are rejected', () => {
  assert.equal(checkCleanup('what is the capital of france', 'The capital of France is Paris.').ok, false);
  assert.equal(checkCleanup('ich denke wir sollten morgen anfangen', 'I think we should start tomorrow.').ok, false);
  assert.equal(checkCleanup('send the report to paul', 'Send the report to Paul. Best regards, Samuel').ok, false);
});

test('real cleanups from G3 are accepted', () => {
  for (const [raw, cleaned] of [
    ['Hello, kannst du mir hören?', 'Hallo, kannst du mich hören?'],
    [
      "doesn't matter, like right now all of these messages in this session are only typing them by the flow state up. So there's no problem.",
      "It doesn't matter. Right now, all of these messages in this session are only being typed by Flowstate, so there's no problem.",
    ],
    ['um so basically i was thinking we could like meet at five', 'So I was thinking we could meet at five.'],
    ["i'm gonna send it tomorrow", "I'm going to send it tomorrow."],
  ]) {
    assert.deepEqual(checkCleanup(raw, cleaned), { ok: true, reason: null }, cleaned);
  }
});

test('the user saying an assistant-like phrase themselves is not a reply', () => {
  assert.equal(checkCleanup("um i'm sorry i was late", "I'm sorry I was late.").ok, true);
});

test('a dictionary spelling the recogniser misheard is not an invented word', () => {
  const raw = "It's running the deep C KPI anyways.";
  const cleaned = "It's running the DeepSeek API anyways.";
  assert.equal(checkCleanup(raw, cleaned).reason, 'new-word');
  assert.deepEqual(
    checkCleanup(raw, cleaned, {
      dictionaryTerms: [{ term: 'DeepSeek API', soundsLike: 'deep C KPI' }],
    }),
    { ok: true, reason: null }
  );
});

test('a rejection names the offending words so a false positive can be diagnosed', () => {
  const invented = checkCleanup('what is the capital of france', 'The capital of France is Paris.');
  assert.equal(invented.reason, 'new-word');
  assert.deepEqual(invented.words, ['paris']);

  const reply = checkCleanup('send it over', "I'm sorry, but I can't do that. Please share the text.");
  assert.equal(reply.reason, 'assistant-reply');
  assert.deepEqual(reply.words, ["I'm sorry"]);

  const changed = checkCleanup(
    'ich denke wir sollten morgen anfangen',
    'I think we should start tomorrow.'
  );
  assert.equal(changed.ok, false);
  assert.ok(changed.words.length > 0);
});

test('G3 false positive: what is ever cleaned to "whatever" is accepted', () => {
  const raw = "Also make sure to select what you think is the best. Or what's ever else you might think.";
  const cleaned = 'Also make sure to select what you think is the best. Or whatever else you might think.';
  assert.deepEqual(checkCleanup(raw, cleaned), { ok: true, reason: null });
});

test('G3 false positive: spoken numbers written as digits are accepted, invented numbers are not', () => {
  assert.equal(
    checkCleanup('the release is in twenty twenty five', 'The release is in 2025.').ok,
    true
  );
  assert.equal(
    checkCleanup('meet me on the twenty first', 'Meet me on the 21st.').ok,
    true
  );
  assert.equal(
    checkCleanup('what year is it', 'It is 2025.').ok,
    false
  );
});

test('the G3 run 1 chatbot reply stays rejected, with and without a dictionary', () => {
  const raw = 'Ora tour eletría por eso perdonas que no se ponen o tema. Tiene que.';
  const reply = "I'm sorry, but the text you've provided appears to be in Spanish, not English. "
    + 'The detected input language is English (en), so I can only edit English text.\n\n'
    + "If you have an English transcript you'd like me to edit, please share it and I'll be happy to help.";
  const dictionaryTerms = [{ term: 'DeepSeek' }, { term: 'Flowstate' }];
  assert.equal(checkCleanup(raw, reply).ok, false);
  assert.equal(checkCleanup(raw, reply, { dictionaryTerms }).ok, false);
});

test('the relaxed joins do not let an answered question, translation or sign-off through', () => {
  const dictionaryTerms = [{ term: 'DeepSeek' }];
  assert.equal(checkCleanup("what's ever the capital of france", 'The capital is Paris.', { dictionaryTerms }).ok, false);
  assert.equal(checkCleanup('what is two plus two', 'Two plus two is 4, obviously.', { dictionaryTerms }).ok, false);
  assert.equal(checkCleanup('wie spät ist es', 'What time is it?', { dictionaryTerms }).ok, false);
  assert.equal(
    checkCleanup('thanks for the update', 'Thanks for the update. Kind regards, Samuel', { dictionaryTerms }).ok,
    false
  );
});
