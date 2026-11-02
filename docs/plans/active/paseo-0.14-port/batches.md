## Port order (batches)

Each batch is one coherent JAgentDesk commit. A coder agent can do it from a written story. Order: security and provider correctness first, then daemon and git, then plugin parity, then app/UI, with the high-conflict adapted batches last. Within a batch, apply the commits in the order listed (upstream order). After each batch:

1. Rebrand every new string (`paseo`→`jagentdesk`, `Paseo`→`JAgentDesk`, `PASEO_`→`JAGENTDESK_`, `@getpaseo/`→`@jagentdesk/`) and file name (`paseo-tools.ts`→`jagentdesk-tools.ts`, `paseo.json`→`jagentdesk.json`).
2. Port the upstream tests in the same commits (most commits ship a `*.test.ts`).
3. Run `npm run typecheck` for the touched workspaces and `vitest run` on the touched folders.
4. Run `oxfmt` before committing (lefthook fails silently).
5. Bump the JAgentDesk version for daemon-side changes, so installed daemons restart.
6. Verify app changes in the real desktop or mobile app (CDP or `xcrun simctl`, without taking over the mouse).

"Sequential apply" is the mechanical result of applying the batch's patches in order on a scratch copy of JAgentDesk HEAD, after the earlier batches: the number of files applied, and the source files that need a hand merge (test files not counted). It does not mean the batch compiles.

| Batch | Title                                                                                                              | Commits | Mix              | Seq. apply: files applied / source files needing merge |
| ----- | ------------------------------------------------------------------------------------------------------------------ | ------- | ---------------- | ------------------------------------------------------ |
| B01   | Security quick wins (provider approvals, hooks, git prompts, stdout cap, env)                                      | 6       | PORT 6           | 17 / 1                                                 |
| B02   | Claude provider fixes (models, context meter, subagent cards, rewind, history)                                     | 26      | PORT 26          | 72 / 2                                                 |
| B03   | Claude background helpers and history performance (adapted)                                                        | 6       | ADAPT 6          | 16 / 6                                                 |
| B04   | Codex provider fixes                                                                                               | 9       | PORT 9           | 18 / 2                                                 |
| B05   | Codex Speed menu (protocol, adapted)                                                                               | 2       | ADAPT 2          | 11 / 4                                                 |
| B06   | OpenCode fixes                                                                                                     | 9       | PORT 6, ADAPT 3  | 28 / 6                                                 |
| B07   | Oh My Pi first-class provider plus OMP fixes                                                                       | 13      | ADAPT 6, PORT 7  | 69 / 5                                                 |
| B08   | Pi fixes                                                                                                           | 7       | PORT 6, ADAPT 1  | 30 / 0                                                 |
| B09   | ACP / Cursor / Copilot fixes                                                                                       | 11      | PORT 10, ADAPT 1 | 18 / 6                                                 |
| B10   | Provider catalog: pinned versions, artwork, search, toasts                                                         | 7       | PORT 5, ADAPT 2  | 41 / 16                                                |
| B11   | Per-provider default options in config (protocol/config, adapted)                                                  | 1       | ADAPT 1          | 21 / 9                                                 |
| B12   | Git, Changes and worktree correctness                                                                              | 24      | PORT 19, ADAPT 5 | 87 / 17                                                |
| B13   | File explorer and downloads                                                                                        | 8       | PORT 7, ADAPT 1  | 19 / 3                                                 |
| B14   | Daemon robustness and directory search                                                                             | 23      | PORT 21, ADAPT 2 | 43 / 10                                                |
| B15   | Daemon event-loop and memory performance (adapted)                                                                 | 9       | PORT 2, ADAPT 7  | 68 / 26                                                |
| B16   | CLI fixes                                                                                                          | 13      | PORT 12, ADAPT 1 | 17 / 12                                                |
| B17   | Terminal fixes (macOS editing keys, CJK/Korean, launch errors, MCP keys, xterm)                                    | 13      | PORT 11, ADAPT 2 | 37 / 5                                                 |
| B18   | Client/protocol robustness (upload wait, oversized messages, SDK send behaviour, host probe)                       | 5       | PORT 2, ADAPT 3  | 11 / 6                                                 |
| B19   | Plugin SDK parity, server side (0.11–0.14)                                                                         | 12      | PORT 8, ADAPT 4  | 53 / 19                                                |
| B20   | Plugin SDK parity, client side (ui entry, icons, translations, audio, Markdown)                                    | 8       | ADAPT 7, PORT 1  | 84 / 33                                                |
| B21   | Plugin registry, manifest metadata and overview sanitizing (adapted)                                               | 6       | ADAPT 6          | 26 / 9                                                 |
| B22   | Host confirmation for pairing links (security, adapted, ADR)                                                       | 1       | ADAPT 1          | 6 / 7                                                  |
| B23   | Agent-to-agent messaging redesign (sender identity, batching, steering default, persistent finish notifications)   | 10      | ADAPT 10         | 43 / 26                                                |
| B24   | Small chat and app fixes                                                                                           | 22      | PORT 22          | 48 / 12                                                |
| B25   | Highlighting and keyboard-layout fixes                                                                             | 10      | PORT 10          | 24 / 7                                                 |
| B26   | Desktop shell fixes (daemon status polling, Linux window, EPIPE, titlebar drag, Xcode editor)                      | 6       | PORT 4, ADAPT 2  | 26 / 9                                                 |
| B27   | Agentic browser: browser_type focus guard and zoomed capture (adapted)                                             | 2       | ADAPT 2          | 4 / 3                                                  |
| B28   | Voice fixes (local model reinstall, OpenAI-compatible TTS, Android dictation)                                      | 5       | PORT 4, ADAPT 1  | 33 / 1                                                 |
| B29   | Composer behaviour (draft commands, unsupported mode, focus on touch, recall, send shortcut, long-press send)      | 10      | ADAPT 10         | 18 / 18                                                |
| B30   | Workspace setup, scripts and tab-restore fixes (adapted)                                                           | 10      | ADAPT 10         | 32 / 28                                                |
| B31   | Idle agent runtime release (config, adapted)                                                                       | 1       | ADAPT 1          | 28 / 13                                                |
| B32   | Long-chat rendering and responsiveness fixes (adapted)                                                             | 11      | ADAPT 11         | 32 / 21                                                |
| B33   | Terminal image paste and file drop into agent TUIs (adapted)                                                       | 1       | ADAPT 1          | 25 / 6                                                 |
| B34   | Diff review: Send feedback, mobile comment sheets, All changes scope (adapted)                                     | 3       | ADAPT 3          | 30 / 13                                                |
| B35   | Assistant and Markdown-preview file/folder links                                                                   | 8       | ADAPT 8          | 27 / 8                                                 |
| B36   | Daemon config, schema and metadata generation                                                                      | 5       | ADAPT 5          | 16 / 3                                                 |
| B37   | Tool-call labels, subagent facts and lone tool calls                                                               | 5       | ADAPT 5          | 25 / 11                                                |
| B38   | Command Center ranking and status                                                                                  | 3       | ADAPT 3          | 14 / 9                                                 |
| B39   | Settings and UI polish (content width, live timestamps, i18n loading, settings navigation, combobox/tooltip fixes) | 12      | ADAPT 12         | 41 / 46                                                |
| B40   | Mobile and tablet fixes that fit the JAgentDesk mobile shell                                                       | 17      | ADAPT 17         | 56 / 22                                                |
| B41   | Native/build items (check the JAgentDesk Expo version first)                                                       | 6       | ADAPT 6          | 10 / 6                                                 |
| B42   | Remove the WebView terminal renderer                                                                               | 1       | ADAPT 1          | 14 / 4                                                 |

### B01: Security quick wins (provider approvals, hooks, git prompts, stdout cap, env)

**Upstream commits (in order):**

- `8cccc1f6f` #5758 [PORT] fix(codex): answer each approval callback that shares one item
- `e0a0cf990` #5801 [PORT] Ask OpenCode before running a Paseo tool
- `b1a3b0772` #5750 [PORT] fix(claude): skip user and project hooks for internal agents
- `694696e82` #8019 [PORT] fix(server): keep background Git fetches from opening login prompts
- `9c7d4ace6` #7960 [PORT] fix(server): reject oversized provider stdout before parsing
- `749fe3e5a` #5987 [PORT] fix(server): keep the local speech library path out of agent environments

**JAgentDesk files to touch** (8, paths rebranded): `srv:agent/providers/codex-app-server-agent.ts`, `srv:agent/providers/opencode/bridge-plugin.mjs`, `srv:agent/providers/claude/agent.ts`, `srv:workspace-git-fetch.ts`, `srv:agent/providers/codex/app-server-transport.ts`, `srv:agent/providers/jsonl-frame-decoder.ts`, `srv:agent/providers/jsonl-rpc-process.ts`, `packages/server/scripts/supervisor-entrypoint.ts`

**Needs hand merge (sequential apply):** `app-server-transport.ts` (9c7d4ace6)

**Verify:** Run the unit tests the upstream commits add (rebranded): `codex-app-server-agent` approval test, `opencode/bridge-plugin` ask-rule test, `claude/agent` internal-hooks test, `workspace-git-fetch.test.ts`, `jsonl-frame-decoder.test.ts`. Then `npm run typecheck:server`. Manual: a Codex agent that runs two commands in one item shows two permission cards.

**Notes:** The `app-server-transport.ts` hunk in `9c7d4ace6` needs a hand merge.

### B02: Claude provider fixes (models, context meter, subagent cards, rewind, history)

**Upstream commits (in order):**

- `d30e99c85` #5818 [PORT] Log why a resumed Claude agent has no history
- `cc8fe41e2` #4355 [PORT] Send display: summarized so Claude thinking renders
- `b3ed7363c` #6067 [PORT] fix(claude): keep a background subagent's card labeled after its child streams
- `36e6ccd6c` #6074 [PORT] fix(claude): show plan mode when Claude enters it on its own
- `da9fae172` #6100 [PORT] fix(claude): keep a subagent's card labeled after a daemon restart
- `05637a7f0` #6248 [PORT] Show a Claude subagent's auto-mode report as markdown instead of a raw SubagentHandback card
- `dc785bb29` #6268 [PORT] Keep both subagent cards labeled when Claude launches two background agents together
- `8f1091da6` #6272 [PORT] Let a Claude agent leave Auto mode when Claude Code uses Bedrock or Vertex
- `ee6deda07` #6301 [PORT] Show a Claude agent's history when its transcript is under another project folder
- `d46164ce0` #6308 [PORT] fix(claude): keep long-running tool calls out of the subagents track
- `9fcae41c9` #6332 [PORT] feat(claude): add Haiku 5.5 with its model capabilities
- `aec01ea60` #6403 [PORT] feat(claude): offer Mythos 5.1 when Claude Code advertises it
- `a2b040869` #6703 [PORT] fix(claude): count input reported late in the context meter
- `b923cde6c` #6767 [PORT] fix(claude): show custom model context limits during the first turn
- `0614e96ee` #6325 [PORT] fix(claude): rewind works when the provider sets CLAUDE_CONFIG_DIR
- `4d8bed9dd` #6814 [PORT] Keep Claude's context meter on the active model
- `0708b8295` #6930 [PORT] Preserve explicit Claude session names on import
- `71f575e16` #6936 [PORT] Keep malformed Claude question answers retryable
- `30122b1ae` #6242 [PORT] Show a background Claude subagent's action log on its card
- `88a7aec1b` #7179 [PORT] fix(claude): keep active turns running through settings changes
- `1b450e487` #7209 [PORT] fix(claude): don't treat a wrapper command's --version output as Claude Code's version
- `1a6a9fa8d` #7266 [PORT] fix(claude): keep background child action logs after the parent finishes
- `ab6cdb7c8` #7453 [PORT] fix(claude): return to Auto when approving a plan
- `ce67efa9e` #7590 [PORT] Keep Claude request context out of restored chats
- `4ef4a95a4` #7626 [PORT] Keep Claude session listing from loading whole histories into memory
- `48d2c9ec3` #7737 [PORT] Keep restored Claude background notifications from appearing twice

**JAgentDesk files to touch** (14, paths rebranded): `srv:agent/providers/claude/agent.ts`, `srv:agent/providers/claude/sidechain-tracker.ts`, `srv:agent/providers/claude/subagent-handback.ts`, `srv:agent/agent-stream-coalescer.ts`, `srv:agent/timeline-projection.ts`, `srv:agent/providers/claude/project-dir.ts`, `srv:agent/providers/claude/model-manifest.ts`, `srv:agent/providers/claude/model-discovery.ts`, `srv:agent/providers/claude/models.ts`, `srv:agent/providers/claude/rewind.ts`, `srv:agent/providers/claude/test-rewind-claude-sdk.ts`, `srv:agent/providers/claude/import-descriptor-scheduler.ts`, `srv:agent/providers/claude/task-notification-tool-call.ts`, `srv:agent/providers/claude/transcript-history.ts`

**Needs hand merge (sequential apply):** `agent.ts` (d30e99c85, da9fae172, 8f1091da6, ee6deda07, 0708b8295, 88a7aec1b, 4ef4a95a4); `transcript-history.ts` (48d2c9ec3)

**Verify:** Port each commit's `claude/*.test.ts`, then `vitest run src/server/agent/providers/claude`. Real-provider check: Haiku 5.5 and Mythos 5.1 appear in the model list with Claude Code ≥2.1.293; a background subagent card keeps its label after a daemon restart; rewind works with `CLAUDE_CONFIG_DIR` set.

**Notes:** `claude/agent.ts` hunks drift in 7 commits (X1 each), so apply one commit at a time in upstream order. `48d2c9ec3` adds `transcript-history.ts` (comes with B03 `173fca3c0`). Keep JAgentDesk skills-hub prompt injection intact.

### B03: Claude background helpers and history performance (adapted)

**Upstream commits (in order):**

- `8ddeb79c8` #6295 [ADAPT] Claude agents stay idle while background helpers work, and send or Stop no longer kills them
- `f3b0199c1` #7431 [ADAPT] Open large Claude histories without whole-transcript duplication
- `566218d68` #7789 [ADAPT] fix(claude): avoid probing file targets during history replay
- `173fca3c0` #7940 [ADAPT] Keep the daemon responsive during Claude history replay
- `64b0afe01` #7976 [ADAPT] fix(claude): identify SDK processes with the Paseo entrypoint
- `869eb5a72` #8164 [ADAPT] Make Claude session entrypoint relabeling optional

**JAgentDesk files to touch** (11, paths rebranded): `app:runtime/host-runtime.ts`, `srv:agent/providers/claude/agent.ts`, `srv:agent/providers/claude/subagents/live-source.ts`, `srv:agent/agent-timeline-content.ts`, `srv:agent/providers/claude/subagents/replay-source.ts`, `srv:agent/providers/claude/subagents/workflow-replay-source.ts`, `srv:agent/providers/claude/transcript-history.ts`, `srv:agent/providers/claude/project-dir.ts`, `srv:agent/providers/claude/rewind.ts`, `srv:agent/providers/claude/task-notification-tool-call.ts`, `srv:agent/providers/claude/query.ts`

**Needs hand merge (sequential apply):** `host-runtime.ts` (8ddeb79c8); `agent.ts` (8ddeb79c8, f3b0199c1, 566218d68, 173fca3c0); `live-source.ts` (8ddeb79c8); `agent-timeline-content.ts` (f3b0199c1); `replay-source.ts` (f3b0199c1, 173fca3c0); `transcript-history.ts` (173fca3c0)

**Verify:** Upstream tests: `claude/subagents/*.test.ts`, `replay-memory.fixture`. Measure daemon RSS and event-loop delay while opening a large (>50 MB) Claude transcript before and after. Team mode lead with background agents: Stop does not kill the helpers.

**Notes:** `8ddeb79c8` also touches `app:runtime/host-runtime.ts` (JAgentDesk Tailscale runtime): merge only the subagent-status bits. `64b0afe01`+`869eb5a72`: port the net effect (clear the inherited entrypoint). The opt-in label needs B19 `8a542048b`.

### B04: Codex provider fixes

**Upstream commits (in order):**

