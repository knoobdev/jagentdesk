# Paseo v0.10.2 → v0.14.0: port inventory for JAgentDesk

- **Upstream**: `hdc/paseo-upstream`, range `v0.10.2..v0.14.0` (`919c737c1` 2026-09-30 → `8c6de842a` 2026-10-29). 661 commits, 1 merge commit (`78c7a9ce3`). The patch tags `v0.10.3`, `v0.11.1`–`v0.11.4`, `v0.13.1` and `v0.13.2` were cut on side branches. Each of their code commits has an equivalent on main (checked with `git cherry`), so this range covers them.
- **Target**: `hdc/jagentdesk` branch `feat/cross-platform-hosts`, HEAD `791ae37c7` (v0.9.46). The analysis ran on a clean `git archive HEAD` export at `/tmp/jd-head`, because the working tree has uncommitted edits in composer and session-store files.
- **Previous rounds**: 0.8.0–0.10.1 were ported in v0.9.44 (`768cd5842`). The 0.10.2 OpenCode v2 fixes are `b7aa601d4`, `b28934146`, `e5e8863a4`, `9c23891d0` and `dbc5bee5d` (v0.9.45). JAgentDesk declares Paseo plugin API `>=0.8.0-0 <=0.10.2` in `packages/server/src/server/plugins/paseo-rebrand.ts:27`.
- **Scratch artefacts** (read-only analysis): `/tmp/port-scripts/scan.json` holds the per-commit file and apply data, `ann.txt` holds the classifications, `batches.txt` and `seq.json` hold the batch plan and the result of applying batches in sequence.

## Method

1. `git log v0.10.2..v0.14.0`. 166 commits are mechanical skips: 33 lockfile/Nix-hash bot, 46 release cut or changelog, 45 website, 26 tests/CI, 8 docs or Paseo-skill text, 2 Nix, 2 store screenshots, 4 other. They are listed at the end. The remaining **495 commits** were classified one by one.
2. **Main files** for each commit = the files it changed, minus tests, e2e, fixtures, non-English i18n, docs, website and lockfiles. Prefixes: `app:` = `packages/app/src/`, `srv:` = `packages/server/src/server/`, `srvsrc:` = `packages/server/src/`, `proto:`/`client:`/`cli:`/`desk:`/`plugin:`/`hl:` = the matching `packages/*/src/`.
3. **Apply** column: the patch for each main file was rebranded (`@getpaseo→@jagentdesk`, `PASEO→JAGENTDESK`, `Paseo→JAgentDesk`, `paseo→jagentdesk`, in content and paths) and run through `git apply --check` against JAgentDesk HEAD.
   - `F` = applies cleanly, including creating a new file.
   - `R` = reverse-applies, i.e. already present.
   - `X` = the file exists but a hunk does not match.
   - `M` = the file is missing in JAgentDesk.
   - `E` = an upstream-added file exists in JAgentDesk with different content.
   - `D`/`d` = deletion; the file is absent / present in JAgentDesk.
4. **Already-have** check: subject and PR matched against the JAgentDesk log since 2026-09-01 (`port(...)`, `(#NNNN)`, `upstream <sha>`). Also matched against the 15 commits in the range that duplicate 0.10.1/0.10.2 release-branch commits. Spot-checked by grep (for example `terminal-profiles.ts:12` `cursor-agent`, `codex-app-server-agent.ts:263` `CODEX_HOME`).
5. **Batch check**: the 34 proposed batches were applied in order, cumulatively, to a scratch copy (`/tmp/jd-seq`). For each batch the report gives the files that applied and the source files that need a hand merge. This is a mechanical signal only. **Nothing was typechecked or run.**

**Recommendation codes**

| Code      | Meaning                                                                                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PORT**  | Self-contained and low risk. Cherry-pick and rebrand, or fix small context drift (`X` hunks of a few lines).                                                                                                                                                                  |
| **ADAPT** | Worth having, but it touches diverged JAgentDesk files or JAgentDesk features (Tailscale/pairing, Team mode/ORC, skills hub, ClickUp shell, agentic browser, restored editor), changes protocol or config, or needs a small prerequisite. Reimplement from the upstream diff. |
| **DEFER** | Worth having but blocked by a large prerequisite chain that JAgentDesk does not have (see "Epics"). Not for this cycle. Counted under skip in the summary.                                                                                                                    |
| **SKIP**  | Not applicable to JAgentDesk: relay, Paseo Hub, built-in plugin providers JAgentDesk does not run, Nix, upstream release infrastructure. Also: conflicts with JAgentDesk design (ClickUp sidebar and mobile shell), or reverted upstream.                                     |
| **HAVE**  | Already in JAgentDesk.                                                                                                                                                                                                                                                        |

