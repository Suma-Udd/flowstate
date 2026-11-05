// Sets the version everywhere it is written down.
//
//   node scripts/set-version.mjs 0.2.0
//
// package.json and package-lock.json. The release workflow runs this, then
// commits "Release v0.2.0". Run by hand it just edits the two files.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('Usage: node scripts/set-version.mjs <major.minor.patch>, for example 0.2.0');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function rewrite(file, change) {
  const path = join(root, file);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  change(data);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  console.log(`${file} -> ${version}`);
}

rewrite('package.json', (data) => {
  data.version = version;
});
rewrite('package-lock.json', (data) => {
  data.version = version;
  if (data.packages?.['']) data.packages[''].version = version;
});
