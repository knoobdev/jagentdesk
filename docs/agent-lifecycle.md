# Agent lifecycle

How an agent is created, runs, becomes a subagent, gets archived, and disappears from the UI. The model spans the daemon (lifecycle, archive) and the client (tabs, the subagents track).

## States

```
initializing → idle → running → idle (or error → closed)
                 ↑        │
                 └────────┘  (agent completes a turn, awaits next prompt)
```

Each live agent in `AgentManager` carries a `lastStatus` of `initializing`, `idle`, `running`, or `error`. `closed` is the persisted, resumable state for an agent record that has no live provider runtime. State transitions persist to disk and stream to subscribed clients via WebSocket.

## Restart recovery

Recovery is opt-in: Settings → host → Agents → **Resume agents after restart**
(`agents.resumeOnStartup`). After restart it sends `agents.resumePrompt` (default
`Resume working.`) only to agents interrupted during a running turn. Idle agents stay dormant. Archived, internal, daemon-owned and archived-workspace agents
are excluded. A slow or unavailable provider holds back only its own agent.

Recovery is best-effort: a crash between clearing intent and dispatch can lose continuation.
Durable local finish subscriptions are reconciled after startup continuation admission. A child's
completion queues a notification that starts a parent turn automatically, including after restart.

## Runtime residency

An unarchived agent may be `closed` without being deleted or archived. Closing releases its provider
processes and subscriptions while retaining its JAgentDesk identity, persistence handle, timeline,
workspace, labels, title, usage, attention, timestamps, and parent relationship. Opening or prompting
the agent runs through `ensureAgentLoaded()`, which resumes the durable provider session under the
same JAgentDesk agent ID. Provider history is not appended again when the canonical timeline is already
primed.

Idle runtimes are released after one hour while their saved conversations remain resumable.
Reopening a runtime starts a fresh idle window without changing sidebar activity timestamps.
Tracked background work, outstanding local finish subscriptions, queued messages, and provider
safety vetoes keep runtimes resident. Claude session crons and `/loop` wakeups are process-local
work and prevent release. Hosts can disable cleanup live with Settings → host → Agents → **Release idle agents**
(`agents.idleRuntimeCleanup`). The timer lives in
`packages/server/src/server/agent/idle-runtime-cleanup/`.

### Cancellation

Cancellation changes lifecycle state only after the provider acknowledges the interrupt or emits a terminal turn event. If the interrupt is rejected or times out, the agent remains `running` with its active foreground turn intact. Follow-up actions such as replacement, reload, rewind, and Stop must report that failure instead of accepting work they cannot perform. Synthesizing a local cancellation without provider acknowledgment creates a split-brain session: JAgentDesk accepts a new prompt while the provider still owns the previous foreground turn.

## Relationships

Agents can launch other agents via the agent-scoped `create_agent` MCP tool. Agent-scoped creation is always asynchronous and always stamps `jagentdesk.parent-agent-id`, pointing back at the caller. Omit `workspaceId` to use the caller's workspace, or pass an existing workspace ID returned by `create_workspace`. Placement never changes parentage.

- **Subagents** — exist as part of the creating agent's work, appear in that agent's subagent track, and are archived with it.
- **Detached agents** — stand on their own after an explicit detach transition, do not appear in the former parent's subagent track, and are not archived with it.

Runtime ownership is resolved from explicit workspace ID and caller context, never from `cwd`. Workspace creation is a separate operation with `local | worktree` isolation; agent creation only selects an existing workspace.

Users can also detach an existing subagent from the subagents track. Detach is deliberately a manual lifecycle gesture, not an agent-facing MCP tool. It removes the `jagentdesk.parent-agent-id` label only: it does not stop, archive, move, or restart the agent. The agent keeps its current `cwd` and `workspaceId`, leaves the former parent's track, and behaves like a root agent for tab close, workspace activity, and future parent archive.

`notifyOnFinish` defaults to `true` for agent-scoped creation and background prompt follow-ups because most delegated work needs to report back to the creating agent. Set it to `false` only for truly fire-and-forget agents or prompts.

## Agent messages

Agent sends default to `queue`. The recipient finishes its running turn, including compaction,
then collects messages for two quiet seconds, capped at ten seconds from the first arrival.
Finish notifications and change-request updates always queue. Bots and ORC use the same queue.

Explicit `steer` joins the running turn; providers that cannot steer interrupt instead.
`interrupt` replaces the turn. Both carry earlier queued messages in admission order. A user
prompt carries the same queue and defaults to interrupt. Stop retains the queue for the next
prompt when it stops a running or starting turn; stopping an idle recipient holds nothing.