## Key findings (read before porting)

1. **Upstream moved the mobile platform: Expo 54 → 57, React Native 0.81.5 → 0.86.3, React 19.1 → 19.2.3.** The upgrade has no commit of its own. It is inside `adf27de7d` "Keep Explorer consistent across phone, tablet and desktop layouts" (#7424, 147 files, +20.9k/−17.5k). JAgentDesk is still on Expo `^54.0.18` and RN `0.81.5` (`packages/app/package.json:67,103`). Every later native patch assumes Expo 57: `ff31b6e5b`, `e277656cb`, `b36ff056e`, `5d70bf064`, and the patches for `react-native-enriched-markdown`/`gesture-handler`/`reanimated`/`bottom-sheet`. They cannot be cherry-picked until JAgentDesk upgrades.
2. **Upstream replaced its Markdown renderer.** `eb1a8a2ec` (#6973, 129 files) moved to `react-native-enriched-markdown@1.2.0-nightly-20261014-766fc0e67`, a patched nightly, plus `mdast-util-*` and `micromark-*`. JAgentDesk still uses `react-native-markdown-display` with its own v0.9.44 performance work. 15 later Markdown fixes depend on the new renderer and are DEFER.
3. **The flagship 0.14 Chat display features need the timeline presentation layer, which JAgentDesk never took.** These are turn folding (`4bbacfed4` #7785, `b12eefb28` #7990, `1b8dbc38a` #8026, `b4e837a9f` #8042, `ef58ace42` #8010) and tool-call grouping (`d6d04b0c5` #8109). They need `agent-stream/presentation.ts`, `turn-membership.ts` and `user-message/`, all absent in JAgentDesk. This is chain A of the 0.10.1 inventory.
4. **Usage was re-architected as built-in plugins.** `792715e76` (#5465) moved it into root `plugins/*-usage-source` with a `BuiltinPluginLoader`, and 17 Usage follow-ups build on that. JAgentDesk keeps `app/src/provider-usage/` and `server/src/services/quota-fetcher/`, and has no built-in plugin loader and no `agent/plugin-provider.ts`. For the same reason Muse Code, Antigravity and Hoplite (plugin providers) do not apply.
5. **Plugin SDK parity is mechanically easy on the SDK side and hard on the app host side.** JAgentDesk `packages/plugin/src` is byte-identical to upstream v0.10.2 after rebrand: of 28 files, only `client/index.ts` differs, plus the renamed `*-context.tsx`. Upstream added 2.7k lines of SDK for 0.11–0.14: agent tools, MCP contributions, `process.ts`, `usage.ts`, translations, `icons.ts` and the `client/ui` entry. Marketplace plugins that declare `requirements.paseo >=0.11` are currently refused by JAgentDesk.
6. **Security items that apply to JAgentDesk** are listed in their own section below. The two relay fixes, `793b16c0d` (Noise NK replay protection) and `89727f43b` (relay password), are **N/A**: JAgentDesk has no relay. It uses tailnet plus `server/pairing/signed-hello.ts` and `nonce-challenge.ts`. Record that in an ADR rather than port them.
7. **The JAgentDesk features that conflict most** are listed here so story writers can flag them:
   - `agent/tools/jagentdesk-tools.ts` (6,159 lines, ORC/Team mode) and `session.ts` (9,228 lines). Touched by 30+ upstream commits.
   - The agent-to-agent messaging redesign: `d0bc188a5`, `d0568f9f1`, `f22775a8e`, `21e7ccb03`. It overlaps Team mode and `orchestration/runtime.ts`.
   - Idle runtime release (`8e5f53676`). It must not release Team leads, autorun agents or agents driving the browser.
   - Upstream sidebar and compact-header rework (about 25 commits), which conflicts with the ClickUp shell.
   - The plugin file-panel refactor (`1e0e56c72`, `e464fd3bd`, `76b32544c`), which rewires `file-pane/pane.tsx` and `file-pane/editor/view.web.tsx`. That is where JAgentDesk re-added the CodeMirror editor.
   - Upstream `services/forge-service.ts`, `gitea-service.ts` and `gitlab-service.ts`. They are unchanged in JAgentDesk since the 0.7.2 merge (`852ee1c52`), so upstream fixes to them apply. Forge Hub (`forge-registry.ts`, `forge-resolver.ts`) sits beside them, so retest Forge Hub after `0ed57187a` and `1228c01a1`.

## Summary

| Classification                           | Commits | Notes                                                                                                                                                        |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PORT                                     | 198     | Cherry-pick plus rebrand, or a small context fix                                                                                                             |
| ADAPT (port-adapted)                     | 169     | Reimplement or hand-merge into diverged JAgentDesk code                                                                                                      |
| HAVE (already in JAgentDesk)             | 13      | 15 commits in the range duplicate 0.10.1/0.10.2. 13 are in JAgentDesk; 2 (`7bb7d4ed0`, `f4ba16a0b`) are still blocked and counted as DEFER                   |
| DEFER (skip for now, blocked by an epic) | 47      | Timeline presentation, Markdown renderer, Usage-as-plugins, Explorer/Expo 57, file panels, background workspaces, Voice settings                             |
| SKIP (not applicable or conflicting)     | 68      | Relay/Hub, plugin providers (Muse/Antigravity/Hoplite), ClickUp-conflicting sidebar and mobile shell, Nix, upstream release infrastructure, reverted commits |
| SKIP (mechanical)                        | 166     | Lockfile bot, release/changelog, website, tests/CI, docs                                                                                                     |
| **Total**                                | **661** |                                                                                                                                                              |

By area (classified commits only):

| Area                                       | PORT | ADAPT | HAVE | DEFER | SKIP |
| ------------------------------------------ | ---- | ----- | ---- | ----- | ---- |
| Agents: Claude                             | 27   | 5     | 1    |       |      |
| Agents: Codex                              | 10   | 2     | 3    |       |      |
| Agents: OpenCode                           | 7    | 4     | 6    |       |      |
| Agents: OMP                                | 7    | 5     |      |       |      |
| Agents: Pi                                 | 6    | 1     |      |       |      |
| Agents: ACP/Cursor/Copilot                 | 10   | 1     |      |       |      |
| Providers: catalog/config/plugin providers | 2    | 3     |      |       | 9    |
| Agent orchestration / agent-to-agent       |      | 12    | 1    |       |      |
| Plugins                                    | 9    | 18    |      | 4     | 3    |
| Usage                                      |      |       |      | 14    | 3    |
| Chat / timeline                            | 12   | 14    | 1    | 8     | 1    |
| Markdown                                   | 3    |       |      | 11    |      |
| Composer                                   | 4    | 10    |      |       | 1    |
| Command Center                             |      | 3     |      |       |      |
| Sidebar                                    |      | 4     |      |       | 11   |
| Mobile/tablet layout                       |      | 9     |      |       | 16   |
| Settings                                   | 3    | 2     |      |       |      |
| Shared UI                                  | 1    | 5     |      |       | 2    |
| Localization                               | 2    | 2     |      |       |      |
| Keyboard                                   | 5    |       |      |       |      |
| Files/Explorer                             | 7    | 6     |      | 5     |      |
| Git/Changes/worktrees                      | 19   | 8     |      |       | 1    |
| Workspaces/scripts/setup                   | 4    | 9     |      | 3     | 1    |
| Terminal                                   | 12   | 4     | 1    |       |      |
| Voice                                      | 4    | 1     |      | 1     |      |
| Daemon robustness                          | 18   | 8     |      |       | 1    |
| Performance                                | 2    | 13    |      |       | 1    |
| CLI                                        | 12   | 2     |      | 1     | 1    |
| Protocol/client SDK                        | 2    | 3     |      |       |      |
| Hosts/pairing/relay                        | 1    | 4     |      |       | 9    |
| Schedules                                  | 2    |       |      |       |      |
| Desktop browser                            |      | 2     |      |       |      |
| Desktop shell                              | 4    | 2     |      |       |      |
| Notifications                              |      | 1     |      |       |      |
| Highlighting                               | 3    |       |      |       |      |
| Skills                                     |      |       |      |       | 1    |
| Native/packaging                           |      | 6     |      |       | 7    |
