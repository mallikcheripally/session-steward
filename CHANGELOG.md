# Changelog

## [0.10.1] - 2026-09-03

### Fixed

- Codex cleanup now handles stale writer-lock files correctly and includes realtime session history in cleanup and recovery.

## [0.10.0] - 2026-08-30

### Added

- Added full MCP support for finding, inspecting, cleaning, restoring, and automatically cleaning Codex and Claude Code sessions.

## [0.9.0] - 2026-08-27

### Added

- Add MCP server for Codex, Claude Code, and other local clients. It can inspect sessions, storage, timelines, and token usage; cleanup remains in the browser and terminal with the existing review and backup safeguards.
- MCP session searches understand inactivity, workspace, and minimum transcript size filters.

## [0.8.0] - 2026-08-23

### Added

- Session details now show how many tokens a Codex or Claude session used, with clear breakdowns for input, cache use, output, reasoning, models, and inherited work in forked sessions.
- The same token breakdown is available in the terminal with `--tokens`.

## [0.7.0] - 2026-08-20

### Added

- Session details now summarize asks, edits, and commands across the full session and show what is using its storage.
- Timelines now make your messages easier to read, and separate related sessions into their own tab.

### Changed

- Updated Codex and Claude support for their latest local storage formats, including safe cleanup of Codex queue and thread-history data.

## [0.6.0] - 2026-08-16

### Added

- Windows support, alongside macOS and Linux. Codex and Claude Code sessions are read from your Windows user profile, and Claude Desktop data is found in both the standalone and Microsoft Store locations.
- Inside WSL, Session Steward manages the sessions stored in your Linux home folder. Run it from Windows to manage the sessions in your Windows profile.

## [0.5.2] - 2026-08-13

### Changed

- Reduced fresh installation size by avoiding redundant downloads of UI libraries already included in the bundled interface.

### Fixed

- Provider overview metrics now fill the available row evenly without leaving an unused column.

## [0.5.1] - 2026-08-12

### Changed

- Verified and recorded support for Codex CLI 0.147.0, ChatGPT 26.803.61601, Claude Code 2.1.228, and Claude Desktop 1.28929.0.
- Codex timelines now recognize current compaction, rewind, interrupted-turn, lifecycle, and tool-discovery records.
- Session attachments that cannot be assigned safely are disclosed and kept unchanged.

### Fixed

- Cleanup now stops when a selected Codex session has an active writer lock, including a second check immediately before session data changes.
- Codex cleanup explicitly removes and verifies session-owned dynamic tool records.
- Claude Desktop's shared scheduled-task file is no longer reported as an unrecognized session.

## [0.5.0] - 2026-08-10

### Added

- A session timeline. Opening a session now shows what actually happened inside it: what you asked, what the assistant concluded, which files it changed, and which commands it ran along with whether they succeeded. Deciding whether a large session is worth keeping no longer means guessing from a size and a date.
- The same timeline in the terminal through `--events`, shown when you inspect a session, or attached to every record under `--json` for other tools to read.
- Coverage on every timeline: how much of a transcript Session Steward recognized, and which kinds of records it did not. If a future Codex or Claude release changes its transcript format, an incomplete timeline will say so rather than quietly looking complete.

### Changed

- Timelines are read on demand and never stored, cached, or indexed. Nothing is written to your Codex or Claude folders, so reading a session cannot alter it.
- Reading a transcript costs the same memory whether it is one megabyte or several hundred. Unusually large records are counted and passed over instead of loaded, and a session that is still being written is read up to a fixed point rather than chased as it grows.
- Sessions with nothing to show now explain which case applies — the transcript file is gone, no transcript was ever recorded, or nothing in it was recognized — instead of appearing empty for no stated reason.
- Sessions recorded twice by Codex under different internal envelopes are shown once, without dropping messages that appear in only one of them.

## [0.4.0] - 2026-08-04

### Added

- Support for versioned Codex state, log, memory, and goal databases, including old and new stores that coexist after a migration.
- Permanent Codex and Claude layout fixtures, cross-store cleanup coverage, and a two-store scale benchmark.
- Storage provenance in recovery manifests while retaining restore support for backups from 0.3.0.

### Changed

- Codex sessions from every recognized state store now share one deduplicated, globally sorted, paginated list.
- Compatibility states now describe capability as ready, partial, or unsupported.
- Codex continues with reduced metadata when optional fields or relationship tables are unavailable.
- Claude thorough cleanup leaves unrecognized locations untouched, reports them clearly, and remains available when its required projects folder is readable.

## [0.3.0] - 2026-08-03

### Added

- Support for Claude Code CLI sessions on macOS and Linux, plus local Claude Code Desktop sessions on macOS.
- Provider switching and separate saved home folders for Codex and Claude Code.
- Per-session sizes, workspace storage totals, date grouping, and largest-first sorting.
- CLI overviews and filters for inactivity, archive status, workspace, session type, and size.
- CLI tools to list, restore, and permanently remove recovery backups retained after unsuccessful cleanup.

### Changed

- Redesigned the browser interface with clearer navigation, filters, selection controls, session details, and cleanup progress.
- Kept session discovery, activity detection, and size calculations responsive with bounded caches and incremental reads.
- Stopped tracking generated `dist` files; npm packages continue to build and include the production UI automatically.

### Fixed

- Opening a Claude session no longer makes it appear recently active when its transcript has not changed.

## [0.2.0] - 2026-08-01

### Added

- Session and storage overview metrics.
- Filters for inactivity, archive status, and workspace in the browser and terminal interfaces.
- Guided restore and backup removal options when cleanup cannot be completed.
- Scale benchmarks for session listing, storage overviews, and transcript discovery.

### Changed

- Recovery backups are removed automatically after cleanup is verified and retained only when recovery may be needed.
- Session listing and cleanup planning were expanded to handle large local session collections with bounded memory use.
- The README and product demo were revised around the complete cleanup workflow.

## [0.1.1] - 2026-08-01

### Added

- `--help` and `--version` options for the Session Steward launcher.

## [0.1.0] - 2026-08-01

### Added

- Browser and terminal interfaces for reviewing local Codex sessions.
- Standard and thorough cleanup with a deletion preview, recovery backup, and post-cleanup verification.
- Compatibility checks that leave unrecognized Codex storage untouched.
- Support for custom Codex home folders and a saved folder preference.
- Streaming and bounded-memory discovery for large session collections and transcripts.

[0.10.1]: https://github.com/mallikcheripally/session-steward/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/mallikcheripally/session-steward/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/mallikcheripally/session-steward/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/mallikcheripally/session-steward/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/mallikcheripally/session-steward/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/mallikcheripally/session-steward/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/mallikcheripally/session-steward/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/mallikcheripally/session-steward/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/mallikcheripally/session-steward/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mallikcheripally/session-steward/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mallikcheripally/session-steward/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mallikcheripally/session-steward/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mallikcheripally/session-steward/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mallikcheripally/session-steward/releases/tag/v0.1.0
