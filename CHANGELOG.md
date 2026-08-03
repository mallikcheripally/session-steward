# Changelog

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

[0.3.0]: https://github.com/mallikcheripally/session-steward/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/mallikcheripally/session-steward/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mallikcheripally/session-steward/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mallikcheripally/session-steward/releases/tag/v0.1.0
