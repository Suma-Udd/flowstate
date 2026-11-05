'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAINTAINER_EMAIL, MAINTAINER_NAME, findViolations } = require('../scripts/commit-rules.cjs');

const good = {
  sha: 'a'.repeat(40),
  authorName: MAINTAINER_NAME,
  authorEmail: MAINTAINER_EMAIL,
  committerName: MAINTAINER_NAME,
  committerEmail: MAINTAINER_EMAIL,
  message: 'Fix the thing\n\nA plain explanation.\n',
};

test('a commit by the maintainer with a plain message passes', () => {
  assert.deepEqual(findViolations([good], 'Fixes the thing.'), []);
});

test('a commit by someone else, or by an AI assistant identity, is flagged', () => {
  const bot = { ...good, authorName: 'Claude', authorEmail: 'noreply@anthropic.com' };
  assert.match(findViolations([bot]).join('\n'), /author is Claude/);
  const other = { ...good, committerName: 'Someone', committerEmail: 'someone@example.com' };
  assert.match(findViolations([other]).join('\n'), /committer is Someone/);
});

test('GitHub as committer (a squash or web edit) is fine when the author is right', () => {
  const web = { ...good, committerName: 'GitHub', committerEmail: 'noreply@github.com' };
  assert.deepEqual(findViolations([web]), []);
});

test('Co-Authored-By trailers and "Generated with" lines are flagged in commits and PR text', () => {
  const trailer = { ...good, message: 'Fix\n\nCo-Authored-By: Someone <noreply@anthropic.com>\n' };
  assert.match(findViolations([trailer]).join('\n'), /Co-Authored-By trailer/);

  const generated = { ...good, message: 'Fix\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)\n' };
  assert.match(findViolations([generated]).join('\n'), /Generated with/);

  const body = 'Does stuff.\n\n\u{1F916} Generated with [Claude Code](https://claude.com/claude-code)';
  assert.match(findViolations([good], body).join('\n'), /pull request description/);
  assert.match(findViolations([good], 'Co-authored-by: x <x@example.com>').join('\n'), /pull request description/);
});

test('talking about these tools in a message is not a violation', () => {
  const talk = { ...good, message: 'Add Claude Code to the starter dictionary test\n' };
  assert.deepEqual(findViolations([talk], 'Adds a term that says Generated reports.'), []);
});