Receipts report the applied behavior and guidance. A provider must acknowledge admission before
messages leave the queue. An unread steer and its carried messages can be lost when its turn is
stopped or interrupted. Follow up with a short steer or interrupt to expedite a queued message;
do not resend its body.

## Background visibility

An agent is effectively background when it or its workspace is background:
`agent.background || workspace.background`. Background controls discovery only. Provider history,
plugin hooks, parentage, finish notifications, archive and restart recovery behave as for any other
agent. Both flags are fixed at creation.

- **Agent.** `create_agent_request.background` marks helpers the user does not watch, such as a
  plugin's classifier or a loop worker. A background agent never raises attention, adds nothing to
  its workspace's status bucket, and stays out of tabs, the parent's subagents track and agent
  lists. A tab opened by ID still works.
- **Workspace.** `background` on workspace creation hides the workspace from the sidebar unless
  **Show background** is on in the sidebar display preferences.
- **Inheritance.** When `background` is omitted, an agent created by a caller agent takes the
  caller's own `background`, and a new workspace takes the caller's effective background
  (`packages/server/src/server/agent/create-agent/intent.ts`). An explicit value always wins.

`AgentDirectory` (`packages/server/src/server/agent/directory.ts`) owns list visibility. Default
workspace and agent lists exclude background entries; `includeBackground` includes them. Exact-ID
operations bypass the filter. The app replicates inclusively and filters per surface. Clients gate
background workspaces on `features.backgroundWorkspaces` and agent-level background on
`features.backgroundAgents`. Clients without the `background_agents` hello capability get
workspace-only visibility, because older apps auto-open a tab for every root agent.

### Private daemon helpers

Internal agents (`internal: true`), such as the git metadata generator for branch names and commit
messages, are daemon-owned helpers. They are never public: they are excluded from discovery, global
subscriptions, restart recovery, host data export, chat mentions and plugin archive hooks, and they
never raise attention. This lifecycle is separate from background visibility and is not a public
creation option.

## Background work

