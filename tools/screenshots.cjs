'use strict';

/*
 * Captures the README screenshots from the real renderer with its placeholder
 * data: the real preload, the real shell bridge, the real frameless window.
 * Nothing is read from or written to your own settings or history.
 *
 *   npm run screenshots
 *   npm run screenshots -- --out some\folder
 *
 * Output: docs/screenshots/<screen>-<theme>.png
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const { createShellBridge } = require('../src/main/shell.js');
const { DEFAULT_CONFIG } = require('../src/main/config.js');
const { LLM_PROVIDERS } = require('../src/shared/llm-providers.js');

const SCREENS = [
  ['dictation', '/dictation'],
  ['dictionary', '/dictionary'],
  ['settings', '/settings/general'],
  ['welcome', '/welcome'],
];
const THEMES = ['light', 'dark'];
const SIZE = { width: 1280, height: 800 };

function outDirectory() {
  const flag = process.argv.indexOf('--out');
  return flag !== -1 && process.argv[flag + 1]
    ? path.resolve(process.argv[flag + 1])
    : path.join(__dirname, '..', 'docs', 'screenshots');
}

const ready = (route) => `
  new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    (function poll() {
      const html = document.documentElement;
      const state = html.dataset.ready;
      if (state === 'error') return reject(new Error(document.body.innerText.slice(0, 300)));
      if (state === 'true' && html.dataset.route === ${JSON.stringify(route)}) {
        return document.fonts.ready.then(() => resolve(true));
      }
      if (Date.now() > deadline) return reject(new Error('the screen did not settle in 15s'));
      setTimeout(poll, 50);
    })();
  })
`;

function memoryConfig() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.llm.apiKey = 'placeholder';
  config.onboarding.completed = true;
  return {
    get: () => structuredClone(config),
    update: async (patch) => {
      Object.assign(config.ui, patch.ui ?? {});
      return structuredClone(config);
    },
    on() {},
    off() {},
    setTheme: (mode) => { config.ui.theme = mode; },
  };
}

function publicConfig(config) {
  const copy = config.get();
  copy.llm.apiKeyConfigured = true;
  delete copy.llm.apiKey;
  return copy;
}

async function capture(window) {
  try {
    return await window.webContents.capturePage();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 600));
    return window.webContents.capturePage();
  }
}

async function main() {
  const directory = outDirectory();
  await fs.mkdir(directory, { recursive: true });
  const config = memoryConfig();
  const bridge = createShellBridge({
    ipcMain,
    nativeTheme,
    config,
    windowFromWebContents: (contents) => BrowserWindow.fromWebContents(contents),
    getWindows: () => BrowserWindow.getAllWindows(),
  });

  // Just enough of the real channels for the settings screen to look lived in.
  ipcMain.handle('flowstate:config-get', () => publicConfig(config));
  ipcMain.handle('flowstate:llm-providers', () => LLM_PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    baseUrl: provider.baseUrl,
    model: provider.model,
    requiresApiKey: provider.requiresApiKey,
    keyDoc: provider.keyUrl ? `key-${provider.id}` : null,
  })));
  ipcMain.handle('flowstate:model-status', () => ({
    phase: 'ready',
    percent: 100,
    totalBytes: 487170055,
    modelsDirectory: '%LOCALAPPDATA%\flowstate\models',
  }));
  ipcMain.handle('flowstate:insights-summary', () => ({
    dictations: { period: 214, allTime: 1204 },
    words: { period: 7302, allTime: 38912 },
  }));
  ipcMain.handle('flowstate:mics-list', () => [
    { deviceId: 'default', label: 'Studio microphone', isDefault: true },
  ]);
  ipcMain.handle('flowstate:hotkey-get', () => ({ chord: ['Ctrl', 'Meta'] }));
  ipcMain.handle('flowstate:mics-watch-start', () => ({ watching: true }));
  ipcMain.handle('flowstate:mic-preview-start', () => ({ watching: true }));
  ipcMain.handle('flowstate:mic-preview-stop', () => ({ watching: false }));
  ipcMain.handle('flowstate:update-state', () => ({ phase: 'idle', currentVersion: '0.1.0' }));

  const index = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  let captured = 0;
  const problems = [];

  for (const theme of THEMES) {
    config.setTheme(theme);
    bridge.applyMode();

    // A fresh window per screen: a screen is then exactly what a first launch
    // on that route looks like, with nothing carried over from the one before.
    for (const [name, route] of SCREENS) {
      const window = new BrowserWindow({
        ...SIZE,
        useContentSize: true,
        show: false,
        frame: false,
        webPreferences: {
          preload: path.join(__dirname, '..', 'src', 'main', 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      window.webContents.on('console-message', (event) => {
        // Channels this tool does not serve make a screen keep its placeholder
        // rows, which is what the screenshots are for.
        if ((event.level ?? event) === 'error' && !/No handler registered/.test(event.message ?? '')) {
          problems.push(`${name} ${theme}: ${event.message ?? ''}`);
        }
      });
      const target = new URL(index);
      target.hash = route;
      try {
        await window.loadURL(target.toString());
        await window.webContents.executeJavaScript(ready(route), true);
        // One more frame, so the route's entry animation has finished.
        await new Promise((resolve) => setTimeout(resolve, 600));
        const file = `${name}-${theme}.png`;
        await fs.writeFile(path.join(directory, file), (await capture(window)).toPNG());
        console.log(`  ${file}`);
        captured += 1;
      } catch (error) {
        problems.push(`${name} ${theme}: ${error.message}`);
      }
      window.destroy();
    }
  }

  bridge.dispose();
  console.log(`\n${captured} of ${SCREENS.length * THEMES.length} captured into ${directory}`);
  if (problems.length) console.error(`\n${problems.join('\n')}`);
  app.exit(problems.length ? 1 : 0);
}

app.on('window-all-closed', () => {});
app.whenReady().then(main).catch((error) => {
  console.error(error);
  app.exit(1);
});
