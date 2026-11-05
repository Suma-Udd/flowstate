# Changelog

All notable changes to Flowstate. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [semantic versioning](https://semver.org/).

## [0.1.0]

First public release.

### Dictation
- Hold-to-talk dictation: hold Ctrl + Win, speak, let go, and the text is pasted at the cursor in any app. The shortcut can be changed.
- Speech recognition runs locally on the CPU with NVIDIA Parakeet TDT 0.6B v3 and Silero voice activity detection. Audio never leaves the PC.
- The speech worker unloads after a period without dictation, so Flowstate stays light when idle.
- Dictionary with sounds-like hints that also steer recognition, and snippets that expand trigger phrases.
- History with full-text search and re-paste, a Scratchpad you can dictate into, and Insights.

### Cleanup
- Optional cleanup through any OpenAI-compatible service: DeepSeek, OpenAI, Groq, OpenRouter, or a custom base URL and model (for example a local Ollama).
- A guard rejects any cleanup result that is not an edit of what was said, and the original words are pasted instead.
- With no key, Flowstate pastes the raw transcript and explains it once.
- Keys are stored only in `%APPDATA%\flowstate\config.json`.

### Getting started
- First-run setup: welcome, speech model download with progress, microphone check with a live level meter, the shortcut, an optional cleanup key, and a place to try it. It can be skipped and re-run from Settings, About.
- One installer, `Flowstate-Setup.exe`, per-user, no administrator rights needed.

### Updates
- Flowstate checks GitHub for a new version after it starts and every six hours, shows what changed, and installs it on request after verifying a SHA-256 checksum and an Ed25519 signature.
- Settings, About has a Check for updates button.
