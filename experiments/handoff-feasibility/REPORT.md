# Desktop Markdown handoff: feasibility result

Date: 22 November 2026. Repository: Session Steward 0.12.2. Environment: macOS, Node 24.15.0. Tests and artifacts use synthetic data; no personal session content was submitted to receiving agents.

## Verdict

**Conditional go for Markdown as the transfer format. Do not promise flawless, automatic cross-agent continuation or compatibility with every recipient version.**

The tested design creates a readable archive with stable source record references, recent context, coverage information, and instructions to search older chunks. It makes no model calls while exporting. A receiving desktop agent can find earlier corrections instead of being limited to the latest messages. A recent-only handoff demonstrably loses required information.

This validates context retrieval, not a complete shipping feature. Native session history is not imported. Agent behavior still depends on the destination's model, file tools, permissions, context budget, and account availability. No actual coding continuation, automatic launch button, Windows or Linux desktop run, or older recipient binary was tested.

## Real desktop results

| Destination | Source archive | Observed result | Boundaries |
| --- | --- | --- | --- |
| Claude Desktop 6.28899.6, Code tab, Opus 5 High | Codex-style history, 80 messages, 51,197 source bytes | All eight requested facts recovered with source record references; one user prompt, no observed file-access permission prompt | Created and prompted through native desktop UI; quota was exhausted while wrapping up. No long Claude trial and no additional Claude runs after the user's stop instruction. |
| ChatGPT Desktop 26.1117.41037, fresh local Codex chat | Claude-style history, 25,000 messages, 21,589,481 source bytes, 436 Markdown chunks; timestamps six months earlier | All eight requested facts and their evidence recovered in 27.685 seconds; no second user message or read permission prompt | User opened and submitted the supplied test prompt. Completed result was read through the app's read-only connector. The generic computer-use tool refuses control of this app; that restriction was not bypassed. |

Eight facts checked: project, effective request header, retention period, protected file, no-publish permission, failing test, latest recorded test status, and historical branch. Header and retention requirements were corrected far earlier than the recent excerpt. An earlier passing smoke test conflicted with a later failure. Both receivers returned the corrected values and historical failure rather than assuming success.

The long ChatGPT trial found source records 1, 6751, 13251 and 24976 correctly. It searched the archive rather than loading every message into the context window. It also checked that the 436 chunks contained 25,000 records without sequence gaps. See `chatgpt-desktop-result.json` for its final response and timing.

Even the short successful Claude result had mistakes in its surrounding explanation: it called eight fields nine facts and incorrectly said the latest record was outside the recent-eight-record window. Those errors did not change the eight requested values, but are direct evidence against claiming flawless model behavior.

A preliminary Codex CLI 0.171.0 connectivity probe succeeded. It was not a receiving-agent handoff test and does not count as desktop proof. Claude CLI was not authenticated; no sign-in was needed for the actual Claude Desktop trial, which was already signed in.

## Local extraction and scale results

| Check | Result |
| --- | --- |
| Codex-style history, timestamps three months earlier | 25,000 messages; 16,661,974 bytes; 436 chunks; export 349.54 ms |
| Claude-style history, timestamps six months earlier | 25,000 messages; 21,589,481 bytes; 436 chunks; export 358.04 ms |
| Claude-style history, timestamps nine months earlier | 2,000 messages; deliberately malformed JSON and an unknown record were reported explicitly |
| Large-history streaming worker, about 32 MiB input | 33,742,848 bytes; 348.55 ms; peak RSS 87.97 MiB |
| Large-history streaming worker, about 256 MiB input | 268,888,320 bytes; 2,659.92 ms; peak RSS 133.33 MiB; no invalid or oversized records |
| Multiple projects | 5,003 discoverable synthetic sessions, including 5,000 across 25 generated workspaces. Correctly filtered 200 sessions in one project, paginated to 25, and exported just the selected session. Discovery 1,098.23 ms; selected export 0.43 ms. |
| Content preservation | Source hashes unchanged; early/middle/latest facts retained; chunk size at most 32 KiB; Unicode preserved; neighbouring project content absent |
| Incomplete input | Unknown and malformed records flagged. Oversized input lines reported rather than silently counted as exported. Missing source prevents creation of a usable START.md. Existing output directories cannot be overwritten. |

Timings are observations from this machine, not product service-level guarantees. The prototype still keeps its chunk descriptor list in memory, so these measurements do not prove constant memory at arbitrary input sizes. A production exporter should stream its index too.

### What historical compatibility was actually checked

