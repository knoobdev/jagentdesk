# Agent Forum / Team Mode

Agents collaborate like a human team on a coding request: open a discussion topic,
propose approaches, create tasks, break into subtasks, assign to each other,
estimate, move task status, and execute — visible in a dedicated forum + task-board
screen. Opt-in per chat ("Team mode"). Real work runs on the existing
Supervisor/Lead/Peer orchestration runtime; the forum is a persisted UI + task/topic
layer over it.

## Decisions (locked with user)

- **Engine:** reuse existing `OrchestrationRuntime` (supervisor/lead/peer) +
  `create_agent`/`send_agent_prompt`/`orchestration.*` tools + `autorun` drive loop.
  Do NOT build a new agent coordinator.
- **Scope:** aim end-to-end (prompt → discuss → tasks → assign → estimate → status →
  execute), built in verifiable stages.
- **Trigger:** opt-in only — a "Team mode" toggle in the chat composer (like the
  autorun ∞ toggle), keyed by agentId. Cost-sensitive: no auto-spawn on every prompt.
- **UI:** combined — topic list → topic detail with a discussion thread + a kanban
  task board (columns by status). Visual style borrowed from clawskills.sh (clean
  list cards, status/stat chips, tab filters).

## Reference findings

- **open-code-review** (Go review pipeline): not a forum, but donates the rigorous
  **work-item state machine** (`internal/session/manifest.go`): content-independent
  IDs, seal/freeze boundaries, idempotent-but-conflict-detecting transitions, failure
  taxonomy, **derived terminal state**; plus fan-out→dedup→summary and an explicit
  `task_done` completion contract.
- **JAgentDesk existing primitives to reuse:**
  - `packages/server/src/server/orchestration/runtime.ts` — roles, createPeer,
    recordHandback, resolveDissent, `sendPromptToAgent`; state in
    `~/.jagentdesk/orchestration/runtime.json`.
  - `packages/protocol/src/orchestration.ts` — `OrchestrationTaskBriefSchema`,
    task status enum, config RPCs.
  - MCP tools in `packages/server/src/server/agent/tools/jagentdesk-tools.ts`:
    `registerOrchestrationTools`, `create_agent`, `send_agent_prompt`, `list_agents`.
  - `packages/server/src/server/autorun/service.ts` `drive()` loop + `doneItems` +
    caps — the "keep working autonomously" engine.
  - Feature templates: `schedule/` (list/board CRUD with status), `session-share/`
    (daemon service + live stream + in-shell screen).

## Data model (new `packages/protocol/src/agent-forum/types.ts`)

- `ForumTopic`: `{ id, projectKey, serverId?, title, originPrompt, status, createdAt,
updatedAt, leadAgentId?, orchestrationRunId?, participants: ForumParticipant[],
messages: ForumMessage[], tasks: ForumTask[] }`.
  - `status: "planning" | "in_progress" | "review" | "done" | "archived"` (derived
    from tasks where possible, per OCR).
- `ForumParticipant`: `{ agentId, label, role: "supervisor"|"lead"|"peer"|"user" }`.
- `ForumMessage`: `{ id, authorAgentId | "user" | "system", authorLabel, role, kind:
"message"|"proposal"|"decision"|"handback"|"status", text, createdAt, taskRefs? }`.
- `ForumTask`: `{ id, title, description, status:
"backlog"|"todo"|"in_progress"|"review"|"blocked"|"done", assigneeAgentId?,
estimate? (e.g. "S/M/L" or points), parentTaskId?, createdBy, createdAt, updatedAt,
history: ForumTaskEvent[] }`. Subtasks = tasks with `parentTaskId`.
- `ForumSummary` (list view, omits messages/tasks arrays) for the topic list.
- Transition discipline: idempotent re-apply; conflicting transition → error; topic
  terminal state computed from task counts.

## Persistence

`~/.jagentdesk/forums/{projectKey}/{topicId}.json` — one file per topic, atomic
writes + serialized mutation queue (ScheduleStore pattern). Project key via
`packages/server/src/server/project-key.ts`.

## Daemon service (`packages/server/src/server/agent-forum/`)

- `store.ts` — JSON-per-topic CRUD (`list/get/upsert/remove`, serialized writes).
- `service.ts` — `AgentForumService`: create topic, append message, task CRUD +
  status transitions (idempotent/conflict-checked), derive topic status; `onUpdate?`
  → `emitExternalSessionMessage({type:"forum.stream", payload:{topic}})`.
- **Orchestration bridge:** creating a topic bootstraps a lead (via orchestration
  runtime) and delivers the origin prompt as the brief; orchestration events
  (peer created, handback, dissent) mirror into forum messages/tasks. The forum tools
  the agents call write directly into the service.

## Agent tools (new, in `jagentdesk-tools.ts`, registered alongside orchestration)

`forum.start_topic` (seed a topic from the current agent's task), `forum.post_message`,
`forum.create_task`, `forum.create_subtask`, `forum.assign_task`, `forum.claim_task`,
`forum.estimate_task`, `forum.set_task_status`. These make agents act like a team;
actual sub-agents + work reuse `create_peer`/`send_agent_prompt`.

## RPCs (protocol + client)

`forum.list`, `forum.get`, `forum.create` (chat trigger or UI), `forum.archive`/`stop`,
and the `forum.stream` push. Register in `messages.ts` unions; add client methods +
`subscribeForumStream` in `packages/client/src/daemon-client.ts`.

## Chat trigger ("Team mode")

- Composer toggle keyed by agentId (mirror autorun's `AutonomousControl`). Persisted
  per-agent. When ON, the user's next coding prompt seeds a forum topic: the daemon
  creates the topic + bootstraps an orchestration lead + delivers the prompt as the
  brief; the lead then discusses/plans/creates tasks/spawns peers via the forum +
  orchestration tools.

## UI (`packages/app/src/screens/agent-forum-screen.tsx` + `agent-forum/` helpers)

- Sidebar entry "Team" (lucide `Users` / `MessagesSquare`), route `/agent-forum`.
- Topic list (aggregated across hosts) with status chips + a stats strip.
- Topic detail: discussion thread (role-colored agent messages) + kanban task board
  (columns: Backlog/Todo/In progress/Review/Done) with assignee + estimate + subtasks.
- Live via `subscribeForumStream`.

## Build stages (each verified: lint + tsgo + e2e)

1. Protocol types + schemas + unions + client RPCs + `forum.stream`.
2. Daemon `store.ts` + `service.ts` + bootstrap wiring + session dispatch.
3. Forum MCP tools for agents + orchestration bridge.
4. Chat trigger (Team mode toggle) + start-topic flow.
5. App screen (topic list + detail: thread + kanban) + sidebar + route + chrome
   allowlist (per session-share/shared-sessions steps).
6. Autonomous drive loop (reuse autorun caps) + consolidation.
7. Tests (daemon e2e + browser e2e) + verify; then release.

## Cost control

Opt-in only; reuse autorun caps (max turns / cost / wall-clock); the forum driver
respects `agentManager.hasInFlightRun` so it never fights the human.
