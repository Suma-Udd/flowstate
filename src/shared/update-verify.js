'use strict';

const crypto = require('node:crypto');

/*
 * Everything that decides whether an update may be trusted, with no network
 * and no Electron, so it can be tested hard.
 *
 * latest.json is { version, notes, url, sha256, signature }. The signature is
 * an Ed25519 signature over a fixed message built from the other four fields,
 * so changing any one of them (a different installer, a different link, even
 * the release notes) breaks it.
 */

const SIGNING_PREFIX = 'flowstate-update/1';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function signingMessage({ version, notes, url, sha256 }) {
  return Buffer.from(
    [SIGNING_PREFIX, version, url, sha256, notes].join('\n'),
    'utf8'
  );
}

function parseVersion(text) {
  if (typeof text !== 'string' || !VERSION_PATTERN.test(text)) return null;
  const [core, pre] = text.split(/-(.+)/);
  const [major, minor, patch] = core.split('.').map(Number);
  return { major, minor, patch, pre: pre ? pre.split('.') : [] };
}

function comparePrerelease(a, b) {
  // A release outranks any pre-release of the same number.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === undefined) return -1;
    if (b[index] === undefined) return 1;
    const aNumber = /^\d+$/.test(a[index]);
    const bNumber = /^\d+$/.test(b[index]);
    if (aNumber && bNumber) {
      const difference = Number(a[index]) - Number(b[index]);
      if (difference !== 0) return difference < 0 ? -1 : 1;
    } else if (aNumber !== bNumber) {
      return aNumber ? -1 : 1;
    } else if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

/** -1, 0 or 1; null when either side is not a version. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const part of ['major', 'minor', 'patch']) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }
  return comparePrerelease(left.pre, right.pre);
}

function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

function signManifest(fields, privateKeyPem) {
  const signature = crypto
    .sign(null, signingMessage(fields), crypto.createPrivateKey(privateKeyPem))
    .toString('base64');
  return { ...fields, signature };
}

/**
 * Returns { ok: true, manifest } or { ok: false, reason }. Never throws on
 * hostile input.
 */
function verifyManifest(candidate, publicKeyPem) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'malformed' };
  }
  const { version, notes, url, sha256, signature } = candidate;
  if (
    typeof version !== 'string'
    || typeof notes !== 'string'
    || typeof url !== 'string'
    || typeof sha256 !== 'string'
    || typeof signature !== 'string'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (!parseVersion(version)) return { ok: false, reason: 'malformed' };
  if (!SHA256_PATTERN.test(sha256)) return { ok: false, reason: 'malformed' };

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (parsedUrl.protocol !== 'https:') return { ok: false, reason: 'insecure-url' };

  // An Ed25519 signature is exactly 64 bytes. Checking the length here means
  // trailing junk can never ride along on an otherwise valid signature.
  const signatureBytes = Buffer.from(signature, 'base64');
  if (
    signatureBytes.length !== 64
    || signatureBytes.toString('base64') !== signature
  ) {
    return { ok: false, reason: 'bad-signature' };
  }

  let valid = false;
  try {
    valid = crypto.verify(
      null,
      signingMessage({ version, notes, url, sha256 }),
      crypto.createPublicKey(publicKeyPem),
      signatureBytes
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'bad-signature' };

  return { ok: true, manifest: Object.freeze({ version, notes, url, sha256 }) };
}

/** True when the two hex digests are equal, in constant time. */
function sha256Matches(expectedHex, actualHex) {
  if (!SHA256_PATTERN.test(expectedHex) || !SHA256_PATTERN.test(actualHex)) return false;
  return crypto.timingSafeEqual(
    Buffer.from(expectedHex, 'hex'),
    Buffer.from(actualHex, 'hex')
  );
}

module.exports = {
  compareVersions,
  isNewerVersion,
  parseVersion,
  sha256Matches,
  signManifest,
  signingMessage,
  verifyManifest,
};
