'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  compareVersions,
  isNewerVersion,
  sha256Matches,
  signManifest,
  verifyManifest,
} = require('../src/shared/update-verify');
const { UPDATE_PUBLIC_KEY_PEM } = require('../src/shared/update-key');

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

const FIELDS = Object.freeze({
  version: '0.2.0',
  notes: 'Faster startup and a fix for the microphone list.',
  url: 'https://github.com/example/flowstate/releases/download/v0.2.0/Flowstate-Setup.exe',
  sha256: 'a'.repeat(64),
});

test('version comparison orders numbers numerically, not as text', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0);
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1, '10 is bigger than 9');
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
});

test('a release is newer than its own pre-release, and pre-releases order among themselves', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.1'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
});

test('anything that is not a version compares as null and is never "newer"', () => {
  for (const bad of ['', 'v1.0.0', '1.0', '1.0.0.0', 'latest', null, undefined, 7]) {
    assert.equal(compareVersions(bad, '0.1.0'), null);
    assert.equal(isNewerVersion(bad, '0.1.0'), false);
  }
  assert.equal(isNewerVersion('0.1.0', '0.1.0'), false, 'the same version is not an update');
  assert.equal(isNewerVersion('0.0.9', '0.1.0'), false, 'a downgrade is not an update');
  assert.equal(isNewerVersion('0.1.1', '0.1.0'), true);
});

test('a correctly signed manifest verifies and returns only the signed fields', () => {
  const { publicPem, privatePem } = keyPair();
  const signed = signManifest(FIELDS, privatePem);

  const verdict = verifyManifest({ ...signed, extra: 'ignored' }, publicPem);

  assert.equal(verdict.ok, true);
  assert.deepEqual({ ...verdict.manifest }, FIELDS);
  assert.equal('extra' in verdict.manifest, false);
});

test('changing any signed field after signing fails verification', () => {
  const { publicPem, privatePem } = keyPair();
  const signed = signManifest(FIELDS, privatePem);
  const tampered = {
    version: '9.9.9',
    notes: 'Totally safe update.',
    url: 'https://evil.example/Flowstate-Setup.exe',
    sha256: 'b'.repeat(64),
  };

  for (const [field, value] of Object.entries(tampered)) {
    const verdict = verifyManifest({ ...signed, [field]: value }, publicPem);
    assert.deepEqual(verdict, { ok: false, reason: 'bad-signature' }, `${field} was not protected`);
  }
});

test('a signature from a different key is rejected', () => {
  const attacker = keyPair();
  const real = keyPair();
  const forged = signManifest(FIELDS, attacker.privatePem);

  assert.deepEqual(verifyManifest(forged, real.publicPem), { ok: false, reason: 'bad-signature' });
});

test('the key embedded in the app does not accept a signature from some other key', () => {
  const other = keyPair();
  const forged = signManifest(FIELDS, other.privatePem);

  assert.equal(verifyManifest(forged, UPDATE_PUBLIC_KEY_PEM).ok, false);
});

test('garbage and truncated signatures fail cleanly instead of throwing', () => {
  const { publicPem, privatePem } = keyPair();
  const signed = signManifest(FIELDS, privatePem);

  for (const signature of ['', 'not base64 !!', 'AAAA', signed.signature.slice(0, 20), `${signed.signature}AAAA`]) {
    assert.deepEqual(
      verifyManifest({ ...signed, signature }, publicPem),
      { ok: false, reason: 'bad-signature' }
    );
  }
});

test('malformed manifests are refused before any signature work', () => {
  const { publicPem, privatePem } = keyPair();
  const signed = signManifest(FIELDS, privatePem);

  for (const bad of [null, undefined, 'text', 42, [], {}]) {
    assert.deepEqual(verifyManifest(bad, publicPem), { ok: false, reason: 'malformed' });
  }
  for (const field of ['version', 'notes', 'url', 'sha256', 'signature']) {
    const { [field]: _dropped, ...rest } = signed;
    assert.equal(verifyManifest(rest, publicPem).reason, 'malformed', `${field} is required`);
  }
  assert.equal(verifyManifest({ ...signed, version: 'next' }, publicPem).reason, 'malformed');
  assert.equal(verifyManifest({ ...signed, sha256: 'xyz' }, publicPem).reason, 'malformed');
  assert.equal(verifyManifest({ ...signed, sha256: 'A'.repeat(64) }, publicPem).reason, 'malformed');
});

test('only https download links are accepted, even with a valid signature', () => {
  const { publicPem, privatePem } = keyPair();
  for (const url of ['http://example.com/Flowstate-Setup.exe', 'file:///C:/evil.exe', 'ftp://example.com/a.exe']) {
    const signed = signManifest({ ...FIELDS, url }, privatePem);
    assert.equal(verifyManifest(signed, publicPem).reason, 'insecure-url', url);
  }
  const garbage = signManifest({ ...FIELDS, url: 'not a url' }, privatePem);
  assert.equal(verifyManifest(garbage, publicPem).reason, 'malformed');
});

test('the checksum comparison accepts only an exact, well-formed match', () => {
  const digest = crypto.createHash('sha256').update('installer').digest('hex');
  const other = crypto.createHash('sha256').update('tampered').digest('hex');

  assert.equal(sha256Matches(digest, digest), true);
  assert.equal(sha256Matches(digest, other), false);
  assert.equal(sha256Matches(digest, digest.toUpperCase()), false);
  assert.equal(sha256Matches(digest, digest.slice(1)), false);
  assert.equal(sha256Matches('', ''), false);
});
