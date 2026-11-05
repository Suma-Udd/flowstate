'use strict';

/*
 * Lists what every native binary in a built app asks Windows for, and fails if
 * any of them needs the Visual C++ runtime (VCRUNTIME140, MSVCP140 and
 * friends). Those are not on a clean Windows install, so a binary that needs
 * them would crash on someone else's PC while working perfectly on a
 * developer's.
 *
 *   node scripts/check-native-imports.cjs release/win-unpacked
 *
 * Reads the PE import tables directly. No tools to install.
 */

const fs = require('node:fs');
const path = require('node:path');

const NEEDS_VC_RUNTIME = /^(vcruntime|msvcp|vcomp|concrt|msvcr)\d/i;

function readImports(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0') return null;
  const sectionCount = bytes.readUInt16LE(pe + 6);
  const optionalSize = bytes.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const directories = optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96);

  function offsetOf(rva) {
    const table = optional + optionalSize;
    for (let index = 0; index < sectionCount; index += 1) {
      const section = table + index * 40;
      const virtualAddress = bytes.readUInt32LE(section + 12);
      const size = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16));
      if (rva >= virtualAddress && rva < virtualAddress + size) {
        return rva - virtualAddress + bytes.readUInt32LE(section + 20);
      }
    }
    return -1;
  }

  const names = [];
  function readTable(rva, stride, nameField) {
    let offset = offsetOf(rva);
    if (offset < 0) return;
    for (; ; offset += stride) {
      const nameRva = bytes.readUInt32LE(offset + nameField);
      if (!nameRva) break;
      const nameOffset = offsetOf(nameRva);
      if (nameOffset < 0) break;
      let end = nameOffset;
      while (bytes[end]) end += 1;
      names.push(bytes.toString('ascii', nameOffset, end));
    }
  }

  const importTable = bytes.readUInt32LE(directories + 8);
  if (importTable) readTable(importTable, 20, 12);
  const delayTable = bytes.readUInt32LE(directories + 13 * 8);
  if (delayTable) readTable(delayTable, 32, 4);
  return names;
}

function walk(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, found);
    else if (/\.(dll|node|exe)$/i.test(entry.name)) found.push(full);
  }
  return found;
}

function main() {
  const root = process.argv[2];
  if (!root || !fs.existsSync(root)) {
    console.error('Usage: node scripts/check-native-imports.cjs <built app folder>');
    process.exit(2);
  }

  const offenders = [];
  let scanned = 0;
  for (const file of walk(root)) {
    // Other platforms' prebuilds ship inside some packages and never load here.
    if (/[\\/](darwin|linux|android)[^\\/]*[\\/]/i.test(file) || /(darwin|linux)[^\\/]*\.node$/i.test(file)) continue;
    let imports;
    try {
      imports = readImports(file);
    } catch {
      continue;
    }
    if (!imports) continue;
    scanned += 1;
    const bad = imports.filter((name) => NEEDS_VC_RUNTIME.test(name));
    if (bad.length > 0) offenders.push(`${path.relative(root, file)} needs ${bad.join(', ')}`);
  }

  console.log(`Scanned ${scanned} binaries under ${root}.`);
  if (offenders.length > 0) {
    console.error('These need the Visual C++ runtime, which a clean Windows install does not have:');
    for (const line of offenders) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log('None of them needs the Visual C++ runtime.');
}

if (require.main === module) main();

module.exports = { NEEDS_VC_RUNTIME, readImports };
