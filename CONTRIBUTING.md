# Contributing

Thanks for wanting to help. Flowstate is a small, focused app and the aim is to keep it that way: light when idle, private by default, and easy for anyone to install.

## Get it running

You need Windows, Node.js 24 or newer and git.

```
git clone https://github.com/Suma-Udd/flowstate.git
cd flowstate
npm ci
npm test
npm start
```

Give the dev app its own data so it never touches an installed Flowstate. In PowerShell:

```
$env:FLOWSTATE_DATA_DIR = "$env:TEMP\flowstate-dev"
npm start
```

The dev app and an installed Flowstate cannot both listen for the shortcut, so quit the installed one first.

## How the code is laid out

| Folder | What is in it |
|---|---|
| `src/main` | the main process: hotkey, recorder, dictation pipeline, cleanup, history database, settings, updater, windows |
| `src/worker` | the speech worker, which runs sherpa-onnx in its own process |
| `src/renderer` | the screens. Plain JavaScript and CSS, no framework and no build step. `views/` has one file per screen, `styles/tokens.css` holds every colour |
| `src/shared` | code used by both sides, such as the provider list and update verification |
| `tests` | the test suite, run with `npm test` |
| `scripts` | build, version and release helpers |
| `tools` | developer tools, such as the screenshot generator |

The path of one dictation is: `hotkey.js` to `state.js`, then `recorder.js` for audio, `asr-worker.js` and `src/worker` for speech to text, `pipeline.js`, `llm.js` and `cleanup-guard.js` for the text, `inject.js` to paste, and `db.js` for history.

## Rules that keep it healthy

- **Runtime dependencies are a closed list**: `sherpa-onnx-node`, `sherpa-onnx-win-x64`, `uiohook-napi`, `koffi`, `better-sqlite3`. Please do not add another without opening an issue first. Node's own `fetch` and `crypto` cover most needs. A development dependency needs a clear reason.
- **Colours live only in `tokens.css`.** No colour literals, no `box-shadow`, and animate only `transform` and `opacity`. `tests/tokens.test.js` and `tests/shell.test.js` check this.
- **The renderer has no network access.** Its Content Security Policy forbids it. Anything that needs the network happens in the main process.
- **No inline `style` attributes** in views (the CSP blocks them). Set values from data through the CSSOM.
- **Secrets stay in `config.json`.** Never log an API key, a transcript or a window title at a level a user would copy into an issue.
- **Cleanup must never invent content.** Changes to the prompt or the guard need a test in `tests/cleanup-guard.test.js` or `tests/prompt.test.js`.
- **Idle must stay idle.** No timers or animation loops in a window that is not on screen.

## Making a change

1. Fork, then make a branch.
2. Make the change and add a test that fails without it.
3. Run `npm test`. It must pass.
4. If you changed something you can see, run it with `npm start` and look at it in light and dark.
5. Open a pull request that says what changed and why, in plain words.

Small, single-purpose pull requests are easiest to review. For a big idea, open an issue first.

## Releases

A maintainer releases from the **windows-build** workflow on GitHub Actions. It sets the version, builds the installer, tests it on a clean runner, signs `latest.json` and publishes the release. Run it with no version for a test build.

By contributing you agree that your work is released under the [MIT license](LICENSE).
