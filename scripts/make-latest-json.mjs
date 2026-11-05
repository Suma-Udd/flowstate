// Writes the signed latest.json that installed copies of Flowstate read.
//
//   FLOWSTATE_UPDATE_KEY="<private key PEM>" node scripts/make-latest-json.mjs \
//     --version 0.2.0 --notes "What changed" --installer release/Flowstate-Setup.exe \
//     --url https://github.com/Suma-Udd/flowstate/releases/download/v0.2.0/Flowstate-Setup.exe \
//     --out release/latest.json
//
// It checks its own work before finishing: the signature it just made must
// verify against the public key that ships inside the app. If the secret and
// the embedded key do not belong together, this fails here, in CI, and not on
// every user's PC later.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { signManifest, verifyManifest } = require('../src/shared/update-verify.js');
const { UPDATE_PUBLIC_KEY_PEM } = require('../src/shared/update-key.js');

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

function fail(message) {
  console.error(`make-latest-json: ${message}`);
  process.exit(1);
}

const version = argument('version');
const notes = argument('notes') ?? process.env.NOTES ?? '';
const installer = argument('installer');
const url = argument('url');
const out = argument('out') ?? 'latest.json';
const privateKey = process.env.FLOWSTATE_UPDATE_KEY;

if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fail('--version must look like 0.2.0');
if (!installer) fail('--installer is required');
if (!/^https:\/\//.test(url ?? '')) fail('--url must be an https link');
if (!privateKey || !privateKey.includes('PRIVATE KEY')) {
  fail('FLOWSTATE_UPDATE_KEY is missing or is not a PEM private key');
}

const sha256 = createHash('sha256').update(readFileSync(installer)).digest('hex');
// Windows line endings from a form field must not change what was signed.
const cleanNotes = notes.replace(/\r\n/g, '\n').trim();
const signed = signManifest({ version, notes: cleanNotes, url, sha256 }, privateKey);

const verdict = verifyManifest(signed, UPDATE_PUBLIC_KEY_PEM);
if (!verdict.ok) {
  fail(
    `the signature does not verify against the public key in src/shared/update-key.js (${verdict.reason}). ` +
    'The FLOWSTATE_UPDATE_KEY secret is not the key that matches the app.'
  );
}

writeFileSync(out, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');
console.log(`${out}: version ${version}, sha256 ${sha256}`);
