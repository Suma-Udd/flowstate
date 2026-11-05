# Notes for coding agents

Flowstate is a Windows dictation app: Electron, plain JavaScript, no bundler. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it has the layout and the rules. The short version:

## Commands

- `npm ci` to install (Windows only; it rebuilds native modules).
- `npm test` runs the whole suite with `node --test`. It must pass before a change is done.
- `npm start` runs the app. Set `FLOWSTATE_DATA_DIR` to an empty folder first so it does not touch real settings or an installed copy.
- `npm run dist` builds `release\Flowstate-Setup.exe`.

## Rules

- Runtime dependencies are a closed list (`sherpa-onnx-node`, `sherpa-onnx-win-x64`, `uiohook-napi`, `koffi`, `better-sqlite3`). Do not add one.
- Colours only in `src/renderer/styles/tokens.css`. No `box-shadow`, no inline `style` attributes, animate only `transform` and `opacity`.
- The renderer has no network access (CSP). Network code lives in `src/main`.
- Never log or commit an API key, a transcript, or a personal path. Settings and secrets live in `%APPDATA%\flowstate\config.json` only.
- Cleanup output must be an edit of what was said. Keep `src/main/cleanup-guard.js` strict and tested.
- Do not kill all `electron.exe` or `node.exe` processes: other programs use them. Stop a process by its PID.
- Never link or junction `node_modules` into another checkout or worktree.
- Write no machine-specific paths, usernames or private service names into code, tests, fixtures or docs.

## Where things are

`src/main` main process, `src/worker` speech worker, `src/renderer` screens, `src/shared` shared code, `tests` tests, `scripts` build helpers. The update system is `src/shared/update-verify.js` and `src/main/updater.js`; the first-run setup is `src/renderer/views/onboarding.js`.
