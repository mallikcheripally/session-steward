# Session Steward

Safely review, back up, and remove local Codex sessions with a browser UI or terminal CLI.

Session Steward is a local-first Codex session manager for macOS and Linux. It shows what will be removed before cleanup, creates a local backup, and verifies the result afterward. Your session data stays on your computer.

Use it to clear old Codex session history, reclaim the space used by session artifacts, or remove local session traces without resetting the rest of your Codex setup.

![UI of sessions, filters, and session details](https://raw.githubusercontent.com/mallikcheripally/session-steward/main/docs/session-steward-overview.jpg)

## Why Session Steward

- Review local Codex sessions in a clear browser interface.
- See linked subagents and affected local records before deletion.
- Choose between focused session removal and a deeper local cleanup.
- Keep an automatic backup of every cleanup operation.
- Pause thorough cleanup when an unfamiliar storage format is found.
- Verify that selected session artifacts were removed.
- Use the same saved Codex folder in the browser and terminal interfaces.

Session Steward does not delete conversations stored in your ChatGPT account.

## Requirements

- macOS or Linux
- [Node.js](https://nodejs.org/) 24.15 or newer
- Local sessions created by Codex

Git and a separate SQLite installation are not required. Session Steward uses the SQLite support included with Node.js.

## Install

Install Session Steward globally with npm:

```bash
npm install --global session-steward
```

Then launch it:

```bash
session-steward
```

Session Steward opens its browser interface and listens only on `127.0.0.1`. It uses `~/.codex` by default.

Keep the terminal open while using Session Steward. Press `Ctrl+C` when you want to stop it.

To try it without a global installation:

```bash
npx session-steward@latest
```

## Quick start

1. Run `session-steward`.
2. Review the detected Codex sessions.
3. Select one or more sessions.
4. Choose a cleanup option and review the deletion preview.
5. Close any selected sessions that may still be active.
6. Confirm the cleanup.

Each cleanup creates a backup inside your Codex folder under `session-steward-backups/`.

## What you can adjust

- Search by session name, workspace, or session ID.
- Sort by recent activity, creation time, name, or workspace.
- Show subagent and supporting sessions when you need the additional detail.
- Choose standard or thorough cleanup for each deletion.
- Change the Codex session folder and save that choice for later runs.

## Safety model

Session Steward is intentionally conservative:

- All session inspection and cleanup happens on your computer.
- Only recognized Codex storage is changed.
- Unrecognized databases and changed storage layouts are reported but left untouched.
- Thorough cleanup is paused when the local storage layout is not supported.
- A backup is created before session data is changed.
- Cleanup is checked afterward for remaining selected artifacts.
- Authentication, plugins, caches, project files, worktrees, and unrelated sessions are not removed.

At startup, Session Steward may contact the public npm registry to check for a newer release. It does not send session contents or other Codex data.

Close selected Codex sessions before deleting them. Session Steward cannot currently determine whether a session is still being written to.

## Cleanup options

### Standard cleanup

Recommended for routine session removal. It removes the selected session registry entries, transcripts, history entries, session-index entries, logs, and linked subagents.

### Thorough cleanup

Choose this when you also want supported local references and generated records removed. It includes everything in standard cleanup, plus recognized ChatGPT Desktop references, memory outputs, and goal records.

Thorough cleanup remains unavailable when Session Steward finds storage it does not recognize. Standard cleanup stays available for the supported records it can identify safely.

## Backups and recovery

Completed cleanups keep their recovery backup on disk. If cleanup encounters a problem after creating its backup, Session Steward offers a guided restore from the cleanup progress screen.

Before restoring, Session Steward saves the current versions of the affected files in a separate safety folder. This gives you a second recovery point if the restore itself is interrupted.

## Use a custom Codex home folder

The browser interface shows the active Codex session folder. Choose **Change folder** to select another existing Codex folder and remember it for future browser and terminal sessions.

For a one-time folder override:

```bash
session-steward --codex-home /path/to/.codex
```

The command-line override applies only to that run and does not replace the saved folder.

Saved settings are stored at:

- macOS: `~/Library/Application Support/session-steward/config.json`
- Linux: `$XDG_CONFIG_HOME/session-steward/config.json`, or `~/.config/session-steward/config.json` when `XDG_CONFIG_HOME` is not set

## Terminal interface

For an interactive terminal workflow:

```bash
session-steward-cli
```

To inspect a small JSON result without opening the browser:

```bash
session-steward-cli --json --limit 10
```

Run `session-steward-cli --help` for all available options. The terminal interface uses the same saved Codex folder as the browser interface.

## Common commands

Start without opening a browser:

```bash
session-steward --no-open
```

Update to the latest release:

```bash
npm install --global session-steward@latest
```

Uninstall Session Steward:

```bash
npm uninstall --global session-steward
```

Uninstalling the package does not remove your Codex sessions, Session Steward backups, or saved folder preference.

## Troubleshooting

### The browser did not open

Run `session-steward --no-open`, then open the local address printed in the terminal.

### No sessions were found

Confirm that the displayed Codex folder contains your local session data. Use **Change folder** or pass `--codex-home` for a one-time override.

### Thorough cleanup is unavailable

Open the compatibility details in Session Steward. New or changed local storage is left untouched until that format is supported. You can still use standard cleanup when its recognized records are supported.

### Node.js is too old

Install Node.js 24.15 or newer, then run `session-steward` again.

## Development

Clone the repository and install its dependencies:

```bash
git clone https://github.com/mallikcheripally/session-steward.git
cd session-steward
npm install
```

Useful commands:

```bash
npm start
npm test
npm run benchmark:scale
npm run benchmark:discovery
npm run benchmark:transcripts
npm run build
npm pack --dry-run --cache .npm-cache
```

Tests use temporary synthetic Codex data. They do not read or change your local Codex sessions.

## Roadmap

Codex is supported today. Claude Code is planned as the next provider integration.

## Support

Use [GitHub Issues](https://github.com/mallikcheripally/session-steward/issues) to report a bug, request a provider, or share a storage format that Session Steward does not yet recognize.

Session Steward is an independent project and is not affiliated with or endorsed by OpenAI.

## License

[MIT](LICENSE)
