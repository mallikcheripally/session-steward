# Keep protection plan

Agreed product contract:

- Keep is a Session Steward-owned cleanup exclusion. It does not change or protect provider data.
- A kept session is identified by provider, provider home, and session ID.
- A kept workspace covers that folder and its descendants across providers, including future sessions.
- Manual and scheduled cleanup skip kept sessions. If a deletion cascade reaches a kept session, the originating selected session is skipped.
- Protection uses existing session metadata only; it does not index or watch transcripts.

Implementation checklist:

- [x] Persist versioned Keep rules with atomic, fail-closed storage.
- [x] Decorate session records with their effective Keep state.
- [x] Enforce Keep during cleanup preview and final revalidation.
- [x] Handle linked-session cascades without partially deleting a relationship tree.
- [x] Filter and report kept candidates in automatic cleanup.
- [x] Add browser controls and clear provider-deletion disclosure.
- [x] Correct the Kept-items hierarchy and add bulk Keep for selected sessions.
- [x] Replace the Kept-items modal with an `All / Kept` mode in the existing session list.
- [x] Add `Sessions / Workspaces` views with bulk Stop keeping and paginated workspace management.
- [x] Filter kept sessions before pagination and compile matching for bounded lookup cost.
- [x] Verify the final desktop, tablet, and phone layouts in Brave, including search focus and dense rows.
- [x] Add terminal CLI and MCP management surfaces.
- [x] Cover persistence, path matching, races, cascades, schedules, and UI behavior with tests.
- [x] Run the build, focused Keep tests, full suite, and final diff/package review.
- [ ] Re-run the sandbox-restricted live-process test when reviewer access is available.

Validation status:

- Keep and provider-focused tests: 152 passed.
- Production build and packed-artifact smoke test: passed; the tarball includes the new protection module and installs and runs independently.
- Scale coverage: 10,000 workspace rules are searched and paginated without returning the full rule set; provider filters run before paging.
- Browser visual review in Brave: passed at desktop, 768px tablet, and 390px phone widths for `All / Kept`, `Sessions / Workspaces`, mixed kept/unkept selection actions, workspace-rule search and focus treatment, and the timed Keep toast with Undo. No browser warnings or errors.
- Full suite: 320 passed, 1 normal platform skip, and 1 environment-dependent live-process probe could not query process start time in this sandbox.
