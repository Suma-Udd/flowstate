// Checks the commits in a range against the repository's commit rules.
//
//   node scripts/check-commits.mjs <base> <head>
//
// The pull request description is read from the PR_BODY environment variable
// when it is set (CI does that). Exits 1 and says how to fix it on a problem.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAINTAINER_EMAIL, MAINTAINER_NAME, findViolations } = require('./commit-rules.cjs');

const [base, head] = process.argv.slice(2);
if (!base || !head) {
  console.error('Usage: node scripts/check-commits.mjs <base> <head>');
  process.exit(2);
}

const SEPARATOR = '\u001e';
const FIELD = '\u001f';
let log;
try {
  log = execFileSync(
    'git',
    ['log', '--no-merges', `--format=%H${FIELD}%an${FIELD}%ae${FIELD}%cn${FIELD}%ce${FIELD}%B${SEPARATOR}`, `${base}..${head}`],
    { encoding: 'utf8' }
  );
} catch (error) {
  console.error(`Could not read the commits between ${base} and ${head}: ${error.message}`);
  process.exit(2);
}

const commits = log
  .split(SEPARATOR)
  .map((entry) => entry.replace(/^\n/, ''))
  .filter((entry) => entry.trim().length > 0)
  .map((entry) => {
    const [sha, authorName, authorEmail, committerName, committerEmail, message] = entry.split(FIELD);
    return { sha, authorName, authorEmail, committerName, committerEmail, message };
  });

const problems = findViolations(commits, process.env.PR_BODY ?? '');
console.log(`Checked ${commits.length} commit(s) in ${base.slice(0, 7)}..${head.slice(0, 7)}.`);

if (problems.length > 0) {
  console.error('\nThese break the commit rules:');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(`
How to fix it:
  git config user.name "${MAINTAINER_NAME}"
  git config user.email "${MAINTAINER_EMAIL}"
  git rebase ${base} --exec "git commit --amend --no-edit --reset-author"
  (and delete any Co-Authored-By or "Generated with" lines from the messages and the PR description)
Then force-push the branch.`);
  process.exit(1);
}
console.log('All commits follow the rules.');
