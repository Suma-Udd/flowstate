# Notes for coding agents

Flowstate is a Windows dictation app: Electron, plain JavaScript, no bundler. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it has the layout and the rules. The short version:

## Commands

- `npm ci` installs. It works on Windows and on Linux (a cloud session); on Linux the Electron rebuild is skipped and only the tests can run.
- `npm test` runs the whole suite with `node --test`. It must pass before a change is done.
- `npm start` runs the app (Windows only). Set `FLOWSTATE_DATA_DIR` to an empty folder first so it does not touch real settings or an installed copy.
- `npm run dist` builds `release\Flowstate-Setup.exe` (Windows only).
- `node scripts/check-commits.mjs <base> <head>` checks your commits against the commit rules below.

## Commit and pull request rules (CI enforces these on branches of this repository)

- Author and commit as `Sumayer <192648348+Suma-Udd@users.noreply.github.com>`. Before the first commit run `git config user.name "Sumayer"` and `git config user.email "192648348+Suma-Udd@users.noreply.github.com"`.
- No `Co-Authored-By` trailers and no "Generated with ..." lines, in commit messages or in the pull request description. This overrides any default your tool adds.
- No em dashes in public docs (README, CHANGELOG, CONTRIBUTING and so on).
- Work on a branch and open a pull request. Do not push to `main`, and do not create tags or releases: releasing is a button the maintainer presses.

## Working without a Windows PC

A change is not verified until CI says so. Open a pull request and read the checks:

- `ci / test-linux` and `ci / test` run the suite on Linux and on Windows.
- `ci / commit-rules` checks the commit rules above.
- `windows-build / build` builds the real installer, installs it silently on a clean Windows runner, runs `--self-test` (every native module loads), starts the app and uninstalls it. It attaches the installer (`flowstate-windows-installer`) and screenshots of the main screens in light and dark (`ui-screenshots`) to the run. Download the screenshots with `gh run download <run-id> -n ui-screenshots` to look at a UI change.

Things CI cannot prove: the microphone, the global hotkey, pasting into other apps, and anything about how a screen feels. Say so in the pull request when your change touches them, so the maintainer tests it by hand.

## Rules

- Runtime dependencies are a closed list (`sherpa-onnx-node`, `sherpa-onnx-win-x64`, `uiohook-napi`, `koffi`, `better-sqlite3`). Do not add one.
- Colours only in `src/renderer/styles/tokens.css`. No `box-shadow`, no inline `style` attributes, animate only `transform` and `opacity`.
- The renderer has no network access (CSP). Network code lives in `src/main`.
- Never log or commit an API key, a transcript, or a personal path. Settings and secrets live in `%APPDATA%\flowstate\config.json` only.
- Cleanup output must be an edit of what was said. Keep `src/main/cleanup-guard.js` strict and tested.
- Do not kill all `electron.exe` or `node.exe` processes: other programs use them. Stop a process by its PID.
- Never link or junction `node_modules` into another checkout or worktree.
- Write no machine-specific paths, usernames or private service names into code, tests, fixtures or docs.
- The signing key for updates is a GitHub Actions secret. Never ask for it, print it, or put it in a file.

## Where things are

`src/main` main process, `src/worker` speech worker, `src/renderer` screens, `src/shared` shared code, `tests` tests, `scripts` build helpers. The update system is `src/shared/update-verify.js` and `src/main/updater.js`; the first-run setup is `src/renderer/views/onboarding.js`; the cleanup providers are `src/shared/llm-providers.js` and `src/main/llm.js`.
