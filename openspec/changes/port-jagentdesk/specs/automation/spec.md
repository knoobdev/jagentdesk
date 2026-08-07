## ADDED Requirements

### Requirement: Schedules run prompts on cron cadence
The daemon MUST evaluate schedules on a 1,000 ms tick, require a non-empty prompt, support cron cadence and a target of either an existing agent or a new agent workspace, and persist run status, next run, and completion limits (`scratchpad/reference/packages/server/src/server/schedule/service.ts:28,48-60,63-113,136-160,233-257`).

#### Scenario: Empty schedule prompt is rejected
- **GIVEN** a schedule creation request contains only whitespace as its prompt
- **WHEN** the daemon normalizes the request
- **THEN** it rejects the request with `Schedule prompt is required` (`scratchpad/reference/packages/server/src/server/schedule/service.ts:55-60`)

#### Scenario: Schedule reaches its run limit
- **GIVEN** `maxRuns` is configured and completed runs are equal to or greater than that limit
- **WHEN** the scheduler evaluates the record
- **THEN** it marks the schedule `completed` and clears `nextRunAt` (`scratchpad/reference/packages/server/src/server/schedule/service.ts:136-160`)

### Requirement: Schedule lifecycle is controllable
The daemon MUST support pause, resume, update, delete, and one-shot execution for a schedule; a one-shot run MUST not change the recurring cadence (`scratchpad/reference/packages/server/src/server/schedule/service.ts:385-422,525-604`; `scratchpad/reference/packages/cli/src/commands/schedule/index.ts:42-100`).

#### Scenario: Paused schedule does not remain active
- **GIVEN** an active schedule is paused
- **WHEN** the pause operation completes
- **THEN** the persisted status is `paused` and `pausedAt` is a UTC timestamp; after resume, status is active and `pausedAt` is null (`scratchpad/reference/packages/server/src/server/schedule/service.ts:385-422`)

#### Scenario: User triggers one run
- **GIVEN** a valid schedule ID
- **WHEN** the user invokes `schedule run-once <id>`
- **THEN** the CLI dispatches the one-shot operation without deleting or rewriting the schedule cadence (`scratchpad/reference/packages/cli/src/commands/schedule/index.ts:68-77`)

### Requirement: Heartbeats target the current agent
The CLI MUST expose heartbeat create, update, and delete operations, require a five-field cron cadence, and bind the heartbeat to the current agent rather than creating a new agent (`scratchpad/reference/packages/cli/src/commands/heartbeat/index.ts:63-92,104-124,156-179`).

#### Scenario: Heartbeat creation requires cron
- **GIVEN** `--cron` is absent or empty
- **WHEN** the user invokes heartbeat creation
- **THEN** the CLI rejects the command with `--cron is required` (`scratchpad/reference/packages/cli/src/commands/heartbeat/index.ts:63-76`)

### Requirement: Loops run bounded worker-verifier iterations
The daemon MUST reject a loop without either a verifier prompt or at least one verification command, execute worker iterations with optional verifier agents, and enforce positive `maxIterations` and `maxTimeMs` limits when configured (`scratchpad/reference/packages/server/src/server/loop-service.ts:411-463,590-620`).

#### Scenario: Loop has no verification gate
- **GIVEN** `verifyPrompt` is absent and `verifyChecks` is empty
- **WHEN** the daemon creates the loop
- **THEN** it rejects the request with `Loop requires --verify or at least one --verify-check` (`scratchpad/reference/packages/server/src/server/loop-service.ts:417-426`)

#### Scenario: Loop hits a bound
- **GIVEN** the next iteration would exceed `maxIterations`, or the deadline exceeds `maxTimeMs`
- **WHEN** the loop executor checks its bound
- **THEN** it finishes the loop as failed and records the applicable limit (`scratchpad/reference/packages/server/src/server/loop-service.ts:590-610`)

### Requirement: Chat rooms coordinate agents and humans
The daemon MUST support persistent chat-room create/list/inspect/delete, non-empty messages with authors, replies, mentions, bounded reads, and wait-for-message requests (`scratchpad/reference/packages/server/src/server/chat/chat-service.ts:111-121,129-181,184-231,233-240`; `scratchpad/reference/packages/server/src/server/session/chat/chat-schedule-loop-session.ts:80-115,159-203,209-240`).

#### Scenario: Mention fan-out is dispatched after posting
- **GIVEN** a valid chat post contains one or more agent mentions
- **WHEN** the daemon persists the message
- **THEN** it emits the post response and asynchronously invokes mention fan-out for the mentioned agent IDs (`scratchpad/reference/packages/server/src/server/session/chat/chat-schedule-loop-session.ts:159-203`)

