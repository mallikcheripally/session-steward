# Session Steward

Session Steward helps you review and remove local AI coding sessions. The first release supports Codex; Claude Code support is planned next.

Your session data stays on your computer. Session Steward does not delete conversations stored in your ChatGPT account.

> Session Steward is an independent project and is not affiliated with or endorsed by OpenAI.

## Safety

Before anything is removed, Session Steward shows the affected sessions and local records. Cleanup is limited to recognized session data, creates a local backup, and checks the result afterward. Unrecognized storage is reported but left untouched.

Close selected Codex sessions before deleting them. Session Steward cannot yet tell whether a session is actively writing.

## Current development setup

The npm package has not been published yet. To run this checkout on macOS or Linux, install:

- Git
- Node.js 24.15 or newer

Then run:

```bash
npm install
npm run build
npm start
```

Session Steward starts a local service, opens the browser UI, and listens only on `127.0.0.1`. To print the address without opening a browser:

```bash
npm start -- --no-open
```

To use a different Codex home for one run:

```bash
npm start -- --codex-home /path/to/.codex
```

The browser UI shows the active Codex session folder. A folder selected there is remembered for future browser and terminal sessions. The `--codex-home` option changes the folder only for that run and does not replace the saved choice.

## Terminal interface

The browser UI is the primary interface. A text interface is also available:

```bash
node ./bin/session-steward-cli.mjs
node ./bin/session-steward-cli.mjs --json --limit 10
```

The terminal interface uses the same saved Codex folder as the browser UI. You can still pass `--codex-home /path/to/.codex` for a one-time override.

After a global package installation, the commands will be `session-steward` and `session-steward-cli`.

## Cleanup options

- Core removal deletes the session registry entry, transcript, history, session index, logs, and linked subagents.
- Deep local scrub also deletes recognized ChatGPT Desktop references, memory outputs, and goal records.

Authentication, settings, plugins, caches, project files, worktrees, and unrelated sessions are not removed.

## Development

```bash
npm test
npm run benchmark:scale
npm run build
npm pack --dry-run --cache .npm-cache
```

Tests use temporary synthetic Codex data. They do not read or change your local Codex sessions.

## License

No license has been granted yet. The package remains private until release terms are chosen.
