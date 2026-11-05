'use strict';

/*
 * The rules every commit and pull request in this repository follows, as
 * code, so they hold no matter who or what made the change:
 *
 *   - authored and committed as the maintainer's GitHub noreply address
 *   - no "Co-Authored-By" trailers
 *   - no "Generated with ..." lines, in commit messages or the PR description
 */

const MAINTAINER_NAME = 'Sumayer';
const MAINTAINER_EMAIL = '192648348+Suma-Udd@users.noreply.github.com';

const FORBIDDEN_LINES = [
  [/^\s*co-authored-by\s*:/im, 'a Co-Authored-By trailer'],
  [/generated (?:with|by)\b.*(?:claude|anthropic|copilot|codex|chatgpt|openai|gemini|cursor)/i, 'a "Generated with" line'],
  [/\u{1F916}\s*generated/iu, 'a "Generated with" line'],
  [/noreply@anthropic\.com/i, 'an AI assistant address'],
];

function describeIdentity(person) {
  return `${person.name} <${person.email}>`;
}

/**
 * commits: [{ sha, authorName, authorEmail, committerName, committerEmail, message }]
 * Returns a list of human-readable problems. Empty means all is well.
 */
function findViolations(commits, pullRequestBody = '') {
  const problems = [];

  for (const commit of commits) {
    const short = String(commit.sha).slice(0, 7);
    const author = { name: commit.authorName, email: commit.authorEmail };
    const committer = { name: commit.committerName, email: commit.committerEmail };

    if (author.email !== MAINTAINER_EMAIL || author.name !== MAINTAINER_NAME) {
      problems.push(`${short}: author is ${describeIdentity(author)}, not ${MAINTAINER_NAME} <${MAINTAINER_EMAIL}>`);
    }
    // GitHub's own "web-flow" committer is what a squash or web edit produces.
    const isWebFlow = committer.email === 'noreply@github.com' && committer.name === 'GitHub';
    if (!isWebFlow && (committer.email !== MAINTAINER_EMAIL || committer.name !== MAINTAINER_NAME)) {
      problems.push(`${short}: committer is ${describeIdentity(committer)}, not ${MAINTAINER_NAME} <${MAINTAINER_EMAIL}>`);
    }
    for (const [pattern, label] of FORBIDDEN_LINES) {
      if (pattern.test(commit.message ?? '')) problems.push(`${short}: the message contains ${label}`);
    }
  }

  for (const [pattern, label] of FORBIDDEN_LINES) {
    if (pattern.test(pullRequestBody ?? '')) problems.push(`pull request description: contains ${label}`);
  }

  return problems;
}

module.exports = { FORBIDDEN_LINES, MAINTAINER_EMAIL, MAINTAINER_NAME, findViolations };