- `aff476b01` #5669 [PORT] fix(codex): insert custom prompt arguments literally
- `23c4404b9` #5684 [PORT] fix(codex): keep output schema fields named like schema keywords
- `a8f5d969b` #5686 [PORT] fix(codex): keep the default effort after a daemon restart
- `767b0e970` #5711 [PORT] Rewind legacy Codex threads on Codex versions without thread/rollback
- `53ee9cd99` #5717 [PORT] fix(codex): settle declined commands and file edits as failed
- `7a64eef49` #5774 [PORT] Show the command on Codex terminal rows
- `b701cb2dc` #5810 [PORT] Show failed Codex image generations in the chat
- `335a11eb8` #5999 [PORT] Reopen Codex chats containing U+2028 or U+2029 on Node 24
- `08853039f` #7339 [PORT] fix(server): keep resumed goal turns visible and stoppable

**JAgentDesk files to touch** (6, paths rebranded): `srv:agent/providers/codex-app-server-agent.ts`, `srv:agent/providers/codex/rewind.ts`, `srv:agent/providers/tool-call-mapper-utils.ts`, `srv:agent/providers/codex/tool-call-mapper.ts`, `srv:agent/providers/codex/app-server-transport.ts`, `srv:agent/agent-manager.ts`

**Needs hand merge (sequential apply):** `codex-app-server-agent.ts` (a8f5d969b, 767b0e970, 08853039f); `app-server-transport.ts` (335a11eb8)

**Verify:** `vitest run src/server/agent/providers/codex`. The rebranded fake-app-server tests come with the commits.

**Notes:** 3 hunks in `codex-app-server-agent.ts` drift (custom-provider work from v0.9.44).

### B05: Codex Speed menu (protocol, adapted)

**Upstream commits (in order):**

- `60aff2346` #5708 [ADAPT] Support catalog-driven Codex Fast and Ultrafast speeds
- `2f0cb2f54` #6152 [ADAPT] Show the Codex speed bolt in yellow while Fast or Ultrafast is selected

**JAgentDesk files to touch** (8, paths rebranded): `app:composer/agent-controls/index.tsx`, `proto:agent-types.ts`, `proto:messages.ts`, `srv:agent/agent-sdk-types.ts`, `srv:agent/providers/codex-app-server-agent.ts`, `srv:agent/providers/codex-feature-definitions.ts`, `app:agent-controls/policy.ts`, `app:composer/agent-controls/utils.ts`

**Needs hand merge (sequential apply):** `agent-sdk-types.ts` (60aff2346); `codex-app-server-agent.ts` (60aff2346); `codex-feature-definitions.ts` (60aff2346); `index.tsx` (2f0cb2f54)

**Verify:** Protocol round-trip test: an old client sending `fast: true` gets speed=fast. App: bolt menu on desktop, yellow while Fast or Ultrafast is selected.

**Notes:** Rewrite `codex-feature-definitions.ts` against JAgentDesk's current Fast definitions. ClickUp composer toolbar styling.

### B06: OpenCode fixes

**Upstream commits (in order):**

- `d517b3314` #5873 [PORT] fix(opencode): wait for the server to listen before opening the event stream
- `7a3030550` #6177 [PORT] fix(opencode): agent goes idle after a v2 question is dismissed
- `e3db7c339` #6188 [ADAPT] fix(opencode): agent goes idle after a v2 tool permission is denied
- `99fc204c5` #6330 [PORT] fix(opencode): browser screenshots reach OpenCode v2 agents
- `d0728cd1e` #6519 [PORT] fix(opencode): preserve tool validation errors in v2
- `d172d060a` #6262 [PORT] server: keep streamed OpenCode v2 chunks from holding their whole message
- `72e3316f4` #7799 [PORT] fix(opencode): show model details on v2 subagent rows
- `30799fda1` #7183 [ADAPT] Return actionable errors to OpenCode agents for invalid tool calls
- `91154ba4e` #7383 [ADAPT] fix(opencode): advertise agent-scoped bridge tool schemas

**JAgentDesk files to touch** (17, paths rebranded): `srv:agent/providers/opencode-agent.ts`, `srv:agent/providers/opencode/event-consumer.ts`, `srv:agent/providers/opencode/server-manager.ts`, `srv:agent/providers/opencode/v2/permissions.ts`, `srv:agent/providers/opencode/v2/session.ts`, `srv:agent/providers/opencode/v2/turns.ts`, `srv:agent/providers/opencode/v2/bridge-plugin.mjs`, `srv:agent/providers/opencode/v2/timeline.ts`, `srv:agent/providers/opencode/v2/children.ts`, `srv:agent/agent-loading.ts`, `srv:agent/providers/opencode/bridge-plugin.mjs`, `srv:agent/providers/opencode/bridge.ts`, `srv:agent/tools/jagentdesk-tools.ts`, `srv:agent/tools/types.ts`, `srv:schedule/service.ts`, `srv:agent/provider-runtime.ts`, `srv:bootstrap.ts`

**Needs hand merge (sequential apply):** `server-manager.ts` (d517b3314); `children.ts` (72e3316f4); `paseo-tools.ts` (30799fda1, 91154ba4e); `types.ts` (30799fda1); `service.ts` (30799fda1); `bootstrap.ts` (91154ba4e)

**Verify:** `vitest run src/server/agent/providers/opencode` (v2 harness). Real OpenCode ≥1.17: a dismissed question or denied permission leaves the agent idle; browser screenshots reach v2 agents.

**Notes:** `30799fda1` and `91154ba4e` touch `jagentdesk-tools.ts`, `bootstrap.ts` and `schedule/service.ts`. `91154ba4e` must respect spec 24.5 host-capability tool gating.

### B07: Oh My Pi first-class provider plus OMP fixes

**Upstream commits (in order):**

- `264f6e1cc` #5550 [ADAPT] feat(omp): make OMP a first-class provider
- `0d05584d0` #5985 [PORT] fix(omp): open agent history that contains a failed browser tool call
- `97083dd73` #6061 [ADAPT] fix(pi,omp): open sessions whose model was removed
- `1f8a4559a` #6090 [ADAPT] fix(providers): show custom context in expandable tool rows
- `8ced059b4` #6110 [PORT] fix(omp): fail the turn when OMP rejects a prompt before its agent runs
- `dfb8a1a2b` #6112 [PORT] fix(omp): an OMP run with a message Paseo does not render now finishes instead of staying running
- `62f79e88b` #6115 [PORT] fix(omp): a prompt OMP 18.3 rejects after acknowledging it now fails with OMP's error
- `2dbfd1e0f` #6198 [PORT] fix(omp): reopened chats no longer show extra "Custom message" rows
- `f5c55dfc5` #6215 [PORT] fix(omp): reopened chats show a compaction row instead of "Unsupported history record"
- `4a3ff87ee` #6106 [PORT] fix(omp): show manual /compact progress and refresh the context meter
- `80badb3b8` #6149 [ADAPT] fix(opencode): answer multi-select v2 questions from the question card
- `cd77ecd83` #7169 [ADAPT] Start idle OMP agents when they receive follow-ups
- `8d971876b` #7948 [ADAPT] fix(omp): keep transcript replay responsive

**JAgentDesk files to touch** (26, paths rebranded): `srv:agent/providers/omp/agent.ts`, `srv:agent/providers/omp/cli-runtime.ts`, `srv:agent/providers/omp/custom-message.ts`, `srv:agent/providers/omp/history.ts`, `srv:agent/providers/omp/host-tools.ts`, `srv:agent/providers/omp/map-omp-model.ts`, `srv:agent/providers/omp/mcp-bridge.ts`, `srv:agent/providers/omp/message-history.ts`, `srv:agent/providers/omp/provider-config.ts`, `srv:agent/providers/omp/question-ui.ts`, `srv:agent/providers/omp/rpc-types.ts`, `srv:agent/providers/omp/runtime.ts`, `srv:agent/providers/omp/session-descriptor.ts`, `srv:agent/providers/omp/todo-mapper.ts`, `srv:agent/providers/omp/tool-call-detail.ts`, `srv:agent/providers/omp/tool-call-mapper.ts`, `srv:agent/providers/pi/agent.ts`, `srv:agent/agent-timeline-content.ts`, `srv:agent/providers/custom-message.ts`, `srv:agent/providers/pi/history-mapper.ts`, `srv:agent/providers/jsonl-rpc-process.ts`, `srv:agent/providers/omp/usage-poller.ts`, `srv:agent/providers/opencode/v2/permissions.ts`, `srv:agent/providers/question-card-answer.ts`, `srv:agent/agent-manager.ts`, `packages/server/package.json`

**Needs hand merge (sequential apply):** `agent.ts` (264f6e1cc, 97083dd73, 97083dd73, 1f8a4559a, 1f8a4559a, 8ced059b4, 62f79e88b, 4a3ff87ee, cd77ecd83); `cli-runtime.ts` (62f79e88b); `agent-manager.ts` (cd77ecd83); `runtime.ts` (cd77ecd83); `package.json` (8d971876b)

**Verify:** `vitest run src/server/agent/providers/omp` (fake-omp harness). Real OMP: MCP servers reach OMP, multi-select questions, `/compact` progress.

**Notes:** `264f6e1cc` first (18/19 files apply). `omp/agent.ts` then needs hand merges for 8 follow-ups. `cd77ecd83` touches `agent-manager.ts`.

### B08: Pi fixes

**Upstream commits (in order):**

- `e9e479c6b` #5755 [PORT] fix(pi): stream running subagent transcripts
- `4417d7c47` #5762 [ADAPT] fix(pi): give Pi's built-in MCP the agent's MCP servers
- `06213e49b` #5826 [PORT] Complete every Tintinweb subagent in a grouped completion
- `bfe38d92f` #6594 [PORT] fix(pi): mark turn-limited tintinweb subagents as completed
- `196dc3acd` #6741 [PORT] fix(pi): update thinking levels when extensions change them
- `dd244c076` #7369 [PORT] fix(pi): remove running rows for refused subagent resumes
- `e3bbed3c7` #7848 [PORT] fix(pi): queue prompts until manual compaction finishes

**JAgentDesk files to touch** (10, paths rebranded): `srv:agent/providers/pi/agent.ts`, `srv:agent/providers/pi/extensions/child-session.ts`, `srv:agent/providers/pi/extensions/contract.ts`, `srv:agent/providers/pi/extensions/gotgenes-pi-subagents/index.ts`, `srv:agent/providers/pi/extensions/gotgenes-pi-subagents/runtime-bridge.ts`, `srv:agent/providers/pi/extensions/host.ts`, `srv:agent/providers/pi/extensions/index.ts`, `srv:agent/providers/pi/extensions/pi-subagents/index.ts`, `srv:agent/providers/pi/extensions/tintinweb-pi-subagents/index.ts`, `srv:agent/providers/pi/rpc-types.ts`

**Sequential apply:** every source file applied cleanly.

**Verify:** `vitest run src/server/agent/providers/pi`.

**Notes:** All source files applied cleanly in sequence. `4417d7c47`: check that JAgentDesk MCP servers (skills, browser, ORC) reach Pi's built-in MCP.

### B09: ACP / Cursor / Copilot fixes

**Upstream commits (in order):**

- `d070db15b` #5765 [PORT] fix(acp): report the agent's error when session setup is rejected
- `48329facc` #4848 [PORT] fix(acp): surface context-window usage from the ACP usage_update notification
- `218712464` #6045 [PORT] Answer an ACP agent's open permission request when its turn fails
- `a700d7875` #6213 [PORT] Stop the provider when archiving an ACP agent that never answers close
- `a9fef4879` #6228 [PORT] Show an archived ACP agent's history after its worktree is removed
- `a162e1075` #6273 [PORT] fix(acp): apply configured models the agent does not advertise
- `058375dac` #6766 [PORT] fix(server): release ACP provider process after history resume
- `4d5c3c13d` #6920 [PORT] fix(acp): preserve slash command argument hints
- `4f9d9d6de` #7953 [PORT] Keep ACP terminal output from stalling daemon requests
- `86ab49153` #7234 [PORT] Let Copilot implement plans after selecting Allow All
- `64693f21c` #6353 [ADAPT] fix(cursor): show plan usage in Cursor agents' context details

**JAgentDesk files to touch** (6, paths rebranded): `srv:agent/providers/acp-agent.ts`, `srv:agent/agent-sdk-types.ts`, `srv:agent/provider-registry.ts`, `srv:agent/providers/copilot-acp-agent.ts`, `srv:agent/providers/cursor-acp-agent.ts`, `srv:agent/providers/generic-acp-agent.ts`

**Needs hand merge (sequential apply):** `acp-agent.ts` (a700d7875, a9fef4879, a162e1075, 64693f21c); `provider-registry.ts` (a162e1075); `cursor-acp-agent.ts` (64693f21c); `generic-acp-agent.ts` (64693f21c); `index.server.ts` (64693f21c); `usage.ts` (64693f21c)

**Verify:** `vitest run src/server/agent/providers/acp-agent.test.ts generic-acp-agent.test.ts copilot`.

**Notes:** Leave out `plugins/cursor-usage-source/*` from `64693f21c` (Usage epic). `acp-agent.ts` drift in 4 commits.

### B10: Provider catalog: pinned versions, artwork, search, toasts

**Upstream commits (in order):**

- `a54cc6dd1` #7781 [PORT] chore(acp): refresh pinned provider packages
- `7c7b6555f` #7330 [PORT] Show provider artwork in the catalog and provider rows
- `16bb179e6` #6953 [ADAPT] feat(providers): add opt-in Hoplite and searchable provider grid
- `2d86b94b2` #7030 [ADAPT] Refine provider catalog buttons and show Add errors as toasts
- `e8108d909` #6568 [PORT] fix(app): only offer Remove for providers defined in config.json
- `ada7ba43f` #6507 [PORT] Keep long custom models removable in provider settings
- `90fcf51d7` #6938 [PORT] Render the Antigravity icon for terminal profiles

**JAgentDesk files to touch** (30, paths rebranded): `app:data/acp-provider-catalog.ts`, `app:assets/acp-provider-icons.ts`, `app:assets/acp-provider-icons/devin.svg`, `app:assets/acp-provider-icons/grok.svg`, `app:assets/acp-provider-icons/hermes.svg`, `app:assets/acp-provider-icons/kiro.svg`, `app:assets/acp-provider-icons/minimax-code.svg`, `app:assets/acp-provider-icons/traecli.svg`, `app:components/icons/antigravity-icon.tsx`, `app:components/icons/kiro-icon.tsx`, `app:components/provider-icons.ts`, `proto:provider-icon-names.ts`, `app:assets/acp-provider-icons/hoplite.svg`, `app:components/provider-catalog-list.tsx`, `app:components/provider-catalog-search.ts`, `app:hooks/use-acp-provider-catalog.ts`, `app:screens/settings/providers-section.tsx`, `plugin:server/acp-internal/connection.ts`, `plugin:server/provider.ts`, `proto:messages.ts`, `srv:agent/plugin-provider.ts`, `srv:agent/provider-registry.ts`, `srv:agent/provider-snapshot-manager.ts`, `srv:plugins/builtin/index.ts`, `srv:plugins/index.ts`, `srv:plugins/plugin-process-protocol.ts`, `srv:plugins/plugin-process.ts`, `srv:websocket-server.ts`, `.gitignore`, `app:components/provider-diagnostic-sheet.tsx` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `provider-icons.ts` (7c7b6555f, 90fcf51d7); `provider-icon-names.ts` (7c7b6555f); `provider-catalog-list.tsx` (16bb179e6, 2d86b94b2); `providers-section.tsx` (16bb179e6, 2d86b94b2); `provider.ts` (16bb179e6); `messages.ts` (16bb179e6); `plugin-provider.ts` (16bb179e6); `provider-registry.ts` (16bb179e6); `provider-snapshot-manager.ts` (16bb179e6); `index.ts` (16bb179e6, 16bb179e6); `plugin-process-protocol.ts` (16bb179e6); `plugin-process.ts` (16bb179e6); `websocket-server.ts` (16bb179e6); `vitest.config.ts` (16bb179e6); `.gitignore` (e8108d909); `provider-diagnostic-sheet.tsx` (ada7ba43f)

