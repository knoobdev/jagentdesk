# Bots

Bots are the built-in `bots` plugin (enabled by default). They use the daemon's existing
agent sessions, ORC, worktree provisioning and permission cards. Enable or disable them with
`plugins.builtin.set.request`; installed-plugin settings do not control them. Check
`server_info.features.bots` before opening the feature.

## Persistence and ownership

The SQLite file is `$JAGENTDESK_HOME/bots/bots.sqlite`. Bot homes are
`bots/<slug>/` with editable `SOUL.md`, `MEMORY.md`, `memory/` and `skills/`. Deleting a bot
removes its database records and room membership, cancels its workers, and retains the home
for recovery. Disabling the plugin retains all data.

A bot owns one long-lived ORC Supervisor in its home. Each code item owns one ORC Lead in a
new registered worktree of the selected repo. Peers belong to that Lead. The bot can answer
other chat while workers run. Worker ids, worktree baseline, review rounds and findings live
on the item, not in MEMORY.md. Each new turn reads changed SOUL/MEMORY content and current
open items/questions; only the first 200 MEMORY lines enter context. Receipt state advances
only after the provider accepts the turn.

The daemon freezes the full worktree diff against its dispatch commit, runs BA, Tester and
Pentester Peers, and derives verdicts with [the shared review rules](../packages/server/src/server/review/cross-review.ts).
New files must be staged so they appear in the review diff. Oversized diffs, invalid reviewer
output or a changed diff fail closed to Needs you. Blocking findings get two fix rounds;
remaining findings go to Needs you. The app uses `item.worktree` as `cwd` for the existing
checkout/file-diff RPCs. `item.diff` is the reviewed patch and `item.summary` is the worker report.
No merge or push is automatic.

## Permission boundary

Bot configuration and chat writes require `daemon.manage`; reads require `daemon.read`.
All seven bot tools use `requestHostToolPermission`. Worker/provider tools use the same
existing gate. The only setting that permits unattended operation is explicit
`bot.unattended=true`. Show this exact warning before the user enables it:

> This bot and its workers will run tools without asking.

Agents cannot change this setting through bot tools, approve their own permission cards,
or use the generic mode-changing tool. Finish/cancel active worker items before changing
provider, model, mode or unattended settings. Untrusted Jira/GitHub/room content never
changes standing authority. See [permissions](permissions.md).

## RPC contract for clients

Schemas: `@jagentdesk/protocol/bots/types` and `@jagentdesk/protocol/bots/rpc-schemas`.
Use `client.botsRequest(type, params)` and `client.onBotsPush(type, handler)`.
Every request is `{type, requestId, ...params}`. Its matching `.response` contains
`payload: {requestId, ...result}`. Errors reject with correlated `rpc_error`
(`bots_error`, `permission_denied`, or `plugin_disabled`); there are no empty-success
substitutes. Times use Unix milliseconds; cron defaults to UTC unless `timezone` is set.

| Operation (`bots.<operation>.request` / `.response`) | Request params                                                             | Result                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------- |
| `list`                                               | `{}`                                                                       | `{bots}`                                       |
| `create`                                             | `{bot: BotInput}`                                                          | `{bot}`                                        |
| `update`                                             | `{botId, patch: BotPatch}`                                                 | `{bot}`                                        |
| `delete`                                             | `{botId}`                                                                  | `{}`                                           |
| `pause`                                              | `{botId, paused}`                                                          | `{bot}`                                        |
| `chat.send`                                          | `{botId, text, messageId?}`                                                | `{message}` (queued; completion is pushed)     |
| `chat.history`                                       | `{botId, before_ms?, limit?}`                                              | `{messages}` (ascending; default 100, max 200) |
| `items.list`                                         | `{botId, includeClosed?}`                                                  | `{items}`                                      |
| `items.answer`                                       | `{botId, itemId, answers: [{questionIndex, text}]}`                        | `{item}`                                       |
| `items.cancel`                                       | `{botId, itemId, reason}`                                                  | `{item}`                                       |
| `rooms.list`                                         | `{}`                                                                       | `{rooms}`                                      |
| `rooms.save`                                         | `{room: {id?, name, memberBotIds}}`                                        | `{room}`                                       |
| `rooms.delete`                                       | `{roomId}`                                                                 | `{}`                                           |
| `rooms.send`                                         | `{roomId, text, messageId?}`                                               | `{message}`                                    |
| `schedules.list`                                     | `{botId}`                                                                  | `{schedules}`                                  |
| `schedules.save`                                     | `{botId, scheduleId?, schedule: {name, cron, timezone?, prompt, enabled}}` | `{schedule}`                                   |
| `schedules.delete`                                   | `{botId, scheduleId}`                                                      | `{}`                                           |

