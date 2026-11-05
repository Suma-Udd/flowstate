# Security

## Reporting a problem

Please report security problems privately, using GitHub's **Report a vulnerability** button on the Security tab of this repository. Do not open a public issue for something that could hurt people who use Flowstate.

Include what you found, how to reproduce it, and which version you tested. You will get an answer as soon as it can be looked at. This is a one-person project, so please be patient.

## What Flowstate does with your data

- Audio is recognised on your PC and is not saved or sent anywhere.
- If you add a cleanup key, the text of each dictation is sent to the provider you chose, over HTTPS, and nothing else is. With no key, nothing is sent.
- Your API key is stored in plain text in `%APPDATA%\flowstate\config.json`, readable by your Windows account. Anyone who can read your user profile can read it. Use a key with a spending limit.
- Flowstate has no analytics and no telemetry.
- Dictation history, the dictionary and snippets are stored unencrypted in `%APPDATA%\flowstate`.

## How updates are protected

Every release publishes `latest.json` beside the installer. It lists the version, the release notes, the installer's download link and its SHA-256, and carries an Ed25519 signature over all of those.

Flowstate contains the matching public key. Before it offers an update it checks that signature, so a changed version, link, checksum or note is refused. After downloading the installer it checks the SHA-256 and deletes the file if it does not match. Only an https download link is accepted. Nothing is run that did not pass both checks.

The private signing key is held in the repository's GitHub Actions secrets and is used only by the release workflow. If you ever believe it has leaked, report it as above.

## Known limits

- The installer is not code-signed with a Windows certificate yet, so Windows SmartScreen warns on first run. The update signature described above is separate and is in place.
- The simulated paste uses the clipboard briefly. Flowstate restores what was there, but a clipboard manager may record the dictated text.
- A global keyboard hook is used to detect the shortcut. It watches for the shortcut keys only and does not store keystrokes.
