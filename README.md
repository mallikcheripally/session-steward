# Session Steward

A local Codex and Claude Code session manager for safely reviewing, backing up, and deleting old sessions from a browser UI or terminal CLI.

AI coding tools can accumulate hundreds or thousands of local sessions. A session may leave behind transcripts, history, logs, checkpoints, and linked artifacts, so manual cleanup can easily miss related data.

Session Steward makes session cleanup safer by finding those records, showing what cleanup will affect, creating a local backup, removing supported data, and verifying the result afterward. Everything runs locally, and your session data stays on your computer.

![Session Steward cleanup demo](https://raw.githubusercontent.com/mallikcheripally/session-steward/main/docs/session-steward-demo.gif)

## Manage local Codex and Claude Code sessions

- Review sessions in a browser UI or terminal CLI.
- Switch between Codex and Claude Code without installing another package.
- See session counts and the storage used by recognized session files.
- Find sessions inactive for 30, 60, or 90 days.
- Filter active or archived sessions by workspace, name, or session ID.
- Inspect session details and affected records before deletion.
- Choose standard or thorough cleanup.
- Use custom Codex or Claude home folders across browser and terminal sessions.

## Safe by default

- Cleanup happens entirely on your computer.
- Only records included in the reviewed cleanup plan are removed.
- A local recovery backup is created before anything changes.
- Cleanup is verified before the backup is removed.
- Unrecognized storage is reported and left untouched.
- Thorough cleanup is unavailable when the detected storage format is not supported.
- Session contents are never sent over the network.

At startup, Session Steward may contact the public npm registry to check for a newer version.

### Session Steward does not remove

- Sign-in data or saved API credentials
- Configuration, plugins, caches, or custom prompt files
- Project files, Git repositories, or worktrees
- Sessions outside the reviewed cleanup plan
- Conversations stored in your ChatGPT or Claude account
- Claude Code worktrees, branches, repositories, remote sessions, SSH sessions, or Cowork data

## Install and get started

Session Steward supports macOS and Linux and requires Node.js 24.15 or newer. Git and a separate SQLite installation are not required.

Install it globally:

```bash
npm install --global session-steward
```

Then launch it:

```bash
session-steward
```

Or try it without installing:

```bash
npx session-steward@latest
```

Session Steward opens in your browser, listens only on `127.0.0.1`, and detects `~/.codex` and `~/.claude` by default. Claude Desktop sessions are detected on macOS; Claude Code CLI sessions work on macOS and Linux.

To clean up sessions:

1. Review the detected sessions.
2. Select one or more sessions.
3. Choose a cleanup option.
4. Review exactly what will be removed.
5. Close any selected sessions that may still be active.
6. Confirm the cleanup.

Keep the terminal open while using Session Steward. Press `Ctrl+C` to stop it.

## Cleanup and recovery

### Standard cleanup

Recommended for routine removal. It removes supported transcripts, history, registry entries, logs, and linked session artifacts belonging to the selected sessions.

### Thorough cleanup

Includes standard cleanup and removes additional recognized session-owned data. For Codex this can include supported Desktop references, memory outputs, and goal records. For Claude Code this includes recognized file checkpoints.

Thorough cleanup is unavailable when Session Steward finds storage it does not recognize. Standard cleanup remains available for supported records that can be identified safely.

### Recovery backups

A temporary backup is created inside the active provider folder under `session-steward-backups/`.

After cleanup is successfully verified, the backup is removed automatically. If cleanup fails, Session Steward keeps the backup and lets you restore the sessions, keep the backup, or delete it.

Before restoring, the current versions of affected files are saved separately to provide another recovery point.

## Terminal CLI

Start the interactive terminal interface:

```bash
session-steward-cli
```

Use Claude Code instead of Codex:

```bash
session-steward-cli --provider claude-code
```

List sessions as JSON:

```bash
session-steward-cli --json --limit 10
```

Find sessions inactive for at least 60 days:

```bash
session-steward-cli --inactive-days 60
```

Show only archived sessions:

```bash
session-steward-cli --archive-status archived
```

Show sessions from one exact workspace:

```bash
session-steward-cli --workspace /path/to/project
```

The interactive terminal accepts the same filters:

```text
inactive 30
inactive 60
inactive 90
archive active
archive archived
workspace /path/to/project
```

Run `inactive`, `archive`, or `workspace` without a value to clear that filter.

Use `session-steward-cli --help` to see all available options.

## Use a custom provider folder

The browser interface displays the active provider folder. Select **Change** to choose another existing folder and remember it for later browser and terminal sessions.

For a one-time override:

```bash
session-steward --codex-home /path/to/.codex
```

For Claude Code:

```bash
session-steward --claude-home /path/to/.claude
```

The command-line override applies only to that run and does not replace your saved folder.

## Other commands

Start without automatically opening the browser:

```bash
session-steward --no-open
```

Update Session Steward:

```bash
npm install --global session-steward@latest
```

Uninstall it:

```bash
npm uninstall --global session-steward
```

Uninstalling Session Steward does not remove provider sessions, recovery backups, or saved folder preferences.

## Troubleshooting

- **The browser did not open:** Run `session-steward --no-open`, then open the local address shown in the terminal.
- **No sessions were found:** Check the selected provider and displayed home folder. Use **Change** or pass a one-time home-folder override.
- **Thorough cleanup is unavailable:** Review the compatibility details. Unrecognized storage is left untouched, but standard cleanup may still be available.
- **Your Node.js version is too old:** Install Node.js 24.15 or newer and run Session Steward again.

## Development

```bash
git clone https://github.com/mallikcheripally/session-steward.git
cd session-steward
npm install
npm test
npm run build
```

Scale benchmarks are also available:

```bash
npm run benchmark:scale
npm run benchmark:overview
npm run benchmark:discovery
npm run benchmark:transcripts
```

Tests and benchmarks use temporary synthetic session data. They do not read or modify your local sessions.

## Support

Codex, Claude Code CLI, and local Claude Code Desktop sessions are supported. Claude Desktop archive is not treated as deletion, and Session Steward never removes its worktrees.

Use [GitHub Issues](https://github.com/mallikcheripally/session-steward/issues) to report a bug, request a provider, or share a storage format that Session Steward does not recognize.

Session Steward is an independent project and is not affiliated with or endorsed by OpenAI or Anthropic.

## License

[MIT](LICENSE)
