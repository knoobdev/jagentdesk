# Bots

Bots are long-lived assistants built on [orchestration](orchestration.md) (ORC), laid out and run
the way Orca `dfdb4fda` runs them (ADR-0060). They are the built-in `bots` plugin (enabled by
default) and use the daemon's existing agent sessions, ORC, worktree provisioning and permission
cards. Enable or disable them per host in Settings → host → Plugins
(`plugins.builtin.set.request`). Check `server_info.features.bots` before opening the feature and
`server_info.features.botsOrca` before using the Orca-layout RPCs; a host without it is a round-1
host, so tell the user to update it.

## Persistence and ownership

The SQLite file is `$JAGENTDESK_HOME/bots/bots.sqlite` (schema v2). A bot's home is
`bots/<folder>/`: `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`) and `bot.json` are rewritten by the
daemon whenever they differ; `SOUL.md`, `MEMORY.md`, `memory/` (topics, `journal/YYYY-MM.md`,
`archive.md`) and `skills/` belong to the bot and its owner. The folder is the name's slug, then
`-2`, `-3`…; a folder a bot ever held, or one already on disk, is never handed out again, so a
deleted bot's home stays where it was. A home whose `bot.json` names another bot is refused
(`bot_folder_not_owned`).

The v1 → v2 migration runs in two places. The storage open numbers items and reserves folders;
the service's first start does what needs the provider: `unattended` becomes the provider's
bypass mode and `defaultRepo` becomes a `Fact: default repository is <path>` line in MEMORY.md.
Round-1 bots keep `reviewBeforeDone=false`.

The daemon keeps an official copy of MEMORY.md. After every Home Chat turn it compares the file
with that copy: lines the chat added become a History row; lines it removed without
`bot_memory_forget` are put back (`kept`). History rows are kept 90 days and Undo applies the
inverse change only while those lines are still as the row left them.

## Work flow

The bot does not code. For code work it starts an ORC worker in a new worktree with
`bot_worker_start`, links it to the item and ends its turn. The worker's done, ask or escalation
wakes the bot; on done it puts the result on the item and closes it. Every closed item adds one
journal line, written by the daemon. Worktree ids, review rounds and findings live on the item,
not in MEMORY.md.

Review before done is off by default. When a bot turns it on, a worker's done starts the BA,
Tester and Pentester reviews on the frozen worktree diff
([shared rules](../packages/server/src/server/review/cross-review.ts)); blocking findings get two
fix rounds, then the owner chooses "Send back to the worker" or "Mark done anyway". Any other
done fails with `review_pending`. New files must be staged so they appear in the review diff.

Look around and Tidy memory are the only model calls the daemon starts on its own, and only for
Claude and Codex bots. Each run is a visible conversation in the bot's home with a Home Chat note
(running, done, failed), a Chats row and an Automations row. Both wait until the host has been
awake 120 s; a tick gap over 30 s counts as sleep. Ten failures in a row turn either one off.

## Permission boundary

Bot configuration and chat writes require `daemon.manage`; reads require `daemon.read`.
`permissionMode` is `"same-as-chats"` (the host's default for a new agent) or a provider mode.
"Same as chats" never resolves to a bypass mode: when the provider's default skips prompts, the
daemon picks an attended mode. The round-1 `modeId` and `unattended` fields mirror the resolved
mode. Show this exact warning when the owner picks a bypass mode:

> This bot and its workers will run tools without asking.

Item, memory and automation tools are daemon bookkeeping and ask nothing. `bot_worker_start` and
`bot_handoff` ask through `requestHostToolPermission`, which a bypass mode answers itself
(ADR-0046). Agents cannot change their bot's mode, approve their own cards, or use the generic
mode-changing tool. Untrusted Slack/Jira/GitHub/room content never changes standing authority.
See [permissions](permissions.md).

Look around and Tidy memory runs get no JAgentDesk MCP tools at all. Their provider tools reach
the daemon as permission requests and are answered there, never by a card: a look may read files
and run the read-only `gh`/`git` commands in
[the allow-list](../packages/server/src/server/bots/look-around.ts); a tidy-up may do nothing.
Every refusal is logged.

## RPC contract for clients

Schemas: `@jagentdesk/protocol/bots/types` (records), `bots/views` (read models),
`bots/rpc-schemas` (requests, responses, pushes) and `bots/rules` (rules desktop and phone share:
mascots, colors, outfits, item groups, stale, snooze, the Needs you fold). Use
`client.botsRequest(type, params)` and `client.onBotsPush(type, handler)`. Errors reject with a
correlated `rpc_error` whose `code` is `bots_error` or one of the coded failures in
`BotsError` (`already_running`, `paused`, `unsupported`, `superseded`, `file_changed`,
`review_pending`, `not_found`, `item_closed`, `invalid_argument`), or `permission_denied` /
`plugin_disabled` from the session gate. Times are Unix milliseconds.

Round-1 RPC names stay. A running Home Chat note is pushed again under the same message id when
it finishes; replace messages by id. `bots.items_changed` and `bots.activity_changed` say which
read to refetch. The Home Chat agent id is absent until the first delivered message.

## Triggers

Cron automations, Look around slots and wait deadlines use persisted occurrence keys. Paused bots
queue chat but run no turns or background work; resuming catches up one overdue cron occurrence.
Look around catches up a slot the host slept through on the same day only, never one from before
it was turned on, and never before the bot's first conversation. Tidy memory runs in the 3–8 AM
window after a night with chat.

GitHub polling uses the installed `gh` every five minutes, after `gh auth status` succeeds, until
the GitHub webhook (spec 37.10) replaces it. Jira uses existing daemon connections, never a
separate credential store.

### Slack

Create one Slack app per bot from the bot's Connectors tab. Keep Relay enabled and the daemon
online for URL verification and event delivery. The manifest URL exists before you paste
credentials; connect the token and signing secret before asking Slack to verify the URL. The
allowed-user list starts empty. Link your account by sending the expiring code in a DM.

Slack credentials use the same encrypted daemon vault as Jira/SSH. Hook requests end TLS at
Cloudflare, then cross the authenticated relay control socket without Noise encryption.
Cloudflare can see Slack content while forwarding it; the Worker persists only hook ids and never
logs request bodies.

Slack receipts and outgoing replies survive daemon restarts. Thread identity follows the queued
bot message through the Home Chat turn and item creation; it must never be inferred from the most
recently received Slack event. Disconnect rotates the URL; offline unregister operations stay
pending until the relay reconnects. The Slack RPCs all require `daemon.manage`. The local
acceptance test uses an injected Slack Web API URL and a local Worker; never run it against Slack.

## Port sources

Orca `dfdb4fda` (MIT, Copyright (c) 2026 Lovecast Inc.); each ported file names its Orca source in
its header. The MIT text ships in the root `THIRD_PARTY_NOTICES` (vendor `orca`), which the
desktop build copies into its resources and `packages/app/src/legal/third-party-notices.ts`
carries into the app bundles. The mascots in `packages/app/assets/bot-mascots/` are byte-for-byte
copies; `packages/app/src/bots/mascot-assets.ts` requires them.
