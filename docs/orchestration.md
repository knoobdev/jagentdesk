# Orchestration

Orchestration (ORC) is the Supervisor → Lead → Peer control plane. Desktop, mobile and every other client share it; clients never build the topology themselves. The daemon owns authority, routing, lifecycle and durable state. [Bots](bots.md) run on the same runtime. Code: `packages/protocol/src/orchestration.ts` (schemas, defaults, role instructions) and `packages/server/src/server/orchestration/` (task brief compiler, runtime).

## Flow

```text
/orc in the composer, or the workspace Orchestration panel
  → orchestration.task.prepare.request
  → Task Brief ready, or open questions shown in the same panel
  → one Supervisor for the brief's workspace
  → Supervisor calls orchestration.bootstrap_lead
  → exactly one Lead per workspace
  → Lead calls orchestration.create_peer per bounded assignment
  → Peer calls orchestration.handback
  → Lead calls orchestration.resolve_dissent when a Peer disagrees
  → Lead calls orchestration.accept_result after validation
  → handbacks and the accepted result travel back up to the parent agent
  → Supervisor reports to the human
```

The brief compiler keeps the natural-language request in `rawRequest` and splits it into objective, context, constraints, accepted decisions, requested outcome, acceptance criteria and validation plan. When the objective is missing, the brief comes back with `status: "needs_clarification"` and `openQuestions`, and the daemon creates no agent. There is no separate refine step.

A later brief in the same workspace reuses the active Lead. More than one active Lead in a workspace is a topology violation and fails.

## Configuration

Config lives in `$JAGENTDESK_HOME/config.json` under `daemon.orchestration` and is edited in Settings → host → Orchestration.

- `enabled`, `autoPrepareBrief` and `askWhenAmbiguous` switch the feature, automatic Task Briefs and clarification questions.
- `roles.supervisor`, `roles.lead` and `roles.peer` each have `profiles[]` (`provider`, `model`, `thinkingOptionId`, optional `modeId`, `enabled`) and a `defaultProfileId`. Extra roles are allowed.
- `routes` maps each semantic category (`planning`, `impl`, `impl_deep`, `search`, `research`, `audit`, `ui`) to a `primary` target and an ordered `fallbacks` list.
- `limits.maxPeersPerLead` (default 3, max 12) bounds one Lead's active Peer fan-out.

`createDefaultOrchestrationConfig()` holds the shipped profiles and routes. They are real routing policy: the daemon resolves every profile through the provider catalog before it creates an agent.

## Authority

The daemon labels real agents with workspace, brief, role and route (`jagentdesk.orchestration.*`). Runtime state is stored in `$JAGENTDESK_HOME/orchestration/runtime.json`, never in UI state.

| Role       | Tools                                                                                       | Limits                                                          |
| ---------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Supervisor | `orchestration.bootstrap_lead`                                                              | Keeps or starts the one Lead; never dispatches Peers            |
| Lead       | `orchestration.create_peer`, `orchestration.resolve_dissent`, `orchestration.accept_result` | Staffs bounded Peers and owns technical acceptance              |
| Peer       | `orchestration.handback`                                                                    | Cannot create agents, dispatch work, or accept the whole result |

Generic `create_agent` is rejected once the caller belongs to an orchestration run. Every scoped tool checks role, workspace, parent agent, brief and route first.

Dissent closes with exactly one of `RESOLVED_BY_LEAD`, `NEEDS_MORE_EVIDENCE` or `ESCALATED_TO_HUMAN`. `NEEDS_MORE_EVIDENCE` allows one verification round per Peer.

A handback requires `whatChangedOrInspected`, `evidence`, `remainingUncertainty` and `counterevidence`. A dissenting handback also uses `requestedResolution`, `currentDirection`, `claim` and `risk`.

## Wire surface

- `orchestration.config.get.request` / `.response`
- `orchestration.config.update.request` / `.response`
- `orchestration.task.prepare.request` / `.response`

Agent lifecycle uses the existing daemon WebSocket and MCP paths. Orchestration has no transport of its own and the app has no simulated sessions.