**Verify:** App: Settings → Providers → Add provider lets you search and shows the new icons; a failed Add shows a toast.

**Notes:** Take only the catalog, search and icon parts of `16bb179e6`. Drop the Hoplite plugin provider and the `plugin-provider.ts`/`builtin` edits. The settings screen is the JAgentDesk layout.

### B11: Per-provider default options in config (protocol/config, adapted)

**Upstream commits (in order):**

- `29c198f95` #5780 [ADAPT] fix(providers): apply configured options to every agent provider

**JAgentDesk files to touch** (26, paths rebranded): `plugin:server/provider.ts`, `proto:agent-types.ts`, `proto:messages.ts`, `proto:provider-config.ts`, `proto:schedule/types.ts`, `srv:agent/agent-configuration-validator.ts`, `srv:agent/agent-manager.ts`, `srv:agent/agent-sdk-types.ts`, `srv:agent/agent-storage.ts`, `srv:agent/plugin-provider.ts`, `srv:agent/provider-options.ts`, `srv:agent/provider-registry.ts`, `srv:agent/provider-snapshot-manager.ts`, `srv:agent/providers/acp-agent.ts`, `srv:agent/providers/acp-options.ts`, `srv:agent/providers/claude/agent.ts`, `srv:agent/providers/codex-app-server-agent.ts`, `srv:agent/providers/cursor-acp-agent.ts`, `srv:agent/providers/generic-acp-agent.ts`, `srv:agent/providers/kimi-acp-agent.ts`, `srv:agent/providers/kiro-acp-agent.ts`, `srv:agent/providers/omp/agent.ts`, `srv:agent/providers/omp/provider-config.ts`, `srv:agent/providers/opencode-agent.ts`, `srv:agent/providers/pi/agent.ts`, `srv:agent/providers/trae-acp-agent.ts`

**Needs hand merge (sequential apply):** `messages.ts` (29c198f95); `types.ts` (29c198f95); `agent-manager.ts` (29c198f95); `agent-sdk-types.ts` (29c198f95); `plugin-provider.ts` (29c198f95); `provider-registry.ts` (29c198f95); `acp-agent.ts` (29c198f95); `codex-app-server-agent.ts` (29c198f95); `agent.ts` (29c198f95)

**Verify:** Config round-trip: `agents.providers.claude.options` applies to a new agent and is overridden per agent; JAgentDesk schema validation accepts it.

**Notes:** Drop the plugin-provider part. Touches most provider adapters, so run it after B02–B09.

### B12: Git, Changes and worktree correctness

**Upstream commits (in order):**

- `4b45bc9fc` #5694 [PORT] fix: restore archived workspaces without recorded branches
- `a7c9c05be` #5788 [ADAPT] Start new workspaces off origin/main at the remote tip
- `bd78e5efa` #6462 [PORT] Show committed changes for existing-branch worktrees
- `e61009d5f` #6536 [PORT] fix(server): display diffs with custom Git presentation settings
- `dd0350bc2` #6559 [PORT] Show actual edits when a file is renamed in Changes
- `a5dba3c99` #6562 [PORT] Show checkout patch lines with external Git diff commands configured
- `a3f75aa9e` #6569 [PORT] Show removed SQL comments in Git diffs
- `938c4e263` #6583 [PORT] Show Git diffs for filenames with quotes and control characters
- `9b92b2e25` #6668 [PORT] Preserve base worktree paths when merging
- `9246813fd` #6686 [PORT] Preserve spaces in project folder names for Changes and worktrees
- `4400445ed` #6785 [PORT] Allow worktree creation after Git initialization
- `5805b776c` #6801 [PORT] fix(git): open commit diffs from subdirectory workspaces
- `6d43a8c5b` #6777 [PORT] Restore selected changes from subdirectory workspaces
- `8ff2424da` #6882 [PORT] Return checkout diff hunks from subdirectory workspaces
- `5c108f345` #6895 [PORT] Preserve renames in committed file diffs
- `06f052225` #6545 [ADAPT] fix(server): invalidate worktree listings after archive
- `1228c01a1` #6525 [PORT] Find GitLab merge requests and issues by number
- `cfb18f16d` #6558 [PORT] fix(app): find starting refs by change request descriptions
- `0ed57187a` #6829 [ADAPT] Keep fork owners in Gitea and Forgejo checkout names
- `be0acb293` #6745 [PORT] fix(app): keep Diff updates alive after the first edit
- `42e221746` #5968 [PORT] fix(app): render linked pictures in PR markdown
- `9be154774` #7355 [PORT] fix(app): show a promoted git action once in the compact menu
- `3c3c27292` #7681 [ADAPT] fix(server): publish workspace snapshots without UI subscribers
- `91d749f82` #7638 [ADAPT] fix(server): preserve workspace PR status across reconnects