Sixteen experiment checks passed. They include existing Codex state_5/state_6 fixtures, Claude current/alternate fixtures, and the captured Claude 2.1.325/2.1.330 request/response fixtures. The limited prototype reports unsupported fixture content; these are text extraction checks, not full-fidelity support certification.

Separately, **88 existing tests passed**: 72 provider/event tests plus 16 current-format/schema tests, including Codex 0.169.0/0.171.0 and Claude 2.1.325/2.1.330 coverage. Existing production readers remain unchanged.

The three-, six- and nine-month dates are synthetic timestamps on existing record shapes. They prove that the prototype does not discard content because of those dates. They do **not** certify every actual old transcript, every version named in the compatibility profile, every attachment/subagent format, or every historical receiving app. No older support range was added.

## Findings that change the proposed design

1. **Do not use the current timeline window as a complete export.** Its maximum is 1,000 events. A regression demonstrates that a 25,000-message history loses the earlier header correction through that API. A production exporter needs a dedicated streaming path using supported provider parsing, without duplicating an incomplete parser like this research prototype.
2. **A recent excerpt is insufficient.** All four sample cases lose early constraints, corrections and the outstanding test failure when reduced to the most recent eight messages. Include the searchable archive and explicit instructions to consult it.
3. **Keep the entry file short.** The tested long archive's START.md includes the entire chunk index and is 58,788 bytes. The receiver succeeded, but that is unnecessary initial context. Production should separate a small entry file from a paged or searchable index. This refinement itself has not had a real-agent trial yet.
4. **Make incompleteness explicit before launch.** Unknown records, malformed/oversized lines, missing attachments and interrupted writes must produce a clear partial/failed status. An invisible omission makes the seamless interface misleading. Historical snapshots need stable boundaries, file references, and a verified output before any app opens.
5. **Select the exact session and project.** Normal handoff should not merge neighbouring sessions automatically. Source project/branch must be labelled historical and checked against the actual destination workspace. A missing/moved checkout or a different worktree may need user input. Conversation files do not transport the repository or runtime environment.
6. **Place/access handoff files deliberately.** Both observed passes used files inside the selected local project. They do not establish that either app can read an arbitrary home directory, a remote/SSH project, sandbox, cloud chat, or a different computer without additional permissions.
7. **Launch support must be detected separately from export support.** Source history format, destination CLI/app capabilities, account state and platform are independent. Avoid requiring a CLI merely to validate a signed-in desktop app.
8. **No exporter model calls does not mean zero receiving usage.** The receiving agent spends its normal context and account usage reading/searching history. Do not translate subscription usage into API-dollar estimates. The Claude quota interruption is a real example of the dependency.

## Desktop launch evidence and remaining gates

OpenAI's current [desktop commands documentation](https://learn.chatgpt.com/docs/app/commands) documents `codex://new?path=...&prompt=...`. It selects a local folder and fills the composer; it **does not submit the message automatically**. The documentation therefore supports a credible button-to-prefilled-chat experience with a final Send action, not a guaranteed one-click running agent. That link itself was not exercised in this experiment.

Anthropic's [desktop documentation](https://code.claude.com/docs/en/desktop#coming-from-the-cli) documents `claude --desktop` and opening existing CLI sessions on supported platforms/accounts, requiring CLI 2.1.285 or later. It does not establish automatic submission of a new arbitrary handoff prompt in every desktop version. Its [CLI reference](https://code.claude.com/docs/en/cli-reference) and actual installed help expose different launch/resume modes; a native desktop launch adapter still needs live testing. No Claude CLI sign-in requirement should be presented as a general desktop prerequisite.

Before shipping, prove: desktop launch and prefill on each supported destination/platform; fallback when apps or capabilities are absent; independent long-history Claude receiving trials after quota availability; repeated ambiguous-history trials, including non-obvious corrections; actual code continuation with current repository checks; missing/changed files and attachments; old supported source fixtures; interrupted writes; and acceptance against the existing scale requirements. One synthetic success per direction is not a reliability percentage.

## Product recommendation

Proceed with a small, local Markdown archive plus destination-specific launch adapters and explicit capability detection. Keep the ordinary experience one handoff action, followed by the destination's Send action where required. Only interrupt for actual missing information or partial data. Do not market native migration, automatic task-state reconstruction, unlimited-context loading, or compatibility with any installed version.

No production module, compatibility version, package version, dependency, release, or remote repository was changed. No publication or push was performed for this experiment. Research scripts, measurements and this report remain local and reviewable in the repository.