BotInput requires `slug`, `name`, `identity`, `provider`, `model`, `modeId`. Optional:
`thinkingOptionId`, `unattended` (false), `defaultRepo`, `lookAround` (disabled, 60 minutes),
`githubLogin`, `jiraAccounts: [{connectionId, accountId}]`. BotPatch contains optional versions
of these fields except immutable `slug`. Returned Bot also has `id`, `agentId?`, `paused`,
`schedules`, `createdAt_ms`, `updatedAt_ms`.

Questions have `text`, `options` (up to 8), optional zero-based `recommended`, and `answer?`.
An item can have at most five. Partial answers keep Needs you; the last answer wakes the bot.
A plain Needs you item without questions is informational; cancel it or respond in chat.
Items progress through `planned`, `working`, `waiting`, `needs_you`, `done`, `canceled`.
Waiting includes `{condition, until_ms}`; expiry wakes the bot to recheck the condition.

Pushes are permission-filtered:

- `bots.changed`: `payload: {botId, deleted?}`; refetch list/settings.
- `bots.item.changed`: `payload: {item}`; replace by id.
- `bots.chat.message`: `payload: {message}`; deduplicate by message id.
- `bots.room.changed`: `payload: {roomId, deleted?}`; refetch rooms.

Room messages carry `roomId` and `rootId`. `@slug` wakes a member, excluding Markdown code
and blockquotes. Each member runs at most once per root post, bounding mention loops.
Send a new post to ask a member again. No cloud connector or bot sharing is involved.

## Triggers

Cron, look-around intervals and wait deadlines use persisted occurrence keys. Paused bots
queue chat but run no turns or background triggers; resuming catches up one overdue cron
occurrence, then advances from the current time. Slow provider startup and external polling
do not block other bots' timer checks.

GitHub polling uses the installed `gh` every five minutes, after `gh auth status` succeeds.
Set `githubLogin` when it differs from the slug. Open PRs with review requests and open issues
labelled `bot:<slug>` wake the bot once per URL/update time. The bot reads the PR and posts a
comment review with file:line evidence through `gh` under its permission settings.

Jira uses existing daemon connections, never a separate credential store. `jiraAccounts`
maps each site's opaque account ref to the bot. Polling also searches `@slug` mentions and
account-id text. Events are deduplicated by connection, issue id and update time. Disabling
the Jira plugin stops Jira polling. No external connector is required.

## Port sources

Orca `dfdb4fda` (MIT, Copyright 2026 Lovecast Inc.):
`src/main/bots/bot-preamble.ts:45-88`, `bot-turn-context.ts:158-220`,
`bot-chat-session.ts:255-310`, `bot-items-schema.ts:12-150`, `bot-items-store.ts`,
`bot-item-question-notice.ts:14-35`, `bot-waits.ts:1-45`,
`bot-look-around-schedule.ts:16-49`, `bot-look-around-runner.ts:1-65`,
`bot-look-around-policy.ts:1-40`, `bot-group-mention-handoffs.ts:22-56`, and
`src/main/persistence/scheduling-automations/automation-schedule-operations.ts:1-65`.
The adaptation keeps local home/context/items/wake/mention behavior, uses JAgentDesk cron
and ORC instead of Orca orchestration, and applies JAgentDesk permission cards instead of
Orca's unattended default. The upstream license ships in `vendor/orca-bots/LICENSE`.
