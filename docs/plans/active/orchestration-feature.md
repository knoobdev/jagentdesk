# Orchestration feature implementation

## Outcome

Implement the Orchestration feature in the real JAgentDesk runtime. The feature is
daemon-backed and persisted; it is not a presentation-only settings surface.

The product contract is the local setup documentation in
`/Users/ngocchanh/Project/private/organisations/hdc/paseo-setup-docs`, especially:

- `02-topology-and-authority.md` — Human → Supervisor → Lead → bounded Peer
- `03-provider-routing.md` — semantic routes and multi-provider/model catalog
- `04-lifecycle-and-communication.md` — relay, handback and acceptance
- `05-dissent-and-heartbeats.md` — evidence-bearing dissent outcomes
- `06-mcp-and-visibility.md` and `07-codex-room.md` — role boundaries

JAgentDesk repository authority for implementation is `docs/architecture.md`,
`docs/data-model.md`, `docs/rpc-namespacing.md`, `docs/protocol-compatibility.md`,
`docs/design.md`, and `docs/testing.md`.

## Scope

- Persisted orchestration configuration with multiple provider/model profiles per
  Supervisor, Lead, and Peer role.
- Semantic routing with ordered fallbacks and provider/model/thinking guard data.
- A daemon RPC and client facade for reading/updating configuration and preparing a
  structured task brief from a human request.
- Deterministic task-brief normalization that preserves the original request and
  identifies missing material information; no extra “Refine request” action.
- JAgentDesk-style Host Settings UI for roles, profiles, and routes.
- Workspace-facing Human → Supervisor entry surface that sends the prepared brief
  into the existing agent runtime and exposes lifecycle metadata.
- Targeted protocol/server/client/app tests plus desktop browser E2E coverage.

## Non-goals for this change

- Replacing the existing provider launchers or inventing a second agent transport.
- Native Codex collaboration competing with the JAgentDesk control plane.
- Fake provider/session data or a UI-only simulation of the chain.
- Mobile/desktop-specific orchestration semantics; both clients use the same daemon
  protocol and shared app shell.

## ORC role mapping (current)

Codex GPT (Sol/Luna) is rate-limited. All Codex-GPT roles are remapped to
**Claude CLI Opus 4.8, extra-high reasoning**, run as in-process Claude review
subagents. Hard cap: **2 concurrent Claude subagents**. DeepSeek (opencode)
remains available for bounded implementation peers but is not fanned out here.

- Lead review → Claude Opus 4.8 (extra-high)
- Peer review → Claude Opus 4.8 (extra-high)
- **Coder (implements fixes / writes code) → DeepSeek** (opencode
  `api-box-ds4flash/deepseek-v4-flash[1m]`). Claude triages + verifies; Claude does
  NOT write the fix code itself. Findings flow: Claude review → Claude Lead triage →
  DeepSeek coder applies fix → Claude verify.

## Execution status

- [x] Read source-of-truth docs and map current code seams
- [x] Create checkpoint commit for the pre-change project state (`e99d120`)
- [x] Implement protocol/config/store/RPC/client vertical slice
- [x] Implement settings and workspace surfaces
- [x] Add targeted tests and desktop E2E (targeted vitest + browser/desktop E2E green,
      packaged desktop smoke green)
- [x] Run Lead review (Claude Opus 4.8, inline after review subagents hung) — feature
      sound, no blockers; findings: dissent-round counting (fixed) + fan-out message (fixed)
- [x] DeepSeek coder applied fixes + regression test; Claude verified: runtime.test.ts
      4/4, typecheck:server clean, desktop orchestration E2E 2/2 (live daemon), in-scope only
- [ ] Commit the validated feature (awaiting explicit user go-ahead — the checkpoint
      commit `e99d120` was user-driven; do not auto-commit the feature)

## Evidence required before completion

1. Protocol schemas parse the new messages and reject malformed role/route data.
2. Config round-trips through `$JAGENTDESK_HOME/config.json` without losing existing
   provider settings.
3. A real daemon/client session can read, patch, and prepare a task brief.
4. The desktop app renders the settings and workspace surfaces and the E2E test
   observes the saved configuration and prepared brief.
5. Typecheck, focused tests, format, and lint results are reported verbatim with any
   unrelated baseline failures separated from feature failures.
