# Progress: Paseo 0.10.2 → 0.14.0 port

Worktree `hdc/jagentdesk-paseo014`, branch `feat/paseo-0.14` (from v0.9.46 `791ae37c7`). Coder:
opencode `tars/qwen3.8-flash-next` with `CODER.md`; reviewer: Claude Opus 5.5.

| Batch                   | State                     | Commits                       | Review evidence                                                                                                                                                          |
| ----------------------- | ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01 Security quick wins | done, reviewed 2026-11-02 | `ddc537d5c` … `e930e99cd` (6) | `npm run typecheck` pass; unit tests pass except 2 failures that also fail at `d31093634` (Claude question notification text); real-provider e2e tests not runnable here |
| B02–B42                 | not started               |                               |                                                                                                                                                                          |

Known pre-existing failures: `claude/agent.test.ts` "renders the notification as the question…",
"falls back to the question alone…"; `packages/desktop/src/features/opener.test.ts` (2).

Next: dispatch B02 the same way (`opencode run -m tars/qwen3.8-flash-next --auto … > .dev/port-logs/B02.log`),
then review (diff, rebrand residue, typecheck, vitest on touched folders).