Background work is provider work that runs outside the foreground turn: background shells and
monitors reported by Claude, Codex, OpenCode, Pi and ACP providers, plus daemon-owned heartbeats and
change-request watches. Each item has a kind, description, start time, and a stop handle when it can
be stopped. Clients list and stop it with `agent.background_work.list.request` and
`agent.background_work.stop.request`, and receive `agent.background_work.update` pushes; the agent
pane shows it per agent (`packages/app/src/background-work/`). Tracked background work keeps the
runtime resident (see [Runtime residency](#runtime-residency)).

## Archive

Archive is a **soft delete**: the agent record stays on disk with `archivedAt` set, the runtime is closed, and the agent disappears from active lists. Archive is **global** — it lives on the server and propagates to every connected client.

Archive sets `archivedAt`, invokes the provider's native archive hook, and cascades to managed
children.

`create_agent_request` can opt an agent into `autoArchive`. In that mode the daemon archives the agent after the first terminal turn event (`turn_completed`, `turn_failed`, or `turn_canceled`). When the agent owns an isolated workspace, auto-archive archives that workspace too; the managed worktree is removed when its final workspace reference is gone.

Archiving runs through `AgentManager.archiveAgent` (`packages/server/src/server/agent/agent-manager.ts`):

1. Snapshot the current session into the registry
2. Set `archivedAt` and normalize `lastStatus` away from `running`/`initializing`
3. Notify subscribers
4. Close the runtime (kills the process if still running)
5. **Cascade-archive children** — any agent whose `jagentdesk.parent-agent-id` label matches the archived agent gets archived too, recursively

Cascade keeps subagents from outliving their parent.

Workspace archive is a separate lifecycle. Archiving or removing a worktree can close a surviving
agent record without setting the agent's `archivedAt`, while its `workspaceId` still points at the
archived workspace. History navigation must not infer workspace lifecycle from `agent.archivedAt`
or mutate either lifecycle. The workspace route asks the daemon for authoritative recovery state;
only the route's explicit Unarchive or Restore action changes the archived workspace.

Workspace **Unarchive**, **Restore**, Undo, and reopening the directory recover the agents closed by
that workspace archive, including after a daemon restart. Agents archived individually beforehand
stay archived. A failed worktree recreation or workspace record write leaves agents archived for retry.
Each recovered agent runs the provider's native unarchive hook before interactive resume and history
hydration. History navigation alone preserves both archive states.

The archive toast offers Undo for eight seconds, with Cmd/Ctrl+Z outside text fields and terminals.
The archive shortcut itself never fires from a text field or terminal: Cmd/Ctrl+Shift+Backspace
is also a text-editing chord. Bindings marked `destructive` in
`packages/app/src/keyboard/keyboard-shortcuts.ts` keep that guard when the user rebinds them.
The daemon serializes archive and undo per workspace across connections. Tabs and layout survive
until the undo window closes; a canceled archive keeps them.

Provider session connection owns every process it spawns until the session is registered with
`AgentManager`. If initialization, persisted-session resume, or initial history hydration fails,
`connect()` must dispose that process before rethrowing; the manager cannot clean up a session it never
received.

## Tabs vs archive

These are two distinct concepts that used to be conflated:

| Concept                    | Scope      | Triggers                   |
| -------------------------- | ---------- | -------------------------- |
| **Tab** (workspace layout) | Per-client | User opens/closes a view   |
| **Archive** (lifecycle)    | Global     | Explicit lifecycle gesture |

Closing a tab on a **root agent** still archives — the tab is the agent's home, so closing it means "I'm done with this agent." A confirm dialog protects against archiving a running agent by accident.

Closing a tab on a **subagent** (any agent with `parentAgentId`) is **layout-only**. The agent stays unarchived and stays in its parent's track. The user can re-open the tab from the track at any time. This is implemented in `handleCloseAgentTab` (`packages/app/src/screens/workspace/workspace-screen.tsx`).

The asymmetry is intentional: a subagent's persistent relationship lives in the parent's track. Same-workspace subagents are not auto-opened as tabs; the user opens one from that track when needed. A cross-workspace subagent is also auto-opened as a tab in its own workspace so opening that workspace does not appear empty. It remains in the parent's track until it is actually detached.

## Workspace activity

Agent lifecycle status stays literal: a parent agent is `idle` when its own turn is idle, even if a child is running.

Workspace status is an aggregate activity signal computed **per `workspaceId`**. Ownership is never derived from `cwd` — many workspaces may share one directory, and same-`cwd` siblings do not clump under one status. Root agents and cross-workspace subagents contribute their normal state bucket to their own workspace. Same-workspace descendants contribute `running` to the nearest ancestor in that workspace; their non-running attention, permission, and error states stay in the parent's subagents track. This makes a cross-workspace subagent behave like a detached agent for workspace visibility and status without removing its parent relationship.

Running provider-native subagents contribute `running` to the workspace owned by their parent agent. Their completed, failed, and canceled states stay in the parent's subagents track.

## The subagents track

The collapsible track above the composer in an agent's pane (`packages/app/src/subagents/track.tsx`) combines two kinds of children:

- **JAgentDesk subagents** are full managed agents. Their membership rule (`packages/app/src/subagents/select.ts`) is:

```
parentAgentId === thisAgent.id  AND  !archivedAt
```

- **Provider subagents** are child executions owned by Claude, Codex, OpenCode, Pi, OMP, or a plugin provider. They are not inserted into `AgentManager` as managed agents. Providers emit a separate descriptor and timeline stream through `agent.provider_subagents.*`; the client keeps that state outside the normal agent store and merges only the presentation rows into the track.

Clicking either kind opens a workspace tab. A JAgentDesk subagent tab is a normal interactive agent pane. A provider subagent tab is a read-only timeline pane with no composer, archive, detach, rewind, or fork actions. Both panes use `AgentStreamView`, so message, reasoning, tool-call, and layout rendering stay identical.

Provider timelines use the same structural timeline item format but deliberately have a separate lifecycle and transport. A provider thread/session identifier is not a JAgentDesk agent identifier, and closing its tab is always layout-only.

Provider descriptors may include one compact subtitle. The provider owns its contents and formatting; clients display and truncate it without interpreting provider-specific model, thinking, or usage fields.

### Claude provider subagents: the task protocol

Claude Code announces subagent lifecycle on the SDK stream (`task_started` / `task_updated` / `task_notification` / `task_progress`), and JAgentDesk reads those announcements rather than reconstructing them from sidechain frames. The live source and the replay source (`packages/server/src/server/agent/providers/claude/subagents/`) both translate into one observation vocabulary, so a fact is derived once for both paths. Gotchas that are not obvious from the SDK types:

- **Not every announced task belongs in the subagents track.** Workflows (`local_workflow`) share the track with Task subagents. Background shells (`local_bash`) use Background work instead, and ambient housekeeping sets `skip_transcript`. All can carry a `tool_use_id`, so that field alone cannot choose the surface.
- **A task that was never declared gets no descriptor, by any route.** Filtered tasks still emit `task_notification`s carrying a `tool_use_id`, and still emit frames carrying `parent_tool_use_id`. Attributing either produces a descriptor with no identity and a defaulted `running` status — a nameless row that never finishes. Status, presentation updates, and sidechain frames all route through the declaration table.
- **Task ids are session-scoped, not turn-scoped.** Cancelling a turn must not clear the routing table: a backgrounded child settles after the interrupt and needs its descriptor to still exist. Cancellation instead terminalizes the declared children that were running in the foreground, and a later `task_notification` is free to correct that guess. Backgrounded children are identified by `task_updated.patch.is_backgrounded`.
- **Effort is only reachable through hooks.** It appears nowhere on the message stream at any depth, and the level JAgentDesk requests is not necessarily the level that runs — a model that does not support it is silently downgraded. A hook firing inside a subagent reports the active post-downgrade level next to its `agent_id`, which is the same id `task_started` calls `task_id`.
- **Backgrounded subagents emit no frames carrying `parent_tool_use_id` at all.** Everything keyed off that field sees nothing for one; they are visible only because the task protocol announces them.
- **On replay, `<session>/subagents/` holds every descendant, not only this session's children.** `agent-<id>.meta.json` carries `spawnDepth`: `1` is a direct child, `2+` was spawned by another subagent and its `toolUseId` names a Task call made inside its parent's session, which nothing in this transcript can resolve. Replaying those adds rows the live stream never showed, each with no Task card and no recoverable outcome, so they render as running forever. One recorded session showed 10 subagents live and would have replayed 22.
- **Replay `totalTokens` is a context-size reading, not cumulative spend.** Claude Code finalizes a subagent by summing the _last_ assistant message's usage block and shipping that as `usage.total_tokens`. Summing per-entry usage instead multiplies the cached prefix by the turn count and reports a number several times larger than the live path.

Archived JAgentDesk subagents disappear from the track, by design. To remove one from the track without closing its tab, use the **archive button** on the row — it opens a confirm dialog and archives the subagent on confirm. Provider-owned rows have no individual JAgentDesk lifecycle controls.

The track header's **Archive finished** action hides finished provider-owned rows in the current app session. Their native sessions and timelines are untouched, and managed JAgentDesk subagents are not archived by this bulk action. If a hidden provider child starts running again, the app brings it back to the track.

To keep the agent alive but remove it from the parent's track, use **detach**. The daemon clears the parent label, emits the normal agent update, and every client reclassifies the agent from subagent to root/sibling from that updated snapshot.

## Why this shape

The decision was to **decouple "close tab" from "archive" only for subagents**, rather than universally:

- **Closing a tab on a root agent still archives** — preserves the existing UX users are trained on
- **Closing a tab on a subagent is layout-only** — fixes the lossy "click to read, close to dismiss view, lose the row" flow
- **Archive button on track rows** — gives subagents an explicit lifecycle gesture in their home surface
- **Detach button on track rows** — lets a subagent continue independently without killing its work
- **Cascade archive on parent** — keeps subagents from leaking when the parent is archived

We considered universal decoupling (no tab close ever archives, archive is always explicit) but rejected it: it changes a behavior root-agent users rely on.

## Limitations

### Subagent accumulation under long-lived parents

A parent that spawns many subagents will see the track grow. Managed JAgentDesk subagents can be archived individually. Finished provider-owned rows can be hidden together with **Archive finished**; this is app-local presentation state and resets when the app restarts.

### Cross-client tab dismissal

Closing a subagent's tab on one client doesn't affect other clients' layouts. This is the expected behavior of decoupled tabs and is consistent with how layouts have always worked. Archive remains the global gesture for cross-client cleanup.

## Storage

```
$JAGENTDESK_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

`{cwd-with-dashes}` is derived from the agent's filesystem `cwd`. It is not the workspace id; agent storage stays cwd-keyed while workspace identity is the opaque workspace id.

Each agent is a single JSON file. Fields relevant to this doc:

| Field                                  | Type          | Meaning                                                                            |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| `id`                                   | `string`      | Stable identifier                                                                  |
| `archivedAt`                           | `string?`     | Soft-delete timestamp (ISO 8601)                                                   |
| `labels["jagentdesk.parent-agent-id"]` | `string?`     | Parent agent ID, set automatically for agent-scoped creation and removed by detach |
| `lastStatus`                           | `AgentStatus` | `initializing` / `idle` / `running` / `error` / `closed`                           |

See [`docs/data-model.md`](./data-model.md) for the full agent record.
