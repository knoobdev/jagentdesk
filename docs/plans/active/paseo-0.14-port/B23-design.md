# B23 design note: agent-to-agent messaging (implements ADR-0029)

Authority: spec repo `docs/decisions/ADR-0029-agent-message-envelope.md`. Read it first.

## Today (paths under `packages/server/src/server/`)

- All delivery goes through `sendPromptToAgent` (`agent/agent-prompt.ts`) → `startAgentRun`; steer only when
  `activeTurnBehavior === "steer"` (`agent-manager.ts` `steerOrReplaceActiveTurn`), otherwise interrupt
  (`replaceRunning: true`).
- Interrupting callers to change to steer: MCP `send_agent_prompt` (`agent/tools/jagentdesk-tools.ts`),
  CLI `agent send` (`packages/cli/src/commands/agent/send.ts`), chat mentions (`chat/chat-mentions.ts` →
  `session.ts`), forum bootstrap/wake (`agent-forum/bootstrap.ts`), ORC relay/handback/dissent/accept
  (`orchestration/runtime.ts`).
- Finish notifications: in-memory `setupFinishNotification` (`agent-prompt.ts`), armed after the first
  prompt in `create-agent/create.ts`, `requireParentOwnership: true` always.
- Hidden envelopes: `isSystemInjectedEnvelope` + the drop sites in `agent-manager.ts` (import, hydration,
  live stream).

## Must not break

1. Forum human wakes and schedules keep the legacy hidden envelope and are dispatched with
   `sendPreparedPromptToAgent` (no re-wrap) — upstream `prepareAgentMessage` would otherwise show raw
   `<jagentdesk-system>` tags.
2. ORC handback must not await delivery inside `this.mutate`; route ORC messages through the delivery
   queue so a handback and the peer's finish arrive in one prompt.
3. `background: false` and CLI wait must call `waitForDispatch` before waiting for the turn.
4. Autorun: steered messages must not break `parseTurnResult`; `drive()` must tolerate a wake turn starting
   between `hasInFlightRun` and `runAgent` (do not count it as a failure).
5. ORC `activeAgentsForWorkspace` (`orchestration/runtime.ts`) must ignore archived agents.
6. After a daemon restart, finish notifications are kept and attached to the parent's next turn; the
   parent is NOT woken (ADR-0029 decision 5).

## Port order

1. `1c6274808` as-is (`create.ts`: `requireParentOwnership: !(input.detached ?? false)`).
2. `23b05bbcc` adapted: archived agents out of `list_agents` + agent projections; also fix ORC.
3. `1ae979d3d` adapted (app): re-sync subagent parents on reconnect via `subscribeConnectionStatus`
   (`session-context.tsx`).
4. `2a890208c` adapted (app): parent pill/callout in the subagent pane.
5. `d0bc188a5` adapted: envelope v1 (no serverId), protocol `agentMessage` row + `sourceAgentId` +
   capability `agentMessageProvenance`, app row "Message from X"/"X finished", + the forum/chat fix above.
6. `c364b16d4` near as-is: hand-merge the `hasSeenTurn` part of upstream `0009a7e71`.
7. `f22775a8e` adapted: `activeTurnBehavior` input, CLI `--behavior`, steer defaults; set steer explicitly in
   ORC, forum and chat-mention paths.
8. `d0568f9f1` adapted: take `agent-messages/delivery.ts` + `envelope.ts`; 2000 ms quiet window, 10 000 ms
   max; no `MessageReceipts`, no host-operations, no serverId; capability `agentMessageBatching`.
9. `21e7ccb03` adapted local-only: `finish-subscriptions/` at `$JAGENTDESK_HOME/finish-subscriptions.json`,
   register before the first prompt, no remote observation, no auto-wake after restart.
10. `dfa997704`: deferred with epic E1 (`b12eefb28`).

## Verify

Team mode regression: lead/peer handback (one prompt, steer), forum human post (no raw tags, coders not
cancelled), autorun with incoming messages (no false no-progress stop), `notifyOnFinish` across a daemon
restart (notification arrives with the parent's next turn, parent not woken). Update string-asserting tests
in `orchestration/runtime.test.ts`, forum tests, `agent-prompt.test.ts`, `mcp-server.test.ts`.
