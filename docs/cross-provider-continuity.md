# Cross-provider continuity

An agent keeps its id, timeline and workspace when it moves to another provider: by hand from the composer's model menu, by failover when a provider reports a usage limit, or when it starts a child on another provider. The source of truth is spec 40 and ADR-0057 in the spec repo. Code: `packages/server/src/server/agent/session-ledger/` (ledger, handoffs) and `packages/server/src/server/agent/failover/` (failure classification, failover, child providers).

## Session ledger

The ledger lives next to the agent record as `<agentId>.ledger.json`. `AgentStorage` skips that suffix when it scans records and deletes the file with the record.

Only what the agent writes with `update_session_ledger` (decisions, open items, next step) is stored, each anchored to the timeline seq it was written at. Goals (user messages verbatim), files, commands, errors and turn answers are read off the timeline whenever a ledger or handoff is built, so they cannot drift from it. Edited files are diffed against the git `HEAD` the ledger saw at the agent's first turn; `git: null` in the file means the cwd is not a git checkout.

No model is ever called to summarize. The instruction to use the tool is appended to the daemon system prompt only for agents that get JAgentDesk tools.

## Switching provider

`AgentManager.switchAgentProvider` records the outgoing provider's native session in the record's `providerSessions` with the timeline seq it last saw. Switching back resumes that session and stages only the delta after that seq; a provider that never ran the agent gets a new session and the full handoff (ledger plus the last three turns), cut to 60 % of the model's context window from the provider snapshot (128 k when the catalog has no size). Cuts go: old command output, old turn answers, large diffs; goals and the next step are never cut.

The staged text is stored in the ledger as `pendingHandoff`, so it survives a restart, and `startPendingForegroundTurn` prepends it to the next turn whatever path sent the prompt. It is cleared only after the provider accepted the turn.

## Failover

`classifyTurnFailure` reads the provider's error text; no provider tags usage limits today. Add a provider's wording to `USAGE_LIMIT_PATTERNS` with a test case. Auth patterns win over usage patterns because a 401 body can mention rate limits.

Failover runs after the failed turn settles, switches with reason `failover`, and resends the failed turn through `sendPromptToAgent`, so the message appears again in the timeline. A second limit on that resend does not fail over again; the agent gets the usage-limit row instead, whose "Continue with …" calls `agent.failover.continue`.

Testing: no real provider can be made to hit its limit on demand. The `mock` dev provider fails a turn whose prompt contains `emit synthetic usage limit failure` or `emit synthetic network failure`; see `daemon-e2e/cross-provider-failover.real.e2e.test.ts`.

## Child agents on other providers

`create_agent` from an agent always accepts the caller's own provider. With `agents.crossProviderChildren` on, it also accepts entries of `allowed` (an entry with `model: null` allows any model of that provider). With it off, another provider is accepted only when the user's latest message to the parent names it. A child on another provider starts with the parent's goals and files instead of its transcript.