**JAgentDesk files to touch** (35, paths rebranded): `app:screens/workspace/workspace-route-state-views.tsx`, `srv:resolve-worktree-creation-intent.ts`, `srv:session/workspace-recovery/workspace-recovery-service.ts`, `srvsrc:utils/worktree.ts`, `srvsrc:utils/checkout-git.ts`, `srv:utils/diff-highlighter.ts`, `packages/server/package.json`, `srvsrc:utils/git-quoted-path.ts`, `app:utils/workspace-identity.ts`, `srvsrc:utils/git-rev-parse-path.ts`, `srv:workspace-git-service.ts`, `srv:agent/tools/jagentdesk-tools.ts`, `srv:websocket-server.ts`, `srv:workspace-archive-service.ts`, `srv:worktree-session.ts`, `srv:worktree/commands.ts`, `srvsrc:services/gitlab-service.ts`, `app:components/ui/combobox-options.ts`, `app:screens/new-workspace-picker-item.ts`, `srvsrc:services/forge-service.ts`, `srvsrc:services/gitea-service.ts`, `srvsrc:services/github-service.ts`, `srvsrc:utils/change-request-checkout.ts`, `app:data/push-router.ts`, `app:components/markdown/html-ish.ts`, `app:command-center/workspace-contributions.ts`, `app:git/actions-split-button.tsx`, `app:git/policy.ts`, `srv:bootstrap.ts`, `srv:checkout-diff-manager.ts` … +5 (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `worktree.ts` (4b45bc9fc, a7c9c05be, bd78e5efa); `package.json` (938c4e263, 9b92b2e25, 8ff2424da); `diff-highlighter.ts` (938c4e263); `workspace-archive-service.ts` (06f052225); `new-workspace-picker-item.ts` (cfb18f16d); `resolve-worktree-creation-intent.ts` (0ed57187a); `github-service.ts` (0ed57187a); `workspace-contributions.ts` (9be154774); `actions-split-button.tsx` (9be154774); `workspace-git-service.ts` (3c3c27292); `bootstrap.ts` (91d749f82); `checkout-diff-manager.ts` (91d749f82); `session.ts` (91d749f82); `workspace-provisioning-service.ts` (91d749f82); `workspace-scripts-service.ts` (91d749f82); `websocket-server.ts` (91d749f82); `workspace-registry.ts` (91d749f82)

**Verify:** Port the upstream `checkout-git` tests (`git-filename-diffs.e2e.test.ts`, rename and subdirectory cases). Manual: rename+edit in Changes, a subdirectory workspace, a folder name with a trailing space.

**Notes:** `utils/worktree.ts` hunks (3 commits), `91d749f82` session/bootstrap wiring and `0ed57187a` forge/github-service need hand merges. Retest Forge Hub PR flows.

### B13: File explorer and downloads

**Upstream commits (in order):**

- `1e00f452e` #6278 [PORT] Download files whose names have non-ASCII characters
- `f13bb2136` #6281 [PORT] fix(server): keep accented names on downloaded files
- `46b128417` #6567 [PORT] Release files when HTTP downloads are canceled
- `804335bc0` #6573 [PORT] fix(files): rename untracked bracket paths without matching siblings
- `114389383` #6604 [PORT] Keep files starting with two dots usable
- `a310444c6` #6658 [PORT] fix: save workspace files with long valid names
- `337e81a9c` #6771 [PORT] fix(files): preserve relative symlinks when duplicating entries
- `56448842f` #6595 [ADAPT] Download files over the connected host

**JAgentDesk files to touch** (8, paths rebranded): `srv:bootstrap.ts`, `srv:file-download/content-disposition.ts`, `packages/server/package.json`, `srv:file-explorer/service.ts`, `app:hooks/use-file-download.ts`, `app:hooks/use-file-explorer-actions.ts`, `app:stores/download-store.ts`, `client:daemon-client.ts`

**Needs hand merge (sequential apply):** `package.json` (46b128417, 114389383); `use-file-explorer-actions.ts` (56448842f); `daemon-client.ts` (56448842f)

**Verify:** `vitest run src/server/file-explorer`. Download a file with a non-ASCII or accented name over the tailnet connection.

**Notes:** `56448842f` changes the download path to go through the connected host. Check that the JAgentDesk tailnet `daemon-client` supports the new RPC.

### B14: Daemon robustness and directory search

**Upstream commits (in order):**

- `087cc71c0` #5922 [PORT] fix(server): use macOS ComputerName for host identity
- `9da676d70` #6117 [PORT] Keep the daemon running when nobody reads its output
- `2323ee684` #6279 [PORT] Keep reporting a Linux daemon as running after its VM resumes from a host sleep
- `2ecf3ba78` #6255 [PORT] Keep an archived agent archived when a send to it fails
- `5c2c85ebc` #5140 [PORT] fix(server): resume with last live mode, not creation-time mode
- `23c4df481` #7573 [PORT] Fix agents showing running after daemon restart
- `29db2b798` #6379 [ADAPT] Keep created agents after first-prompt failures and bound fork history
- `bd9af256b` #6023 [PORT] Keep a symlinked config.json linked when Paseo saves it
- `28834a91a` #7955 [PORT] fix(server): tolerate brief Windows atomic replace failures
- `a8deb5108` [PORT] fix(server): keep provider images separate from adjacent prose
- `7e66657bf` #6546 [PORT] fix(agent): preserve reasoning order in activity transcripts
- `409b8f931` #6036 [PORT] fix(server): keep a new worktree open when its paseo.json cannot be parsed
- `045898882` #6638 [PORT] Connect the self-hosted web app through standard-port proxies
- `d57096a45` #6542 [PORT] Start newly configured workspace services without restarting
- `b0f054de9` #6753 [PORT] Reach IPv6-only workspace services through their proxy URLs
- `0fc6bf0c9` #6334 [PORT] fix(schedule): keep firing after a run that could not be recorded
- `ee0d901ef` #6532 [PORT] Run each scheduled slot once without skipping the next occurrence
- `ed48655a7` #6029 [PORT] fix(server): stop directory search from taking every filesystem thread
- `5285b7e50` #6041 [PORT] fix(server): keep a stuck directory search from blocking every other search
- `a7a21d91c` #7265 [PORT] Keep overlapping directory searches from exhausting the heap
- `06fe97c90` #5789 [ADAPT] fix(server): keep home directory search out of ~/Library on macOS
- `b3693b79d` #6641 [PORT] Find hidden agent plan files in workspace suggestions
- `6f62125ee` #6720 [PORT] fix: return dot-prefixed paths in workspace suggestions

**JAgentDesk files to touch** (26, paths rebranded): `srv:bootstrap.ts`, `srv:host-name.ts`, `srv:pid-lock.ts`, `srv:websocket-server.ts`, `packages/server/scripts/supervisor.ts`, `srv:agent/agent-prompt.ts`, `srv:agent/agent-manager.ts`, `srv:persistence-hooks.ts`, `srv:agent/providers/claude/agent.ts`, `packages/server/package.json`, `srv:agent/activity-curator.ts`, `srv:agent/create-agent/create.ts`, `srv:creation/index.ts`, `srv:session.ts`, `srv:private-files.ts`, `srv:atomic-file.ts`, `srv:agent/providers/provider-image-output.ts`, `srv:worktree-session.ts`, `srv:web-ui.ts`, `srv:workspace-service-port-registry.ts`, `srv:local-service-connection.ts`, `srv:script-health-monitor.ts`, `srv:service-proxy.ts`, `srv:schedule/service.ts`, `srvsrc:utils/directory-suggestions.ts`, `srvsrc:utils/path.ts`

**Needs hand merge (sequential apply):** `bootstrap.ts` (087cc71c0, 23c4df481); `pid-lock.ts` (087cc71c0, 2323ee684); `websocket-server.ts` (087cc71c0); `persistence-hooks.ts` (5c2c85ebc); `package.json` (29db2b798); `agent-manager.ts` (29db2b798); `index.ts` (29db2b798); `session.ts` (29db2b798, 409b8f931, 06fe97c90); `directory-suggestions.ts` (ed48655a7, 5285b7e50, a7a21d91c, 06fe97c90); `path.ts` (6f62125ee)

**Verify:** Upstream tests for `directory-suggestions`, `pid-lock`, `atomic-file`, `schedule/service`. Kill the app while the daemon writes logs; the daemon survives. Add Project search over `$HOME` on macOS stays responsive.

**Notes:** `087cc71c0` (ComputerName) touches `bootstrap.ts`/`pid-lock.ts`/`websocket-server.ts`. Check against the Tailscale host labelling. The 4 directory-search commits must be applied in order.

### B15: Daemon event-loop and memory performance (adapted)

**Upstream commits (in order):**

- `a25f4f506` #7958 [PORT] perf(server): serve timeline pages from retained projection
- `df82edd21` #6847 [PORT] Split the inbound WebSocket validator per message type
- `6077bc621` #7945 [ADAPT] Keep daemon diff highlighting responsive and bounded
- `9bc998fa3` #7943 [ADAPT] fix(server): keep Git observation and worktree IO off the event loop
- `67a245925` #7944 [ADAPT] fix(server): keep project config work off the daemon hot path
- `fc0cbbb32` #7941 [ADAPT] fix(server): keep workspace reconciliation responsive on slow paths
- `f14a4cc11` #7959 [ADAPT] fix(server): keep password-protected config reload responsive
- `9e4aab16c` #7967 [ADAPT] fix(server): keep the daemon responsive during plugin builds
- `2ce6681d6` #7954 [ADAPT] Keep image attachments responsive during prompts and replay

**JAgentDesk files to touch** (58, paths rebranded): `srv:agent/agent-timeline-store.ts`, `srv:agent/timeline-projection.ts`, `srv:session.ts`, `.gitignore`, `packages/protocol/codegen/ws-outbound.compile.ts`, `packages/protocol/scripts/generate-validation-aot.mjs`, `proto:validation/ws-outbound-envelope.ts`, `proto:validation/ws-outbound-schema-metadata.ts`, `proto:validation/ws-outbound.ts`, `hl:budgeted-highlighter.ts`, `hl:index.ts`, `srv:checkout-diff-cache.ts`, `srv:session/checkout/checkout-session.ts`, `srv:utils/diff-highlighter.ts`, `srv:workspace-git-service.ts`, `srvsrc:utils/checkout-git.ts`, `srv:git-observation-paths.ts`, `srv:jagentdesk-worktree-service.ts`, `srv:workspace-registry-bootstrap.ts`, `srvsrc:utils/path.ts`, `srvsrc:utils/run-git-command.ts`, `srvsrc:utils/worktree-metadata.ts`, `srvsrc:utils/worktree.ts`, `srv:script-status-projection.ts`, `srv:session/project-config/project-config-session.ts`, `srv:session/workspace-scripts/workspace-scripts-service.ts`, `srv:worktree-bootstrap.ts`, `srv:worktree-session.ts`, `srvsrc:utils/build-metadata-prompt.ts`, `srvsrc:utils/jagentdesk-config-file.ts` … +28

**Needs hand merge (sequential apply):** `session.ts` (a25f4f506, 67a245925, f14a4cc11); `checkout-diff-cache.ts` (6077bc621); `diff-highlighter.ts` (6077bc621); `checkout-git.ts` (6077bc621, 9bc998fa3); `workspace-registry-bootstrap.ts` (9bc998fa3); `path.ts` (9bc998fa3); `worktree-metadata.ts` (9bc998fa3); `worktree.ts` (9bc998fa3, 67a245925); `workspace-scripts-service.ts` (67a245925, f14a4cc11); `worktree-bootstrap.ts` (67a245925); `worktree-session.ts` (67a245925); `paseo-config-file.ts` (67a245925); `workspace-reconciliation-service.ts` (fc0cbbb32); `workspace-registry.ts` (fc0cbbb32); `bootstrap.ts` (f14a4cc11); `config.ts` (f14a4cc11); `daemon-config-store.ts` (f14a4cc11); `selection-store.ts` (f14a4cc11); `persisted-config.ts` (f14a4cc11); `index.ts` (f14a4cc11); `daemon-session.ts` (f14a4cc11); `compiler.ts` (9e4aab16c); `runtime.ts` (9e4aab16c); `agent.ts` (2ce6681d6, 2ce6681d6); `replay-source.ts` (2ce6681d6); `codex-app-server-agent.ts` (2ce6681d6)

**Verify:** Use the upstream responsiveness probes (`test-utils/main-thread-work.ts`, `compile-responsiveness.e2e.ts`) as harnesses. Before/after on JAgentDesk: event-loop p99 while opening a big workspace, building a plugin and replaying a Claude history.

**Notes:** Heavy hand-merge in `session.ts` (3), `checkout-git.ts`, `worktree.ts` and the config store. `f14a4cc11` touches `orchestration-skills/` (absent in JAgentDesk), so skip that file.

### B16: CLI fixes

**Upstream commits (in order):**

- `5599f9e56` #5727 [PORT] fix(cli): fail agent open for an agent the daemon does not have
- `4869214bc` #6009 [PORT] fix(cli): confirm daemon restart when provider probes are slow
- `8216e86ec` #6027 [PORT] fix(cli): delete archived agents with agent delete --all and --cwd
- `05b074764` #6053 [PORT] fix(cli): report an unknown agent ID as AGENT_NOT_FOUND
- `f24bb523e` #6097 [PORT] Exit CLI commands quietly when their output is no longer read
- `15d8ba16a` #5973 [PORT] fix(cli): handle negated schedule limit flags
- `0147edaaa` #6467 [PORT] Restore repository selection for CLI worktree commands
- `0ba4d2526` #6514 [PORT] Honor timestamps when reading and following agent logs
- `d5513472e` #6528 [PORT] Keep words intact in followed agent logs
- `a4b15455b` #6033 [PORT] fix(cli): list every agent in paseo agent ls, past the first 200
- `18eabeeda` #7535 [PORT] Archive agents beyond the first directory page
- `a292b402c` #6239 [PORT] Resolve local plugin directories in the CLI's working directory
- `8d9e7d3ad` #6607 [ADAPT] Confirm remote permission approvals before reporting success

**JAgentDesk files to touch** (22, paths rebranded): `cli:commands/agent/open.ts`, `cli:commands/daemon/restart.ts`, `cli:commands/agent/delete.ts`, `srv:session.ts`, `cli:commands/agent/attach.ts`, `cli:commands/agent/logs.ts`, `cli:run.ts`, `cli:utils/wait-for-stop.ts`, `packages/cli/tests/helpers/test-daemon.ts`, `cli:commands/schedule/update.ts`, `cli:commands/worktree/archive.ts`, `cli:commands/worktree/index.ts`, `cli:commands/worktree/ls.ts`, `cli:commands/worktree/repository-directory.ts`, `cli:utils/timeline.ts`, `packages/server/package.json`, `cli:commands/agent/ls.ts`, `cli:commands/agent/archive.ts`, `cli:utils/agent-directory.ts`, `cli:commands/plugin/index.ts`, `cli:commands/permit/allow.ts`, `cli:commands/permit/deny.ts`

**Needs hand merge (sequential apply):** `open.ts` (5599f9e56); `restart.ts` (4869214bc); `delete.ts` (8216e86ec); `attach.ts` (f24bb523e); `logs.ts` (f24bb523e, 0ba4d2526, d5513472e); `update.ts` (15d8ba16a); `archive.ts` (0147edaaa, 18eabeeda); `ls.ts` (0147edaaa, a4b15455b, 18eabeeda); `package.json` (d5513472e); `index.ts` (a292b402c); `allow.ts` (8d9e7d3ad); `deny.ts` (8d9e7d3ad)

**Verify:** Port `packages/cli/tests/*` and run them against a test daemon on a non-default port (Paseo already listens on 6767).

**Notes:** Most hunks drift (rebranded CLI). `8d9e7d3ad` changes exit codes, so put it in the JAgentDesk CHANGELOG.

### B17: Terminal fixes (macOS editing keys, CJK/Korean, launch errors, MCP keys, xterm)

**Upstream commits (in order):**

- `7dc2a3568` [PORT] fix(terminal): translate mac cmd/option editing shortcuts
- `a983ae044` [PORT] refactor(terminal): inject mac platform flag at mount
- `70210f107` [PORT] refactor(app): name the terminal key-event input shapes
- `e18f9e8f4` [PORT] refactor(terminal): share platform policy across keyboard shortcuts
- `79a394239` #6022 [PORT] fix(server): mark Claude terminals as needing input when Claude goes idle
- `e81d5d02b` #6452 [PORT] Keep terminal CJK text unchanged after returning to a workspace
- `404d08d24` #6792 [PORT] Report failed terminal launches and remove early exits
- `9bd58f66b` #7254 [PORT] Copy Korean terminal text without extra spaces
- `e5d9307cf` #7260 [PORT] fix(terminal): copy wide characters selected from either half
- `644d66ba4` #7353 [PORT] Select complete Korean terminal words on long press
- `f0acc2c72` #7343 [ADAPT] Send MCP terminal keys in the running program’s input mode
- `b9f624f72` #8013 [PORT] fix(app): update xterm to prevent shared-atlas glyph corruption
- `2553ab4d8` #5712 [ADAPT] fix(app): expose terminal controls on native tablets

**JAgentDesk files to touch** (16, paths rebranded): `app:terminal/runtime/terminal-emulator-runtime.ts`, `app:terminal/webview/terminal-emulator-webview-html.ts`, `app:utils/terminal-keys.ts`, `srvsrc:terminal/agent-hooks/claude/claude.ts`, `proto:terminal-snapshot.ts`, `srvsrc:terminal/terminal.ts`, `srvsrc:executable-resolution/executable-resolution.ts`, `srvsrc:terminal/worker-terminal-manager.ts`, `app:terminal/native-renderer/terminal-selection.ts`, `app:components/terminal-emulator-native-grid.native.tsx`, `srv:agent/tools/jagentdesk-tools.ts`, `srvsrc:terminal/terminal-worker-process.ts`, `srvsrc:terminal/terminal-worker-protocol.ts`, `packages/app/package.json`, `app:components/terminal-pane.tsx`, `app:terminal/runtime/terminal-virtual-keyboard.ts`

**Needs hand merge (sequential apply):** `terminal-emulator-webview-html.ts` (7dc2a3568, a983ae044, e18f9e8f4); `executable-resolution.ts` (404d08d24); `paseo-tools.ts` (f0acc2c72); `package.json` (b9f624f72); `terminal-pane.tsx` (2553ab4d8)

**Verify:** Desktop: Option+←/→ and Cmd+Backspace in the terminal. iOS: copy Korean text, long-press a word. MCP `send_terminal_keys` with arrow keys in a TUI. Glyphs after switching tabs with WebGL.

**Notes:** Merge `terminal-emulator-webview-html.ts` by hand (3 commits). `f0acc2c72` touches `jagentdesk-tools.ts`. `2553ab4d8` touches the JAgentDesk `terminal-pane.tsx`.

### B18: Client/protocol robustness (upload wait, oversized messages, SDK send behaviour, host probe)

**Upstream commits (in order):**

- `560e478ef` #5585 [PORT] Wait for the connection before starting a file upload
- `fc8f085b9` #6285 [ADAPT] Reject oversized messages without disconnecting the host
- `f232d23e9` #5605 [ADAPT] fix(client): let SDK callers choose what a send does to an active turn
- `4e9a4582b` #5722 [PORT] fix(app): stop connecting to a host removed during its first probe
- `b85b44aea` #5351 [ADAPT] Show a host's new version after its daemon restarts

**JAgentDesk files to touch** (11, paths rebranded): `client:daemon-client.ts`, `client:daemon-client-transport-utils.ts`, `proto:websocket-message-limit.ts`, `packages/server/package.json`, `srv:websocket-server.ts`, `srvsrc:utils/checkout-git.ts`, `packages/client/examples/agents-and-providers.ts`, `client:index.ts`, `app:runtime/host-runtime.ts`, `app:contexts/session-context.tsx`, `app:stores/session-store.ts`

**Needs hand merge (sequential apply):** `daemon-client.ts` (560e478ef, fc8f085b9, f232d23e9); `package.json` (fc8f085b9); `websocket-server.ts` (fc8f085b9); `agents-and-providers.ts` (f232d23e9); `session-context.tsx` (b85b44aea); `host-runtime.ts` (b85b44aea)

**Verify:** Send an attachment larger than the limit from mobile over the tailnet: you get an error toast and no reconnect loop. Remove a host during its first probe.

**Notes:** All three `daemon-client.ts` hunks need hand merges. Skip the relay-e2ee transport. `b85b44aea` host-runtime/session-store pieces.

### B19: Plugin SDK parity, server side (0.11–0.14)

**Upstream commits (in order):**

- `5375f43a0` #5971 [PORT] feat(plugins): expose agent closed lifecycle event
- `e10f6d2e2` #5838 [PORT] Let plugin client code import packages that declare only main
- `e08389065` #7023 [PORT] fix(plugins): allow protocol type imports without local dependencies
- `74c8172f8` #6306 [PORT] Wait for a plugin reload to finish instead of failing at the request deadline
- `d6fa23189` #7717 [PORT] fix(plugin): restore ACP history replayed during session load
- `dc07efe93` #7272 [PORT] Keep plugin ACP reasoning separate from assistant replies
- `1e0a9d5af` #7582 [PORT] fix(plugins): allow notification timeline transformers
- `1839de5b1` #6760 [PORT] Restore provider readiness for mobile plugins
- `976029265` #6151 [ADAPT] fix(providers): launch plugin CLIs on Windows and tolerate Muse startup
- `068f272a0` #7477 [ADAPT] perf(plugins): keep turn-ended payloads independent of history
- `10bc10c99` #7938 [ADAPT] Let plugins give specific agents tools
- `8a542048b` #7983 [ADAPT] Let plugins contribute MCP servers on every agent session open

**JAgentDesk files to touch** (35, paths rebranded): `plugin:server/lifecycle.ts`, `srv:agent/agent-manager.ts`, `srv:bootstrap.ts`, `srv:plugins/index.ts`, `srv:plugins/lifecycle/index.ts`, `srv:plugins/runtime.ts`, `plugin-examples/lifecycle-logger/index.server.ts`, `srv:plugins/compiler.ts`, `client:daemon-client.ts`, `plugin:server/acp-internal/connection.ts`, `app:plugins/evaluate.ts`, `client:index.ts`, `.oxlintrc.json`, `plugin:server/index.ts`, `plugin:server/process-internal/windows-command.ts`, `plugin:server/process.ts`, `srvsrc:executable-resolution/executable-resolution.ts`, `srv:plugins/bundle-evaluator.ts`, `srvsrc:utils/spawn.ts`, `plugin-examples/lifecycle-actions/index.server.ts`, `plugin:server/agent-tools.ts`, `srv:agent/agent-prompt.ts`, `srv:agent/tools/jagentdesk-tools.ts`, `srv:agent/tools/plugin-tools.ts`, `srv:plugins/agent-tools.ts`, `srv:plugins/plugin-process-protocol.ts`, `srv:plugins/plugin-process.ts`, `srv:schedule/service.ts`, `plugin-examples/agent-tools/index.server.ts`, `plugin-examples/agent-tools/jagentdesk-plugin.json` … +5

**Needs hand merge (sequential apply):** `index.ts` (1839de5b1, 10bc10c99, 10bc10c99); `connection.ts` (976029265, 976029265); `executable-resolution.ts` (976029265); `bundle-evaluator.ts` (976029265); `spawn.ts` (976029265); `process.ts` (976029265); `signals.ts` (976029265); `provider.ts` (976029265); `fake-muse.mjs` (976029265); `agent-manager.ts` (068f272a0, 10bc10c99, 8a542048b); `agent-prompt.ts` (10bc10c99); `paseo-tools.ts` (10bc10c99); `bootstrap.ts` (10bc10c99); `plugin-process-protocol.ts` (10bc10c99); `plugin-process.ts` (10bc10c99); `runtime.ts` (10bc10c99, 8a542048b); `service.ts` (10bc10c99); `plugin-provider.ts` (8a542048b); `R:runtime-mcp-config.ts` (8a542048b)

**Verify:** Port the upstream `plugin/src/server/*.test.ts` and `srv:plugins/*.e2e.test.ts` (`plugin-jagentdesk-api`). Install `plugin-examples/agent-tools` and `agent-configuration`: the agent sees the plugin tool, and the MCP server is added on session open. Then raise `SUPPORTED_PASEO_PLUGIN_API` to the highest API fully covered.

**Notes:** Exclude `plugins/muse-provider/*` and `plugins/antigravity-provider/*` from `976029265`. `runtime-mcp-config.ts` already exists (R). Agent-tool wiring goes through `jagentdesk-tools.ts` and `agent-prompt.ts`.

### B20: Plugin SDK parity, client side (ui entry, icons, translations, audio, Markdown)

**Upstream commits (in order):**

- `9bce7dbd2` #7474 [ADAPT] refactor(plugin): unify the client UI entrypoint
- `f3d74b857` #7780 [ADAPT] fix(plugins): restore deprecated useRevealedText compatibility
- `995ad2f87` #7579 [ADAPT] feat(plugin): render Markdown content with host UI
- `b6dde61a7` #7368 [ADAPT] feat(plugins): accept inline SVG and component icons
- `30464cf23` #7478 [ADAPT] Translate plugin content and labels in each app language
- `42806cdbf` #5976 [ADAPT] Let plugins play audio on every client
- `5acfbb377` #7110 [PORT] Let Escape close plugin previews before stopping agents
- `e2ad26d23` #7253 [ADAPT] Find source-message text in plugin timeline rows

**JAgentDesk files to touch** (85, paths rebranded): `app:plugins/evaluate.ts`, `app:plugins/icons.ts`, `app:plugins/react-native/modal.tsx`, `app:plugins/react-native/runtime.ts`, `app:plugins/react-native/streamed-text.tsx`, `app:plugins/react-native/toast.ts`, `app:plugins/react-native/ui.ts`, `plugin:client/react-native.ts`, `plugin:client/ui.ts`, `srv:plugins/plugin-sdk-specifiers.ts`, `plugin-examples/inline-thinking/client/thinking.tsx`, `plugin-examples/inline-thinking/jagentdesk-plugin.json`, `plugin-examples/modal-ui/client/examples.tsx`, `plugin-examples/modal-ui/jagentdesk-plugin.json`, `app:plugins/react-native/markdown.tsx`, `plugin-examples/local-plugin/client/main.tsx`, `app:plugins/attachments/model.ts`, `app:plugins/attachments/picker.tsx`, `app:plugins/attachments/pill.tsx`, `app:plugins/buttons/store.ts`, `app:plugins/buttons/validation.ts`, `app:plugins/buttons/view.tsx`, `app:plugins/command-center/contributions.ts`, `app:plugins/sidebar-groups.ts`, `app:plugins/sidebar-items/kit.tsx`, `app:plugins/sidebar-items/legacy.tsx`, `app:plugins/surface-screen.tsx`, `app:plugins/workspace-panels/panel.tsx`, `app:screens/settings/sidebar/sidebar-nav-section.tsx`, `app:workspace-tabs/launcher/index.tsx` … +55

**Needs hand merge (sequential apply):** `evaluate.ts` (9bce7dbd2, f3d74b857, b6dde61a7, 30464cf23); `icons.ts` (9bce7dbd2); `ui.ts` (9bce7dbd2, 9bce7dbd2, 995ad2f87, 995ad2f87, b6dde61a7); `react-native.ts` (9bce7dbd2, f3d74b857); `react-native-unistyles.ts` (995ad2f87); `main.tsx` (995ad2f87); `validation.ts` (b6dde61a7, 30464cf23); `view.tsx` (b6dde61a7, 30464cf23); `contributions.ts` (b6dde61a7, 30464cf23); `sidebar-groups.ts` (b6dde61a7, 30464cf23); `kit.tsx` (b6dde61a7); `legacy.tsx` (b6dde61a7); `surface-screen.tsx` (b6dde61a7, 30464cf23); `panel.tsx` (b6dde61a7, 30464cf23); `sidebar-nav-section.tsx` (b6dde61a7); `index.tsx` (b6dde61a7, 30464cf23, 30464cf23, 30464cf23); `contracts.ts` (b6dde61a7, 30464cf23, 42806cdbf); `index.ts` (b6dde61a7, 30464cf23, 30464cf23); `presentation.ts` (30464cf23); `panels.ts` (30464cf23); `client-runtime.ts` (30464cf23, 42806cdbf); `installation-provider.tsx` (30464cf23); `registry.ts` (30464cf23, 42806cdbf); `surface-contribution.ts` (30464cf23); `types.ts` (30464cf23); `locations.ts` (30464cf23); `settings-screen.tsx` (30464cf23); `session-context.tsx` (42806cdbf); `catalog-sync.tsx` (42806cdbf); `audio-engine.native.ts` (42806cdbf); `voice-runtime.ts` (42806cdbf); `use-keyboard-shortcuts.ts` (5acfbb377); `strategy-web.tsx` (e2ad26d23)

**Verify:** A plugin importing `@jagentdesk/plugin/client/ui` (and the deprecated entry) loads on desktop and mobile. Inline-SVG icons render. Plugin strings follow the app language.

**Notes:** The app plugin host is largely X (56 source files). Reimplement against the JAgentDesk plugin host and the ClickUp theme tokens. `42806cdbf` changes the audio engine (voice-runtime).

### B21: Plugin registry, manifest metadata and overview sanitizing (adapted)

**Upstream commits (in order):**

- `fc3b2c4eb` #6244 [ADAPT] Sanitize plugin overview rendering: no raw HTML, https links only, no relative links
- `2d85fe4e0` #6263 [ADAPT] feat(plugins): declare display metadata in plugin manifests
- `b5e9747e2` #5986 [ADAPT] Add the reviewed plugin registry and the unlinked plugin directory pages
- `c06228042` #6080 [ADAPT] Ship the plugin directory redesign and keep registry installs behind a daemon flag
- `7fd469ae1` #6224 [ADAPT] Enable plugin registry installs by default
- `06bde1e57` #6226 [ADAPT] Scaffold author overviews for plugin listings

**JAgentDesk files to touch** (14, paths rebranded): `proto:plugin-overview.ts`, `cli:commands/plugin/scaffold.ts`, `proto:messages.ts`, `srv:plugins/index.ts`, `srv:plugins/manifest.ts`, `cli:commands/plugin/index.ts`, `proto:plugin-registry.ts`, `proto:plugin-source-reference.ts`, `srv:bootstrap.ts`, `srv:config-environment.ts`, `srv:config.ts`, `srv:persisted-config.ts`, `srv:plugins/managed-source.ts`, `srv:plugins/managed-source/registry.ts` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `scaffold.ts` (2d85fe4e0, 06bde1e57); `messages.ts` (b5e9747e2); `bootstrap.ts` (b5e9747e2, c06228042, 7fd469ae1); `config-environment.ts` (b5e9747e2, c06228042, 7fd469ae1); `config.ts` (b5e9747e2, c06228042, 7fd469ae1); `persisted-config.ts` (b5e9747e2, c06228042, 7fd469ae1); `managed-source.ts` (b5e9747e2, c06228042, 7fd469ae1); `en.ts` (7fd469ae1); `index.ts` (7fd469ae1)

**Verify:** Unit test the overview sanitizer with raw HTML, `javascript:` and relative links. Product decision on the `owner/slug` vs `github:` semantics before porting `7fd469ae1`.

**Notes:** The config and `managed-source` files differ (JAgentDesk sources and marketplace). Port `fc3b2c4eb` first; it is independent.

### B22: Host confirmation for pairing links (security, adapted, ADR)

**Upstream commits (in order):**

- `364e6456e` #5753 [ADAPT] Add confirmation for new hosts

**JAgentDesk files to touch** (9, paths rebranded): `app:app/_layout.tsx`, `app:app/pair-scan.tsx`, `app:components/add-host-modal.tsx`, `app:components/pair-link-modal.tsx`, `app:hosts/host-confirmation-sheet.tsx`, `app:hosts/pair-scan-model.ts`, `app:runtime/host-confirmation.ts`, `app:runtime/host-runtime.ts`, `app:types/host-connection.ts` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `_layout.tsx` (364e6456e); `pair-scan.tsx` (364e6456e); `add-host-modal.tsx` (364e6456e); `pair-link-modal.tsx` (364e6456e); `en.ts` (364e6456e); `host-runtime.ts` (364e6456e); `host-connection.ts` (364e6456e)

**Verify:** Open an `#offer=` link for a new serverId: the app asks with the fingerprint, and Cancel leaves no host. A link matching a saved host connects silently. A changed key asks again. Test the real tailnet pair flow end to end (paste authkey, 6-digit code watcher) on desktop and the iOS simulator.

**Notes:** Write the ADR before coding (pairing UX change). JAgentDesk host types: `tailnet`, `directTcp`, `directSocket`, `directPipe` (no relay field), so compare `tailnetAddress` + `daemonPublicKeyB64`.

### B23: Agent-to-agent messaging redesign (sender identity, batching, steering default, persistent finish notifications)

**Upstream commits (in order):**

- `d0bc188a5` #6373 [ADAPT] Show agent messages and completion notifications with sender identity
- `dfa997704` #8092 [ADAPT] fix(app): truncate agent sender attribution to one line
- `d0568f9f1` #7561 [ADAPT] Batch agent reports and completion notifications
- `f22775a8e` #5164 [ADAPT] Default agent-to-agent messages to steering in CLI and MCP
- `21e7ccb03` #7683 [ADAPT] Restore agent finish notifications after daemon restart
- `1c6274808` #7528 [ADAPT] Notify callers when detached agents finish
- `23b05bbcc` #7532 [ADAPT] Keep archived agents out of discovery after history reads
- `c364b16d4` #6660 [ADAPT] Report canceled child tasks and wait for replacement tasks to finish
- `1ae979d3d` #6316 [ADAPT] Subagents that finish while the app is disconnected no longer stay "working"
- `2a890208c` #7784 [ADAPT] feat(app): show a subagent's parent and a way back to it

**JAgentDesk files to touch** (47, paths rebranded): `app:agent-stream/view.tsx`, `app:components/message.tsx`, `app:runtime/replica-cache/index.ts`, `app:tool-calls/presentation.ts`, `app:types/stream.ts`, `cli:commands/agent/send.ts`, `client:daemon-client.ts`, `proto:agent-message-display.ts`, `proto:agent-message.ts`, `proto:agent-types.ts`, `proto:messages.ts`, `proto:tool-call-display.ts`, `srv:agent/agent-manager.ts`, `srv:agent/agent-messages/index.ts`, `srv:agent/agent-prompt.ts`, `srv:agent/create-agent/create.ts`, `srv:agent/tools/jagentdesk-tools.ts`, `srv:schedule/service.ts`, `srv:session.ts`, `srv:websocket-server.ts`, `app:components/ui/button.tsx`, `app:components/user-message/index.tsx`, `app:composer/actions.ts`, `srv:agent/agent-messages/delivery.ts`, `srv:agent/agent-messages/envelope.ts`, `srv:agent/host-operations/index.ts`, `srv:bootstrap.ts`, `srv:agent/finish-subscriptions/index.ts`, `srv:agent/finish-subscriptions/internal/json-store.ts`, `srv:agent/finish-subscriptions/internal/notification.ts` … +17 (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `message.tsx` (d0bc188a5); `index.ts` (d0bc188a5, d0568f9f1, 21e7ccb03); `presentation.ts` (d0bc188a5); `stream.ts` (d0bc188a5); `send.ts` (d0bc188a5, d0568f9f1, f22775a8e); `daemon-client.ts` (d0bc188a5, d0568f9f1); `messages.ts` (d0bc188a5, d0568f9f1); `agent-manager.ts` (d0bc188a5, d0568f9f1); `agent-prompt.ts` (d0bc188a5, d0568f9f1, f22775a8e, 21e7ccb03, c364b16d4); `paseo-tools.ts` (d0bc188a5, d0568f9f1, f22775a8e, 21e7ccb03); `service.ts` (d0bc188a5); `session.ts` (d0bc188a5, d0568f9f1, 21e7ccb03); `websocket-server.ts` (d0bc188a5, d0568f9f1); `index.tsx` (dfa997704); `actions.ts` (d0568f9f1); `create.ts` (d0568f9f1, 21e7ccb03, 1c6274808); `bootstrap.ts` (d0568f9f1, 21e7ccb03); `agent-projections.ts` (23b05bbcc); `directory.ts` (23b05bbcc); `session-context.tsx` (1ae979d3d); `provider-store.ts` (1ae979d3d); `tracks.tsx` (2a890208c); `en.ts` (2a890208c); `agent-panel.tsx` (2a890208c); `agent-tracks.tsx` (2a890208c); `provider-subagent-panel.tsx` (2a890208c)

**Verify:** Team mode regression suite: lead/worker messages, forum, autorun, `notifyOnFinish` across a daemon restart. Upstream `finish-subscription-daemon` and `agent-messages` tests.

**Notes:** Highest conflict with Team mode/ORC (46 source hunks fail). Needs a short design note or ADR on message envelopes before any code. `f22775a8e` changes the default from interrupt to steer.

### B24: Small chat and app fixes

**Upstream commits (in order):**

- `3b4118360` #5598 [PORT] fix(app): start the context meter ring at twelve o'clock on web
- `68e722ec2` #5602 [PORT] fix(app): request a chat outline only for a timeline the daemon has served
- `642d69b14` #5653 [PORT] fix(app): cache file links with their line locations
- `18412604d` #6138 [PORT] fix(app): copy only the code when a selection touches the block beside it
- `4ed13fadb` #6158 [PORT] fix(app): keep list numbers when a copy crosses a code block nested in an item
- `950e1f8f4` #6181 [PORT] Keep an image's alt text and source when copying a selection from an assistant reply
- `0255738ee` #6195 [PORT] Copy only the highlighted text when a selection starts below an image
- `563c014dc` #6520 [PORT] Open assistant links to non-ASCII filenames
- `dc7bed417` #7341 [PORT] Keep late composer pills clear of completed turn actions
- `b2da58b5b` #7263 [PORT] fix(app): keep chat keyboard scrolling after closing Find
- `d152f1529` #7098 [PORT] fix(app): recover failed question responses
- `019e5279e` #6171 [PORT] Show Claude option previews in the question card, readable on Android
- `78a3083fe` #7901 [PORT] perf(app): avoid stream updates in hidden chats
- `e2fd5a9c5` #6370 [PORT] fix(app): keep markdown text that only looks like HTML verbatim
- `b58af43a0` #6650 [PORT] fix(app): render mixed HTML headings without literal tags
- `73221ce5b` #6877 [PORT] fix(app): render local Markdown images with encoded paths
- `20a887f4c` #5796 [PORT] Show an agent's own model in the composer when the catalog lacks it
- `4893629ff` #5804 [PORT] Show the thinking level an agent runs on in its composer
- `12aaded6c` #6005 [PORT] fix(app): show the configured label for the xhigh thinking option
- `7868f5caf` #6471 [PORT] Keep email addresses intact when sending with Enter
- `b7c8be408` #6208 [PORT] Show the PR panel's Activity and Add to chat labels in the app language
- `48059aeae` #6225 [PORT] Show the PR panel's state, activity verbs, and thread badges in the app language

**JAgentDesk files to touch** (28, paths rebranded): `app:components/context-window-meter.tsx`, `app:agent-stream/chat-outline/model.ts`, `app:agent-stream/chat-outline/use-chat-outline.ts`, `app:assistant-file-links/use-file-link.ts`, `app:assistant-selection-copy/content.web.ts`, `app:assistant-selection-copy/markup.ts`, `app:components/message.tsx`, `app:assistant-file-links/parse.ts`, `app:assistant-file-links/resolver.ts`, `app:agent-stream/view.tsx`, `app:agent-stream/chat-find/index.web.tsx`, `app:agent-stream/strategy-web.tsx`, `app:agent-stream/strategy.ts`, `app:components/question-form-card.tsx`, `app:components/question-form-card-core.ts`, `srv:agent/providers/mock-load-test-agent.ts`, `app:agent-stream/use-agent-stream-tail.ts`, `app:panels/agent-panel.tsx`, `app:components/markdown/html-ish.ts`, `app:attachments/utils.ts`, `app:composer/agent-controls/utils.ts`, `app:composer/agent-controls/index.tsx`, `app:agent-controls/labels.ts`, `app:utils/file-mention-autocomplete.ts`, `app:components/sidebar/sidebar-status-list.tsx`, `app:git/pull-request-panel/checks-section.tsx`, `app:git/pull-request-panel/pane.tsx`, `app:git/pull-request-panel/data.ts` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `context-window-meter.tsx` (3b4118360); `use-chat-outline.ts` (68e722ec2); `content.web.ts` (18412604d, 950e1f8f4, 0255738ee); `message.tsx` (950e1f8f4); `strategy.ts` (b2da58b5b); `question-form-card.tsx` (d152f1529, 019e5279e); `agent-panel.tsx` (78a3083fe); `sidebar-status-list.tsx` (b7c8be408); `checks-section.tsx` (b7c8be408); `en.ts` (b7c8be408); `data.ts` (48059aeae); `pane.tsx` (48059aeae)

**Verify:** `vitest run` the upstream app unit tests that come with the commits (`assistant-selection-copy`, `file-mention-autocomplete`, `html-ish`, `question-form-card-core`). Desktop CDP check: copy across a code block or image; question card option previews.

**Notes:** 15 small hunks. `question-form-card.tsx` and `agent-panel.tsx` differ in JAgentDesk.

### B25: Highlighting and keyboard-layout fixes

**Upstream commits (in order):**

- `a7f7405c0` #6205 [PORT] fix(highlight): highlight Vue (.vue) files
- `56d568074` #6219 [PORT] fix(highlight): keep Astro expressions colored through nested template strings
- `eb051ea81` #6763 [PORT] Render Astro diffs containing empty expressions
- `40f039306` #6652 [PORT] Record shortcuts using the keyboard layout character
- `b5e51cf83` #6755 [PORT] Run letter shortcuts with non-Latin keyboard layouts
- `cafa04d3f` #6586 [PORT] fix(app): traverse workspaces beyond nine
- `5c2a1552d` #7065 [PORT] fix(app): preserve number groups when rebinding navigation shortcuts
- `e760764b3` #7365 [PORT] fix(app): require a number when recording index shortcuts
- `8388f1618` #7081 [PORT] Keep Add Project keyboard selection visible
- `e1a5664d9` #6695 [PORT] fix(app): keep malformed font settings from breaking the UI

**JAgentDesk files to touch** (14, paths rebranded): `hl:parsers.ts`, `hl:vue/parser.ts`, `hl:astro/parser.ts`, `hl:js-scanner.ts`, `app:keyboard/shortcut-string.ts`, `app:keyboard/keyboard-shortcuts.ts`, `app:utils/sidebar-shortcuts.ts`, `app:screens/settings/keyboard-shortcuts-section.tsx`, `app:components/add-project-flow.tsx`, `app:components/ui/autocomplete-utils.ts`, `app:components/ui/autocomplete.tsx`, `app:components/ui/scroll-reveal.ts`, `app:hooks/use-settings/storage.ts`, `app:screens/settings/appearance/appearance-section.tsx` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `parsers.ts` (a7f7405c0); `keyboard-shortcuts.ts` (5c2a1552d, e760764b3); `shortcut-string.ts` (5c2a1552d); `keyboard-shortcuts-section.tsx` (5c2a1552d, e760764b3); `en.ts` (e760764b3); `add-project-flow.tsx` (8388f1618); `appearance-section.tsx` (e1a5664d9)

**Verify:** `vitest run packages/highlight` (Vue and Astro cases) and `keyboard/*.test.ts`.

**Notes:** `parsers.ts` registration. Shortcut-section UI in JAgentDesk settings.

### B26: Desktop shell fixes (daemon status polling, Linux window, EPIPE, titlebar drag, Xcode editor)

**Upstream commits (in order):**

- `87818812a` #5636 [PORT] Stop the desktop app from launching a process every second when no local daemon runs
- `b852ae920` #6645 [PORT] fix(desktop): show the Paseo window icon on Linux
- `9551b2cc1` #6726 [PORT] Open loaded Linux desktop windows when hidden rendering stalls
- `14e638451` #6639 [PORT] fix(desktop): keep running when launcher console pipes close
- `84054f8d7` #5233 [ADAPT] fix(desktop): restore titlebar dragging after scrolling chat
- `27d6b3b7c` #7898 [ADAPT] feat(desktop): remember project editors and support Xcode

**JAgentDesk files to touch** (25, paths rebranded): `desk:daemon/daemon-manager.ts`, `packages/desktop/electron-builder.yml`, `packages/desktop/package.json`, `desk:main.ts`, `desk:window/show-when-ready.ts`, `desk:diagnostics/console-streams.ts`, `packages/app/public/index.html`, `app:agent-stream/strategy-web.tsx`, `packages/desktop/capture-harness/main.js`, `packages/desktop/capture-harness/titlebar-drag-mouse.m`, `packages/desktop/capture-harness/titlebar-drag.js`, `app:components/file-explorer-pane.tsx`, `app:desktop/host.ts`, `app:hooks/use-preferred-editor.ts`, `app:screens/workspace/workspace-screen.tsx`, `app:workspace/desktop-open-targets.ts`, `app:workspace/open-in-editor/button.tsx`, `app:workspace/open-in-editor/directory.ts`, `packages/desktop/assets/editor-targets/xcode.png`, `desk:features/editor-targets/ipc.ts`, `desk:features/editor-targets/registry.ts`, `desk:features/editor-targets/runtime.ts`, `desk:features/editor-targets/target.ts`, `desk:features/editor-targets/targets/xcode.ts`, `desk:preload.ts`

**Needs hand merge (sequential apply):** `daemon-manager.ts` (87818812a); `package.json` (9551b2cc1); `main.ts` (9551b2cc1); `strategy-web.tsx` (84054f8d7); `file-explorer-pane.tsx` (27d6b3b7c); `use-preferred-editor.ts` (27d6b3b7c); `desktop-open-targets.ts` (27d6b3b7c); `button.tsx` (27d6b3b7c); `directory.ts` (27d6b3b7c)

**Verify:** Desktop app with no local daemon: no `daemon status` process per second (check with `ps`). Linux AppImage window and icon. Open in Xcode is offered for `.xcodeproj`.

**Notes:** `27d6b3b7c` adds the Xcode target beside JAgentDesk's 22 editor targets, plus a per-project preference store. Check the ClickUp header drag region for `84054f8d7`.

### B27: Agentic browser: browser_type focus guard and zoomed capture (adapted)

**Upstream commits (in order):**

- `2974d7c96` #6207 [ADAPT] fix(desktop): keep browser_type text out of the focused Paseo composer
- `5de45e208` #5703 [ADAPT] fix(desktop): capture the annotated element when the app is zoomed

**JAgentDesk files to touch** (5, paths rebranded): `packages/desktop/capture-harness/main.js`, `desk:features/browser-automation/ipc.ts`, `desk:features/browser-automation/service.ts`, `desk:features/browser-automation/trusted-input.ts`, `desk:features/browser-capture.ts`

**Needs hand merge (sequential apply):** `ipc.ts` (2974d7c96); `service.ts` (2974d7c96); `browser-capture.ts` (5de45e208)

**Verify:** Desktop: an agent runs `browser_type` while the composer is focused, and the text lands only in the page. Annotation capture with the app zoomed to 125%.

**Notes:** JAgentDesk `browser-automation/service.ts` and `ipc.ts` carry the stealth and dialog work (ADR-0025/0026). Reimplement the focus guard there and do not touch the anti-detect injection order.

### B28: Voice fixes (local model reinstall, OpenAI-compatible TTS, Android dictation)

**Upstream commits (in order):**

- `c301d6e8a` #6210 [PORT] Reinstall local speech models whose extraction was interrupted
- `a4f1df3ae` #6060 [PORT] Let voice mode TTS use the model and voice an OpenAI-compatible server serves
- `4117dce2d` #7103 [PORT] Fix local WAV transcription startup
- `ca894d49a` #7756 [PORT] fix(voice): keep prefetched sentences available for playback
- `6e1ec21c6` #7200 [ADAPT] Keep Android dictation running through audio interruptions

**JAgentDesk files to touch** (24, paths rebranded): `srv:speech/providers/local/models.ts`, `srv:speech/providers/local/sherpa/model-downloader.ts`, `srv:speech/speech-runtime.ts`, `packages/server/.env.example`, `srv:persisted-config.ts`, `srv:speech/providers/openai/config.ts`, `srv:speech/providers/openai/tts.ts`, `packages/server/scripts/transcribe-local-wav.ts`, `app:audio/audio-engine-types.ts`, `app:audio/audio-engine.native.ts`, `app:audio/audio-engine.web.ts`, `app:components/dictation-controls.tsx`, `app:hooks/use-dictation-audio-source.native.ts`, `app:hooks/use-dictation-audio-source.types.ts`, `app:hooks/use-dictation-audio-source.web.ts`, `app:hooks/use-dictation.shared.ts`, `app:hooks/use-dictation.ts`, `packages/expo-two-way-audio/android/build.gradle`, `packages/expo-two-way-audio/android/src/androidTest/AndroidManifest.xml`, `packages/expo-two-way-audio/android/src/androidTest/java/expo/modules/twowayaudio/AudioEngineTest.kt`, `packages/expo-two-way-audio/android/src/main/java/expo/modules/twowayaudio/AudioEngine.kt`, `packages/expo-two-way-audio/android/src/main/java/expo/modules/twowayaudio/ExpoTwoWayAudioModule.kt`, `packages/expo-two-way-audio/ios/ExpoTwoWayAudioModule.swift`, `packages/expo-two-way-audio/src/core.ts` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `model-downloader.ts` (c301d6e8a)

**Verify:** Kill the daemon during a local model extract, restart, and dictation works. Android: dictation survives audio from another app.

**Notes:** `6e1ec21c6` touches `packages/expo-two-way-audio` native code, so it needs an EAS cloud build to verify.

### B29: Composer behaviour (draft commands, unsupported mode, focus on touch, recall, send shortcut, long-press send)

**Upstream commits (in order):**

- `690f5298c` #5594 [ADAPT] fix(app): keep draft composers off the agent command list before a project and model are chosen
- `17562fcb6` #5847 [ADAPT] fix(app): stop New workspace sending a mode the provider doesn't offer
- `febe9611b` #5477 [ADAPT] fix(app): stop composer autofocus on touch screens
- `6017706cc` #7130 [ADAPT] fix(app): avoid restoring composer focus on touch navigation
- `b8bcd204a` #7352 [ADAPT] Dismiss touch composer focus when switching tabs
- `60fa12c4d` #7303 [ADAPT] Report disconnected hosts in new agent drafts
- `033b2cdfc` #7910 [ADAPT] fix(app): keep command suggestions visible as the composer grows
- `6f07b0de4` #7710 [ADAPT] feat(app): recall sent messages with Up and Down in an empty composer
- `7f6a805e0` #5503 [ADAPT] feat(app): choose the composer send shortcut
- `88bd1cf05` #7897 [ADAPT] feat(app): long-press Send to queue or send now on touch screens

**JAgentDesk files to touch** (21, paths rebranded): `app:components/workspace-setup-dialog.tsx`, `app:composer/draft/input-draft.ts`, `app:composer/draft/workspace-tab.tsx`, `app:composer/index.tsx`, `app:hooks/use-agent-autocomplete.ts`, `app:hooks/use-agent-commands-query.ts`, `app:provider-selection/provider-selection.ts`, `app:screens/new-workspace-screen.tsx`, `app:composer/input/input.tsx`, `app:composer/keyboard-scope.tsx`, `app:composer/draft/workspace-tab-core.ts`, `app:hooks/use-agent-form-state.ts`, `app:components/ui/autocomplete-popover.tsx`, `app:components/ui/autocomplete.tsx`, `app:composer/recall.ts`, `app:stores/session-store.ts`, `app:composer/input/state.ts`, `app:hooks/use-settings/index.ts`, `app:hooks/use-settings/storage.ts`, `app:screens/settings/general/sending-section.tsx`, `app:composer/input/labels.ts` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `workspace-setup-dialog.tsx` (690f5298c); `input-draft.ts` (690f5298c, 17562fcb6); `workspace-tab.tsx` (690f5298c, 60fa12c4d); `index.tsx` (690f5298c, febe9611b, 033b2cdfc, 6f07b0de4, 7f6a805e0); `use-agent-autocomplete.ts` (690f5298c); `provider-selection.ts` (690f5298c); `new-workspace-screen.tsx` (690f5298c, 17562fcb6); `input.tsx` (6017706cc, b8bcd204a, 6f07b0de4, 7f6a805e0, 88bd1cf05); `keyboard-scope.tsx` (6017706cc); `use-agent-form-state.ts` (60fa12c4d); `autocomplete-popover.tsx` (033b2cdfc); `autocomplete.tsx` (033b2cdfc); `state.ts` (7f6a805e0); `index.ts` (7f6a805e0); `storage.ts` (7f6a805e0); `en.ts` (7f6a805e0, 88bd1cf05); `sending-section.tsx` (7f6a805e0); `labels.ts` (88bd1cf05)

**Verify:** Desktop and mobile real app: Up/Down recalls sent messages; the Cmd+Enter setting; long-press Send on iOS queues the message.

**Notes:** The JAgentDesk working tree has uncommitted edits in `composer/index.tsx`, `workspace-tab.tsx` and `workspace-setup-dialog.tsx`; rebase after they land. JAgentDesk composer adds skills, Team and autorun toggles.

### B30: Workspace setup, scripts and tab-restore fixes (adapted)

**Upstream commits (in order):**

- `c7759713e` #6007 [ADAPT] fix(server): publish workspace script status to every client
- `1c8c68f93` #7407 [ADAPT] Keep workspace setup logs scoped to the visible setup panel
- `fbd90cb88` #7473 [ADAPT] Keep setup execution and output owned by the workspace
- `f56c01392` #6999 [ADAPT] Open configured terminals after worktree setup
- `bdae614e9` #7608 [ADAPT] fix(app): restore chats after reopening unread workspaces
- `632a7f885` #7758 [ADAPT] fix(app): keep live workspace rows when a late creation snapshot arrives
- `65ce4b590` #7956 [ADAPT] fix(app): remove restored agent tabs from foreign workspaces
- `428ef707a` #7918 [ADAPT] fix(app): demand the host directory from the workspace route
- `2545250b2` #7547 [ADAPT] fix(app): keep saved workspace tabs when a store changes before hydration
- `86817a24f` #7242 [ADAPT] perf(app): fetch project and workspace directories concurrently

**JAgentDesk files to touch** (38, paths rebranded): `srv:bootstrap.ts`, `srv:session.ts`, `srv:session/workspace-scripts/workspace-scripts-service.ts`, `srv:websocket-server.ts`, `app:command-center/workspace-registration.tsx`, `app:contexts/session-context.tsx`, `app:panels/setup-panel.tsx`, `app:runtime/directory-sync/workspace-replica.ts`, `app:screens/workspace/workspace-screen.tsx`, `app:stores/session-store.ts`, `app:stores/workspace-setup-store.ts`, `client:connection/index.ts`, `client:daemon-client.ts`, `proto:client-capabilities.ts`, `proto:messages.ts`, `srv:authorization/operation-permissions.ts`, `srv:workspace-setup-observation.ts`, `srv:worktree-session.ts`, `app:components/tool-call-details.tsx`, `app:utils/tool-call-detail-state.ts`, `srv:agent/create-agent-lifecycle-dispatch.ts`, `srv:agent/create-agent/create.ts`, `srv:agent/timeline-append.ts`, `srv:agent/tools/jagentdesk-tools.ts`, `srv:jagentdesk-worktree-service.ts`, `srv:session/workspace-recovery/workspace-recovery-service.ts`, `srv:worktree-bootstrap.ts`, `srv:worktree-core.ts`, `srv:worktree/commands.ts`, `srvsrc:utils/worktree.ts` … +8 (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `bootstrap.ts` (c7759713e); `session.ts` (c7759713e, 1c8c68f93, fbd90cb88); `workspace-scripts-service.ts` (c7759713e); `websocket-server.ts` (c7759713e, 1c8c68f93); `workspace-registration.tsx` (1c8c68f93); `session-context.tsx` (1c8c68f93); `setup-panel.tsx` (1c8c68f93, fbd90cb88); `workspace-replica.ts` (1c8c68f93, 632a7f885); `workspace-screen.tsx` (1c8c68f93); `session-store.ts` (1c8c68f93); `workspace-setup-store.ts` (1c8c68f93); `index.ts` (1c8c68f93, 86817a24f); `daemon-client.ts` (1c8c68f93, fbd90cb88); `client-capabilities.ts` (1c8c68f93); `messages.ts` (1c8c68f93); `operation-permissions.ts` (1c8c68f93); `worktree-session.ts` (1c8c68f93, fbd90cb88, f56c01392); `create-agent-lifecycle-dispatch.ts` (fbd90cb88); `create.ts` (fbd90cb88); `paseo-tools.ts` (fbd90cb88); `worktree-bootstrap.ts` (fbd90cb88, f56c01392); `worktree.ts` (fbd90cb88); `package.json` (f56c01392); `workspace-layout-actions.ts` (bdae614e9, 65ce4b590); `agent-visibility.ts` (65ce4b590); `[agentId].tsx` (428ef707a); `index.tsx` (428ef707a); `validated-persist-storage.ts` (2545250b2)

**Verify:** Two connected clients: script status updates on both. Setup output only streams to the client that shows the Setup panel. Reopen an unread workspace on the phone.

**Notes:** Introduces `client-capabilities.ts` (see the protocol table). Heavy `session.ts`/`websocket-server.ts` merges.

### B31: Idle agent runtime release (config, adapted)

**Upstream commits (in order):**

- `8e5f53676` #7782 [ADAPT] Release idle agent runtimes with work guards and live host controls

**JAgentDesk files to touch** (28, paths rebranded): `app:screens/settings/host-page.tsx`, `app:screens/settings/idle-runtime-cleanup-card.tsx`, `plugin:server/provider.ts`, `proto:messages.ts`, `srv:agent/agent-manager.ts`, `srv:agent/agent-messages/delivery.ts`, `srv:agent/agent-prompt.ts`, `srv:agent/agent-sdk-types.ts`, `srv:agent/finish-subscriptions/index.ts`, `srv:agent/idle-runtime-cleanup/index.ts`, `srv:agent/plugin-provider.ts`, `srv:agent/provider-registry.ts`, `srv:agent/providers/acp-agent.ts`, `srv:agent/providers/claude/agent.ts`, `srv:agent/providers/claude/runtime-safety.ts`, `srv:agent/providers/codex-app-server-agent.ts`, `srv:agent/providers/codex/app-server-transport.ts`, `srv:agent/providers/omp/agent.ts`, `srv:agent/providers/omp/rpc-types.ts`, `srv:agent/providers/opencode-agent.ts`, `srv:agent/providers/opencode/v2/api.ts`, `srv:agent/providers/opencode/v2/session.ts`, `srv:agent/providers/pi/agent.ts`, `srv:bootstrap.ts`, `srv:config.ts`, `srv:daemon-config-store.ts`, `srv:persisted-config.ts`, `srv:websocket-server.ts` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `host-page.tsx` (8e5f53676); `messages.ts` (8e5f53676); `agent-manager.ts` (8e5f53676); `agent-prompt.ts` (8e5f53676); `agent-sdk-types.ts` (8e5f53676); `plugin-provider.ts` (8e5f53676); `agent.ts` (8e5f53676); `app-server-transport.ts` (8e5f53676); `bootstrap.ts` (8e5f53676); `config.ts` (8e5f53676); `daemon-config-store.ts` (8e5f53676); `persisted-config.ts` (8e5f53676); `websocket-server.ts` (8e5f53676)

**Verify:** Agent idle for more than 1 h releases its process and resumes on the next prompt. Team mode lead, autorun agent and browser-driving agent are never released. Config key defaults off.

**Notes:** Product decision on the exemptions first. The plugin-provider and `agent-messages/delivery.ts` parts depend on B23.

### B32: Long-chat rendering and responsiveness fixes (adapted)

**Upstream commits (in order):**

- `8aec0787d` #5945 [ADAPT] fix(app): keep chat reading position stable while scrolling
- `5f28b3cf8` #5970 [ADAPT] fix(app): smooth chat history pagination and reserve image space
- `543e3712e` #6172 [ADAPT] fix(app): preserve chat rows across virtual layout changes
- `8d424e039` #7052 [ADAPT] Reduce rendering cost in long chats
- `559c0200e` #7342 [ADAPT] Reuse workspace and subagent lists while replies stream
- `90c6de058` #7256 [ADAPT] fix(app): keep streaming replies complete after reloading
- `d9b874f9d` #7033 [ADAPT] Scroll chat with Page Up and Page Down after clicking messages
- `bd5061e7b` #7278 [ADAPT] fix(app): stop blank rows while scrolling tall Android chats
- `095dd0316` #7284 [ADAPT] fix(app): avoid pane rerenders while resizing Explorer
- `c575464e8` #7358 [ADAPT] Skip saving unchanged workspace layouts
- `5dc350034` #7872 [ADAPT] Keep large Import Session lists responsive on Web

**JAgentDesk files to touch** (33, paths rebranded): `app:agent-stream/reading-anchor.ts`, `app:agent-stream/strategy-web.tsx`, `app:agent-stream/web-virtualization.ts`, `srv:agent/providers/mock-load-test-agent.ts`, `app:agent-stream/strategy.ts`, `app:agent-stream/view.tsx`, `app:assistant-image/use-assistant-image.ts`, `app:components/markdown/inline-image-size.ts`, `app:components/markdown/renderer.tsx`, `app:components/message.tsx`, `app:utils/assistant-image-metadata.ts`, `app:utils/assistant-message-height-estimate.ts`, `app:agent-stream/chat-find/types.ts`, `app:agent-stream/chat-outline/use-chat-outline.ts`, `app:agent-stream/model.ts`, `app:agent-stream/stream-tick.bench.ts`, `app:agent-stream/use-stream-history-window.ts`, `app:composer/submission/model.ts`, `app:stores/session-store.ts`, `app:timeline/turn-time.ts`, `app:screens/workspace/workspace-screen.tsx`, `app:subagents/select.ts`, `app:workspace-tabs/agent-visibility.ts`, `app:timeline/session-stream-reducers.ts`, `app:agent-stream/native-scroll-animation.ts`, `app:agent-stream/strategy-native.tsx`, `app:components/split-container.tsx`, `app:storage/validated-persist-storage.ts`, `app:stores/workspace-layout-store.ts`, `app:components/import-session-list.tsx` … +3

**Needs hand merge (sequential apply):** `strategy-web.tsx` (8aec0787d, 5f28b3cf8, 543e3712e, d9b874f9d); `R:web-virtualization.ts` (8aec0787d); `mock-load-test-agent.ts` (8aec0787d); `strategy.ts` (5f28b3cf8); `view.tsx` (5f28b3cf8, 8d424e039); `web-virtualization.ts` (5f28b3cf8); `renderer.tsx` (5f28b3cf8); `message.tsx` (5f28b3cf8); `assistant-image-metadata.ts` (5f28b3cf8); `assistant-message-height-estimate.ts` (5f28b3cf8); `use-chat-outline.ts` (8d424e039); `session-store.ts` (8d424e039); `turn-time.ts` (8d424e039); `workspace-screen.tsx` (559c0200e); `agent-visibility.ts` (559c0200e); `session-stream-reducers.ts` (90c6de058); `strategy-native.tsx` (bd5061e7b); `split-container.tsx` (095dd0316); `validated-persist-storage.ts` (c575464e8); `workspace-layout-store.ts` (c575464e8); `import-session-sheet.tsx` (5dc350034)

**Verify:** Re-run the v0.9.44 long-chat measurements (40-turn streaming chat: renderer CPU, p95 frame time) and require no regression.

**Notes:** Overlaps JAgentDesk's own `fb0a93438` perf work. Compare each upstream change against JAgentDesk `strategy-web.tsx`/`web-virtualization.ts` instead of applying it.

### B33: Terminal image paste and file drop into agent TUIs (adapted)

**Upstream commits (in order):**

- `9d908d678` #3795 [ADAPT] feat(terminal): support image paste into agent TUIs, local and remote

**JAgentDesk files to touch** (20, paths rebranded): `packages/app/package.json`, `packages/app/scripts/build-terminal-webview-html.mjs`, `app:attachments/upload-limit.ts`, `app:components/file-drop/file-drop-backdrop.tsx`, `app:components/file-drop/types.ts`, `app:components/file-drop/use-drop-listeners.ts`, `app:components/terminal-copy-paste-actions.tsx`, `app:components/terminal-emulator-contract.ts`, `app:components/terminal-emulator-webview.native.tsx`, `app:components/terminal-emulator.tsx`, `app:components/terminal-pane.tsx`, `app:components/toast-host.tsx`, `app:composer/actions.ts`, `app:terminal/drop/terminal-file-drop.ts`, `app:terminal/drop/terminal-path.ts`, `app:terminal/file-paste/index.ts`, `app:terminal/runtime/terminal-emulator-runtime.ts`, `app:terminal/runtime/terminal-paste.ts`, `app:terminal/webview/terminal-emulator-webview-entry.ts`, `app:terminal/webview/terminal-emulator-webview-html.ts` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `package.json` (9d908d678); `terminal-pane.tsx` (9d908d678); `toast-host.tsx` (9d908d678); `actions.ts` (9d908d678); `en.ts` (9d908d678); `terminal-emulator-webview-html.ts` (9d908d678)

**Verify:** Desktop: paste a screenshot into a Claude Code TUI in a JAgentDesk terminal (local and remote host). Drop a file and the path is inserted.

**Notes:** Uses the upload path, so test it over the tailnet. Do it before any WebView-renderer removal (`6376f2bf4`).

### B34: Diff review: Send feedback, mobile comment sheets, All changes scope (adapted)

**Upstream commits (in order):**

- `b26b9234c` #6455 [ADAPT] Improve diff review with mobile comment sheets and direct feedback
- `d29814186` [ADAPT] fix(app): dismiss review feedback confirmation with a toast
- `c63e1204b` #7576 [ADAPT] Review all branch changes by default without automatic scope switching

**JAgentDesk files to touch** (30, paths rebranded): `app:components/ui/button.tsx`, `app:components/ui/floating-action-button.tsx`, `app:components/ui/floating-action-layout.ts`, `app:components/ui/isolated-bottom-sheet-modal/visibility-tracker.ts`, `app:git/diff-pane.tsx`, `app:git/jump-to-file/index.tsx`, `app:git/use-working-diff.ts`, `app:review/comment-sheet.tsx`, `app:review/editor/index.ts`, `app:review/feedback/index.ts`, `app:review/feedback/surface.tsx`, `app:review/feedback/use-feedback.ts`, `app:review/geometry.ts`, `app:review/index.ts`, `app:review/store.ts`, `app:review/surface.tsx`, `app:data/push-router.ts`, `app:git/checkout-status-cache.ts`, `app:git/query-keys.ts`, `app:git/use-diff-query.ts`, `app:git/working-diff-comparison/index.ts`, `app:git/working-diff-comparison/state.ts`, `app:review/state.ts`, `client:daemon-client.ts`, `proto:messages.ts`, `srv:checkout-diff-cache.ts`, `srv:checkout-diff-manager.ts`, `srv:websocket-server.ts`, `srv:workspace-git-service.ts`, `srvsrc:utils/checkout-git.ts` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `floating-action-button.tsx` (b26b9234c); `diff-pane.tsx` (b26b9234c, c63e1204b); `index.tsx` (b26b9234c); `use-working-diff.ts` (b26b9234c, c63e1204b); `geometry.ts` (b26b9234c); `index.ts` (b26b9234c, c63e1204b); `surface.tsx` (b26b9234c); `checkout-status-cache.ts` (c63e1204b); `use-diff-query.ts` (c63e1204b); `state.ts` (c63e1204b, c63e1204b); `daemon-client.ts` (c63e1204b); `messages.ts` (c63e1204b); `websocket-server.ts` (c63e1204b)

**Verify:** Diff pane: Send feedback reaches the agent without opening its chat. Phone: comment in a sheet. Changes defaults to All changes since branch base.

**Notes:** `review/` and `git/diff-pane.tsx` differ in JAgentDesk. `c63e1204b` changes a protocol message (`messages.ts`).

### B35: Assistant and Markdown-preview file/folder links

**Upstream commits (in order):**

- `06cdc5a0b` #7210 [ADAPT] fix(app): open nested Markdown folder links without dot prefixes
- `a0aeca967` #7233 [ADAPT] fix(app): open explicit file links regardless of extension
- `fa70b215a` #7205 [ADAPT] Open chat folder links in Files with their contents visible
- `5384abdba` #7229 [ADAPT] fix(app): open Markdown preview folder links in Files
- `c70a6cfb9` #7538 [ADAPT] fix(app): resolve Markdown preview links from their document
- `a8032a150` #7726 [ADAPT] fix(app): open outside folder links without breaking Files
- `9eaf7ad0c` #6750 [ADAPT] Render local images in Markdown file previews
- `8c9499dac` #7842 [ADAPT] fix(app): dismiss file link tooltips when leaving their panel

**JAgentDesk files to touch** (20, paths rebranded): `app:assistant-file-links/parse.ts`, `app:assistant-file-links/resolver.ts`, `app:agent-stream/view.tsx`, `app:assistant-file-links/index.ts`, `app:assistant-file-links/path-open.ts`, `app:file-explorer/tree.ts`, `app:hooks/use-file-explorer-actions.ts`, `app:screens/workspace/workspace-screen.tsx`, `app:assistant-file-links/provider.tsx`, `app:assistant-file-links/use-file-link.ts`, `app:file-panels/markdown-preview/index.tsx`, `app:workspace/open-in-file-manager/outside-folder.ts`, `desk:features/editor-targets/registry.ts`, `desk:features/editor-targets/runtime.ts`, `desk:features/editor-targets/target.ts`, `app:file-pane/markdown-preview/image-source.ts`, `app:file-pane/markdown-preview/index.tsx`, `app:file-pane/markdown-preview/preview-image.tsx`, `app:file-pane/pane.tsx`, `app:components/ui/tooltip.tsx` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `parse.ts` (a0aeca967, c70a6cfb9); `view.tsx` (fa70b215a, a8032a150); `index.ts` (fa70b215a); `use-file-explorer-actions.ts` (fa70b215a); `workspace-screen.tsx` (5384abdba, a8032a150); `index.tsx` (c70a6cfb9, 9eaf7ad0c); `pane.tsx` (9eaf7ad0c); `tooltip.tsx` (8c9499dac)

**Verify:** `vitest run` on the `assistant-file-links/*.test.ts` that come with the commits. Desktop: a chat link to a folder opens Files with its contents; a relative link in a Markdown preview resolves from the document; an outside-folder link shows an error without replacing Files.

**Notes:** JAgentDesk Files pane hosts the restored editor, so check that `file-pane/pane.tsx` still opens files in the editor.

### B36: Daemon config, schema and metadata generation

**Upstream commits (in order):**

- `457414231` #7611 [ADAPT] fix(server): use only the configured models for manual metadata generation
- `1939ee79e` #6621 [ADAPT] Accept daemon settings in the published editor schema
- `71b236d38` #5649 [ADAPT] fix(server): update the running npm installation prefix
- `cf2b3f4bb` #6095 [ADAPT] Name a linked global install as the reason daemon self-update is refused
- `3a1b14669` #7991 [ADAPT] Guard daemon modules against synchronous Node IO

**JAgentDesk files to touch** (11, paths rebranded): `app:screens/settings/metadata-generation-page.tsx`, `srv:agent/agent-response-loop.ts`, `srv:agent/structured-generation-providers.ts`, `srv:session.ts`, `srv:session/checkout/git-metadata-generator.ts`, `srv:persisted-config.ts`, `srv:session/daemon/daemon-self-updater.ts`, `srv:session/daemon/install-origin.ts`, `srv:session/daemon/npm-global-cli.ts`, `.oxlintrc.json`, `scripts/oxlint/jagentdesk-plugin.mjs` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `en.ts` (457414231); `metadata-generation-page.tsx` (457414231); `paseo-plugin.mjs` (3a1b14669)

**Verify:** Metadata generation with configured models only and no fallback (matches JAgentDesk's no-hidden-model-calls policy). Regenerate the published config JSON schema including JAgentDesk keys. Self-update messages for npm-prefix installs.

**Notes:** `3a1b14669` (oxlint rule against sync IO) is optional. Adapt it to the JAgentDesk lint config, or skip. Self-update matters only for npm-installed daemons, not the desktop-bundled one.

### B37: Tool-call labels, subagent facts and lone tool calls

**Upstream commits (in order):**

- `727d5eed5` #7357 [ADAPT] fix(protocol): preserve the published tool detail import
- `9521ee995` #7283 [ADAPT] feat(app): label Paseo tool calls verb-first with their context
- `fc12843ce` #7290 [ADAPT] feat(app): show each subagent's model and effort under its title
- `d61dcaf1d` #7364 [ADAPT] fix(app): give subagent rows room on compact and standard press feedback
- `d6d04b0c5` #8109 [ADAPT] Show a lone tool call as itself and group from the second call

**JAgentDesk files to touch** (27, paths rebranded): `proto:jagentdesk-tool-call-detail.ts`, `app:agent-stream/view.tsx`, `app:components/message.tsx`, `app:components/tool-call-details.tsx`, `app:tool-calls/presentation.ts`, `app:tool-calls/use-target-agent-title.ts`, `app:utils/tool-call-icon-name.ts`, `app:utils/tool-call-icon.ts`, `proto:agent-message-display.ts`, `proto:jagentdesk-tool-presentation/agent-message.ts`, `proto:jagentdesk-tool-presentation/catalog.ts`, `proto:jagentdesk-tool-presentation/detail-sections.ts`, `proto:jagentdesk-tool-presentation/index.ts`, `proto:jagentdesk-tool-presentation/summary-text.ts`, `proto:tool-call-display.ts`, `srv:agent/activity-curator.ts`, `srv:agent/agent-sdk-types.ts`, `app:panels/agent-facts-line.ts`, `app:panels/agent-panel.tsx`, `app:subagents/track.tsx`, `.oxlintrc.json`, `app:composer/tracks.tsx`, `scripts/oxlint/jagentdesk-plugin.mjs`, `app:tool-calls/detail-level/grouping.ts`, `app:tool-calls/detail-level/overview/sheet.tsx`, `app:tool-calls/expansion-context.tsx`, `app:tool-calls/expansion.ts`

**Needs hand merge (sequential apply):** `paseo-tool-call-detail.ts` (727d5eed5); `view.tsx` (9521ee995, d6d04b0c5); `message.tsx` (9521ee995, d6d04b0c5); `tool-call-details.tsx` (9521ee995); `presentation.ts` (9521ee995); `agent-facts-line.ts` (fc12843ce); `agent-panel.tsx` (fc12843ce); `track.tsx` (fc12843ce, d61dcaf1d); `.oxlintrc.json` (d61dcaf1d); `tracks.tsx` (d61dcaf1d); `sheet.tsx` (d6d04b0c5)

**Verify:** Every JAgentDesk tool (ORC, browser, database, k8s, docker, forge, simulator) gets a verb-first label and context. Snapshot-test `tool-calls/presentation.ts`.

**Notes:** `9521ee995` adds `protocol/src/jagentdesk-tool-presentation/*`; extend its catalog with the JAgentDesk-only tools. `d6d04b0c5` grouping works with the current `tool-calls/detail-level/grouping.ts`.

### B38: Command Center ranking and status

**Upstream commits (in order):**

- `a65478d0b` #7277 [ADAPT] Rank Command Center results by match then recency, with highlights, timestamps, and project icons
- `4b9b2fe13` #7688 [ADAPT] fix(app): preserve manual Command Center scrolling during live updates
- `6405edd8d` #7690 [ADAPT] feat(app): show consistent agent and workspace status in search

**JAgentDesk files to touch** (14, paths rebranded): `app:command-center/command-center.tsx`, `app:command-center/list-metrics.ts`, `app:command-center/results.ts`, `app:command-center/workspace-search.ts`, `app:components/agent-list.tsx`, `app:components/ui/highlighted-text-segments.ts`, `app:utils/projects.ts`, `app:command-center/interaction.ts`, `app:agent-presentation/index.ts`, `app:components/status-icon.tsx`, `app:hooks/sidebar-workspaces-view-model.ts`, `app:panels/agent-panel.tsx`, `app:screens/workspace/workspace-tab-presentation.tsx`, `app:workspace-status/index.ts`

**Needs hand merge (sequential apply):** `command-center.tsx` (a65478d0b, 4b9b2fe13, 6405edd8d); `results.ts` (a65478d0b, 6405edd8d); `workspace-search.ts` (a65478d0b); `agent-list.tsx` (a65478d0b); `highlighted-text-segments.ts` (a65478d0b); `projects.ts` (a65478d0b); `sidebar-workspaces-view-model.ts` (6405edd8d); `agent-panel.tsx` (6405edd8d); `workspace-tab-presentation.tsx` (6405edd8d)

**Verify:** Command Center: results ranked by match, then recency; status icons match the tabs; manual scroll is not reset by live updates.

**Notes:** JAgentDesk command-center differs (the 0.8.0 chain was RISKY), so reimplement the ranking in `command-center/results.ts`.

### B39: Settings and UI polish (content width, live timestamps, i18n loading, settings navigation, combobox/tooltip fixes)

**Upstream commits (in order):**

- `05874e289` #5340 [ADAPT] Keep relative timestamps current in agent, schedule, and import-session rows
- `cc744cc66` #5680 [ADAPT] feat(app): let users set the chat and Markdown content width
- `b9ac1d498` #5620 [ADAPT] fix(app): add a Back to plugins link to plugin settings screens on desktop
- `81a5e5bc6` #6196 [ADAPT] Show the PR checks summary, sidebar status, and "Worked for" line in the app language
- `fc775b6db` #7410 [ADAPT] Load translations when their language is selected
- `16fe07560` [ADAPT] fix(app): make question cards link-aware and selectable without accidental answers
- `631ed0408` #7893 [ADAPT] fix(app): preserve host selection across settings navigation
- `5e53bb78c` #7899 [ADAPT] fix(app): keep your place in the Settings sidebar
- `b8bb335c5` #7783 [ADAPT] fix(app): close comboboxes when their retained panel becomes inactive
- `025e7ef1d` #8039 [ADAPT] Keep model-discovery errors away from picker edges
- `dd914c147` #8052 [ADAPT] Keep docked navigation sizes consistent in narrow windows
- `e958540b0` #7915 [ADAPT] fix(app): remove SVG prop and nested button warnings on web

**JAgentDesk files to touch** (62, paths rebranded): `app:components/agent-list.tsx`, `app:components/import-session-sheet.tsx`, `app:components/provider-diagnostic-sheet.tsx`, `app:components/schedules/schedule-row.tsx`, `app:components/sidebar/workspace-trailing/index.tsx`, `app:git/commits-section/commit-row.tsx`, `app:git/commits-section/commits-section.tsx`, `app:hooks/use-time-ago.ts`, `app:screens/workspace/workspace-desktop-tabs-row.tsx`, `app:usage/card.tsx`, `app:utils/time.ts`, `app:agent-stream/strategy-web.tsx`, `app:agent-stream/strategy.ts`, `app:agent-stream/turn-footer.tsx`, `app:agent-stream/view.tsx`, `app:agent-stream/web-virtualization.ts`, `app:appearance/apply.ts`, `app:appearance/provider.tsx`, `app:components/archived-agent-callout.tsx`, `app:composer/dock/index.native.tsx`, `app:composer/dock/index.tsx`, `app:composer/draft/workspace-tab.tsx`, `app:composer/index.tsx`, `app:composer/tracks.tsx`, `app:constants/layout.ts`, `app:file-pane/markdown-preview/index.tsx`, `app:hooks/use-settings/index.ts`, `app:hooks/use-settings/storage.ts`, `app:panels/agent-panel.tsx`, `app:screens/settings/appearance/appearance-section.tsx` … +32 (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `agent-list.tsx` (05874e289); `import-session-sheet.tsx` (05874e289); `provider-diagnostic-sheet.tsx` (05874e289); `schedule-row.tsx` (05874e289); `index.tsx` (05874e289, cc744cc66, cc744cc66, cc744cc66); `commits-section.tsx` (05874e289); `workspace-desktop-tabs-row.tsx` (05874e289); `card.tsx` (05874e289); `time.ts` (05874e289); `strategy-web.tsx` (cc744cc66); `turn-footer.tsx` (cc744cc66); `view.tsx` (cc744cc66); `apply.ts` (cc744cc66); `provider.tsx` (cc744cc66); `archived-agent-callout.tsx` (cc744cc66); `index.native.tsx` (cc744cc66); `workspace-tab.tsx` (cc744cc66, dd914c147); `tracks.tsx` (cc744cc66, e958540b0); `index.ts` (cc744cc66); `storage.ts` (cc744cc66); `en.ts` (cc744cc66, b9ac1d498, 81a5e5bc6); `agent-panel.tsx` (cc744cc66, dd914c147); `appearance-section.tsx` (cc744cc66); `settings-screen.tsx` (b9ac1d498, 631ed0408, 5e53bb78c, dd914c147); `message.tsx` (81a5e5bc6); `project-leading-visual.tsx` (81a5e5bc6); `sidebar-model.tsx` (81a5e5bc6); `sidebar-projection.ts` (81a5e5bc6); `sidebar-workspace-menu.tsx` (81a5e5bc6); `sidebar-workspace-title.ts` (81a5e5bc6); `checks-section.tsx` (81a5e5bc6); `checks-summary.ts` (81a5e5bc6); `sidebar-status-view-model.ts` (81a5e5bc6); `i18next.ts` (fc775b6db); `vitest.config.ts` (fc775b6db, 16fe07560); `renderer.tsx` (16fe07560); `styles.ts` (16fe07560); `question-form-card.tsx` (16fe07560); `combobox.tsx` (b8bb335c5); `model-browser.tsx` (025e7ef1d); `layout.ts` (dd914c147); `unistyles.ts` (dd914c147); `context-window-meter.tsx` (e958540b0); `checks-ring.tsx` (e958540b0); `react-native-unistyles+3.2.4.patch` (e958540b0); `postinstall-patches.mjs` (e958540b0)

**Verify:** Content width setting on a wide desktop window; Settings keeps the selected host and sidebar scroll; app startup loads only one language (measure bundle and parse time).

**Notes:** Re-implement on the JAgentDesk settings layout (ClickUp). `fc775b6db`: JAgentDesk `en.ts` is much larger than upstream's, so the startup gain should be measurable.

### B40: Mobile and tablet fixes that fit the JAgentDesk mobile shell

**Upstream commits (in order):**

- `9952c5598` #5713 [ADAPT] fix(app): restore native tablet touch actions
- `318a84a57` #5772 [ADAPT] Keep native dialogs and sheets usable when stacked
- `30fb66c8c` #6058 [ADAPT] fix(app): preserve mobile sidebar scroll position when reopening
- `283a985fb` #6707 [ADAPT] fix(app): keep Android status icons readable as themes change
- `6db47b3c3` #6945 [ADAPT] fix(app): keep the keyboard closed after mobile sidebar dismissal
- `0d7a234e6` #7157 [ADAPT] perf(app): preserve unchanged sidebar workspace projections
- `98559bf72` #7159 [ADAPT] fix(app): release iOS sidebar rows after an interrupted drag
- `ec9817ed2` #7167 [ADAPT] fix(app): make home actions reachable on short screens
- `ec6393f31` #6758 [ADAPT] Keep pairing QR codes fully visible on mobile
- `9ed4f1069` #7308 [ADAPT] fix(app): create project workspaces on the active host
- `19749baee` #7362 [ADAPT] Keep Android settings inputs visible above the keyboard
- `0d61cca50` #7429 [ADAPT] fix(app): identify Android certificate failures as TLS errors
- `12e7a448f` #7612 [ADAPT] fix(app): open notification agents once in their current workspace
- `c3c6a936a` #7630 [ADAPT] List plugin header buttons in the workspace menu on phones and narrow windows
- `48623801a` #7768 [ADAPT] fix(app): keep tablet sidebar controls above system navigation
- `6bc4b73c4` #7896 [ADAPT] fix(app): keep the sidebar alive when a workspace entry has not hydrated
- `73390346c` #6445 [ADAPT] fix(ios): address clipped chat and Markdown text

**JAgentDesk files to touch** (63, paths rebranded): `app:components/context-window-meter.tsx`, `app:components/ui/external-link.tsx`, `app:components/ui/tooltip.tsx`, `app:screens/workspace/workspace-desktop-tabs-row.tsx`, `app:components/adaptive-modal-sheet.tsx`, `packages/app/maestro/sidebar-scroll-retention.yaml`, `app:mobile-panels/presentation.tsx`, `app:appearance/provider.tsx`, `app:appearance/system-bars.android.tsx`, `app:appearance/system-bars.tsx`, `app:composer/index.tsx`, `app:composer/input/input.tsx`, `app:composer/keyboard-scope.tsx`, `app:hooks/sidebar-workspaces-view-model.ts`, `patches/react-native-draggable-flatlist+4.0.3.patch`, `app:screens/open-project-screen.tsx`, `app:desktop/components/pair-device-section.tsx`, `app:components/sidebar-workspace-list.tsx`, `app:utils/sidebar-project-row-model.ts`, `app:components/page-layout/index.tsx`, `app:components/add-host-modal.tsx`, `app:components/connection-failure-copy.ts`, `app:app/_layout.tsx`, `app:app/h/[serverId]/agent/[agentId].tsx`, `app:app/h/[serverId]/workspace/[workspaceId]/index.tsx`, `app:fdroid/expo-notifications.ts`, `app:navigation/agent-route-resolution.ts`, `app:notification-open/index.ts`, `app:notification-open/model.ts`, `app:notification-open/react/index.tsx` … +33

**Needs hand merge (sequential apply):** `workspace-desktop-tabs-row.tsx` (9952c5598); `adaptive-modal-sheet.tsx` (318a84a57); `presentation.tsx` (30fb66c8c); `provider.tsx` (283a985fb); `index.tsx` (6db47b3c3, 19749baee, 12e7a448f); `input.tsx` (6db47b3c3); `react-native-draggable-flatlist+4.0.3.patch` (98559bf72); `open-project-screen.tsx` (ec9817ed2); `sidebar-workspace-list.tsx` (9ed4f1069, 6bc4b73c4); `add-host-modal.tsx` (0d61cca50); `_layout.tsx` (12e7a448f); `workspace-screen.tsx` (12e7a448f, c3c6a936a); `index.ts` (12e7a448f); `navigation.ts` (12e7a448f); `workspace-layout-store.ts` (12e7a448f); `resolve.ts` (12e7a448f); `view.tsx` (c3c6a936a); `workspace-header-menu.tsx` (c3c6a936a); `sidebar-group-visibility.ts` (6bc4b73c4); `package.json` (73390346c, 73390346c, 73390346c, 73390346c, 73390346c, 73390346c, 73390346c, 73390346c, 73390346c, 73390346c, 73390346c, 73390346c); `R:react-native-uitextview+2.2.0.patch` (73390346c); `postinstall-patches.mjs` (73390346c)

**Verify:** iOS simulator and an Android device: stacked sheets, tablet touch actions, keyboard after dismissing the sidebar, pairing QR fully visible, TLS/DNS error copy, notification taps open the agent once, sidebar survives an unhydrated workspace entry.

**Notes:** Each item must be checked against the JAgentDesk ClickUp mobile shell; drop items whose code path no longer exists. `12e7a448f` touches notification routing (34 files).

### B41: Native/build items (check the JAgentDesk Expo version first)

**Upstream commits (in order):**

- `b63a325be` #6339 [ADAPT] Let Android devices without a camera install Paseo from Google Play
- `e86777393` #6734 [ADAPT] Restore native app startup
- `59b01b33f` #7705 [ADAPT] fix(app): build iOS releases with the foldable-capable SDK
- `5d70bf064` #7546 [ADAPT] fix(android): restore image picker after Activity recreation
- `ff31b6e5b` #7907 [ADAPT] fix(android): skip Reanimated sync prop updates for unmounted views
- `e277656cb` #7914 [ADAPT] fix(app): clean up native animation and layout lifecycles

**JAgentDesk files to touch** (14, paths rebranded): `packages/app/app.config.js`, `packages/app/plugins/with-android-optional-camera.js`, `packages/app/index.ts`, `app:app/_layout.tsx`, `app:polyfills/install-early.ts`, `packages/app/eas.json`, `patches/expo-modules-core+57.0.23.patch`, `scripts/postinstall-patches.mjs`, `patches/react-native-reanimated+4.5.1.patch`, `package.json`, `packages/app/package.json`, `patches/@gorhom+bottom-sheet+5.2.14.patch`, `patches/react-native-enriched-markdown+1.2.0-nightly-20261014-766fc0e67.patch`, `patches/react-native-reanimated+4.5.5.patch`

**Needs hand merge (sequential apply):** `app.config.js` (b63a325be); `_layout.tsx` (e86777393); `postinstall-patches.mjs` (5d70bf064, ff31b6e5b, e277656cb); `package.json` (e277656cb, e277656cb); `@gorhom+bottom-sheet+5.2.14.patch` (e277656cb); `react-native-enriched-markdown+1.2.0-nightly-20261014-766fc0e67.patch` (e277656cb)

**Verify:** EAS cloud build (profile `development-simulator`) plus a real device run.

**Notes:** `ff31b6e5b`, `e277656cb` and `5d70bf064` patch Expo 57 / RN 0.86 packages. Port them only after E3, or re-derive them for Expo 54. `b63a325be`: Android optional camera, needed for Play listing coverage.

### B42: Remove the WebView terminal renderer

**Upstream commits (in order):**

- `6376f2bf4` #7639 [ADAPT] Remove the WebView terminal renderer: xterm on web, native grid on mobile

**JAgentDesk files to touch** (12, paths rebranded): `packages/app/package.json`, `packages/app/scripts/build-terminal-webview-html.mjs`, `app:components/terminal-emulator-webview.native.tsx`, `app:components/terminal-emulator.native.tsx`, `app:components/terminal-webview-message-routing.ts`, `app:components/terminal-webview-readiness.ts`, `app:hooks/use-settings/storage.ts`, `app:screens/settings-screen.tsx`, `app:terminal/file-paste/index.ts`, `app:terminal/native-renderer/terminal-renderer-capability.ts`, `app:terminal/webview/terminal-emulator-webview-entry.ts`, `app:terminal/webview/terminal-emulator-webview-html.ts` (plus `app:i18n/resources/en.ts`)

**Needs hand merge (sequential apply):** `package.json` (6376f2bf4); `storage.ts` (6376f2bf4); `settings-screen.tsx` (6376f2bf4); `terminal-emulator-webview-html.ts` (6376f2bf4)

**Verify:** iOS and Android terminals run on the native grid only: CJK, selection, paste, the key bar.

**Notes:** Do last, after B17 and B33. JAgentDesk still builds `terminal-emulator-webview.native.tsx` and `build-terminal-webview-html.mjs`.
