'use strict';

const { execFile } = require('node:child_process');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const VALUE_NAME = 'Flowstate';

function runReg(args, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl(
      'reg.exe',
      args,
      { encoding: 'utf8', windowsHide: true },
      (error, stdout = '', stderr = '') => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

function quoteWindowsArgument(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('"')) {
    throw new TypeError('Autostart paths must be non-empty and cannot contain quotes.');
  }
  return `"${value}"`;
}

function launchCommand({ executablePath, appPath, isPackaged }) {
  const executable = quoteWindowsArgument(executablePath);
  if (isPackaged) return `${executable} --autostart`;
  return `${executable} ${quoteWindowsArgument(appPath)} --autostart`;
}

function parseRunValue(output, valueName = VALUE_NAME) {
  if (typeof output !== 'string') return null;
  const escaped = valueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `^\\s*${escaped}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`,
    'mi'
  ).exec(output);
  return match ? match[1] : null;
}

function createAutostartManager({
  executablePath,
  appPath,
  isPackaged = true,
  valueName = VALUE_NAME,
  run = (args) => runReg(args),
} = {}) {
  const expected = launchCommand({ executablePath, appPath, isPackaged });
  if (typeof run !== 'function') {
    throw new TypeError('Autostart manager requires a registry command runner.');
  }

  async function read() {
    try {
      const { stdout } = await run(['query', RUN_KEY, '/v', valueName]);
      const command = parseRunValue(stdout, valueName);
      return Object.freeze({
        enabled: command === expected,
        command,
      });
    } catch (error) {
      // reg.exe returns exit code 1 when the key or value does not exist.
      if (error?.code === 1 || error?.code === '1') {
        return Object.freeze({ enabled: false, command: null });
      }
      throw error;
    }
  }

  async function set(enabled) {
    if (typeof enabled !== 'boolean') {
      throw new TypeError('Autostart must be a boolean.');
    }

    if (enabled) {
      await run([
        'add',
        RUN_KEY,
        '/v',
        valueName,
        '/t',
        'REG_SZ',
        '/d',
        expected,
        '/f',
      ]);
    } else {
      const current = await read();
      if (current.command !== null) {
        try {
          await run(['delete', RUN_KEY, '/v', valueName, '/f']);
        } catch (error) {
          if (error?.code !== 1 && error?.code !== '1') throw error;
        }
      }
    }

    const verified = await read();
    if (verified.enabled !== enabled) {
      throw new Error(
        enabled
          ? 'Flowstate autostart was written but registry read-back did not match.'
          : 'Flowstate autostart was removed but registry read-back still found it.'
      );
    }
    return verified;
  }

  return Object.freeze({
    expectedCommand: expected,
    read,
    set,
  });
}

module.exports = {
  RUN_KEY,
  VALUE_NAME,
  createAutostartManager,
  launchCommand,
  parseRunValue,
  quoteWindowsArgument,
  runReg,
};
