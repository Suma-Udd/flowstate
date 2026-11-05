'use strict';

/*
 * Rebuilds better-sqlite3 against Electron on Windows, where the app runs.
 * On other systems (a Linux machine or a cloud session running the tests) the
 * rebuild is skipped: the tests run under plain Node and better-sqlite3 ships
 * a prebuilt binary for it, so no compiler is needed.
 */

const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') {
  console.log('postinstall: not Windows, skipping the Electron rebuild.');
  process.exit(0);
}

const result = spawnSync('npx.cmd', ['electron-rebuild', '-f', '-w', 'better-sqlite3'], {
  stdio: 'inherit',
  shell: true,
});
process.exit(result.status ?? 1);
