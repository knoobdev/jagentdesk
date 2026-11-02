# Coder brief: porting Paseo 0.10.2 → 0.14.0 into JAgentDesk

You are the coder (opencode). The spec owner reviews every batch. Work only in this worktree
(`/Users/ngocchanh/Project/private/organisations/hdc/jagentdesk-paseo014`, branch `feat/paseo-0.14`).

Read first:

- `AGENTS.md` / `CLAUDE.md` of this repo (coding standards, testing rules).
- `docs/plans/active/paseo-0.14-port/batches.md` — the batch list; the full inventory with every
  commit's reasoning is in the spec repo:
  `/Users/ngocchanh/Project/private/organisations/remote-coding-app-spec/docs/reference/paseo-0.14.0-port-inventory.md`
  (section "### Bxx").

## Setup

Dependencies are installed. If a package's `dist` is missing, run `npm run build:server` (builds
highlight, protocol, client, plugin, server, cli). Baseline `npm run typecheck` passes at the start.

## Rules

1. Port one upstream commit at a time, in the order listed for the batch:
   `scripts/port-upstream-commit.sh <sha>`. It rebrands (`paseo`→`jagentdesk`, `Paseo`→`JAgentDesk`,
   `PASEO_`→`JAGENTDESK_`, `@getpaseo/`→`@jagentdesk/`) and applies with a 3-way merge.
2. On conflict: resolve by keeping JAgentDesk's own features AND the upstream fix (never delete a
   JAgentDesk feature to make a patch apply), `git add` the files, `git am --continue`, then
   `scripts/port-upstream-commit.sh --finish <sha>`. If a commit cannot be ported sensibly, run
   `git am --abort`, skip it and write the reason in your final report.
3. Commits marked ADAPT in the inventory: reimplement the behavior by hand in JAgentDesk's code (one
   commit, message `port(paseo): <upstream subject> (<sha>)` + trailer `Ported-from: Paseo <sha>`).
4. Check every rebranded string: user-visible text says JAgentDesk; URLs to `paseo.cafe` and
   `github.com/getpaseo` and the `requirements.paseo` / `SUPPORTED_PASEO_PLUGIN_API` names stay.
5. JAgentDesk-specific areas you must not break: Tailscale transport and pairing, Team mode/forum,
   skills hub, plugins (`paseo-rebrand.ts`), agentic browser stealth/dialogs, host capabilities,
   databases/k8s/forge/docker/simulators/workbench, the restored code editor, ClickUp theme.
6. Port the tests the upstream commits add. After the batch run, for every touched workspace:
   `npm run typecheck --workspace=<pkg>` and `npx vitest run <touched folders>`; fix failures you
   caused. Pre-existing failures (e.g. `packages/desktop/src/features/opener.test.ts`) are not yours.
7. Run `npx oxfmt <changed files>` before each commit (lefthook fails silently otherwise). Never use
   `--no-verify` except inside the helper's trailer amend.
8. Do not push, tag, release, edit `package.json` versions, or touch files outside the batch.
9. Final message: list each upstream sha → `ported` / `adapted` / `skipped (reason)`, the commands
   you ran with pass/fail counts, and anything the reviewer should check by hand.
