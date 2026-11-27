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

Event automations run a prompt in the Home Chat when a GitHub, GitLab or Telegram event of the bot
happens (`event-automations.ts`). The bot creates them only with its `bot_event_automation_save`
tool; they list in `bots.automations.list` with `event` set. They live in the bots state table,
not on `Bot.schedules`, because round-1 apps parse every schedule with a required `cron`. An event
runs every matching automation whoever caused it (Who can ask gates only asking the bot), once
per automation and event key, and nothing while the bot is paused. Slack and Jira events do not
reach them yet.

A bot without a GitHub webhook still polls with the installed `gh` every five minutes, after
`gh auth status` succeeds. Set `githubLogin` when it differs from the slug. Open PRs with review
requests and open issues labelled `bot:<slug>` wake the bot once per URL/update time. A bot with a
webhook target hears GitHub through the webhook only (ADR-0061 §2).

Jira uses existing daemon connections, never a separate credential store.

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

### GitHub, GitLab and Telegram

Each connector of a bot has its own hookId on the relay route `/hooks/<kind>/<serverId>/<hookId>`, the same
path as Slack (spec 37.9). `hooks/connector.ts` owns what they share with Slack: verify before the `200`,
a 24 h receipt per source event id written before the `200`, and a reply outbox retried every 30 s. The
Worker forwards only the kind's headers; the daemon reads only those, never the rest of the frame.

- GitHub and GitLab hooks are created with the owner's `gh` / `glab`. Secrets go on stdin (`--input -`),
  never in argv, where `ps` would show them. Each repo, org, project or group has its own secret, so
  Rotate on one row does not break the others; verification tries every secret of the bot.
- Mentions are a line starting with `/<folder>`, not `@`, so GitHub never notifies a real user of that
  name. Only Who can ask gets a turn; every verified event still goes to `hooks.events` for automations.
- Replies post as the owner. A comment the daemon posted comes back as a webhook event: it is matched by
  id (and by body hash while the API call is in flight) and dropped, or the bot would answer itself.
- GitHub never retries a `503`. On relay reconnect the daemon lists each hook's deliveries of the last
  72 h and asks GitHub to resend those that failed with 5xx, 429 or a timeout. GitLab has no such API.
- GitLab sends the secret token in clear in a header through Cloudflare; Telegram sends its secret token
  the same way (accepted risk, `08.1.1` A10–A11). Pipeline events count once per pipeline and final
  status, whatever GitLab resends.
- Telegram: `message_thread_id` is part of the thread key only when `is_topic_message` is true; replies
  in ordinary groups carry one too.

The RPCs and the client contract are in `bots.github.*`, `bots.gitlab.*` and `bots.telegram.*` of
`packages/protocol/src/bots/rpc-schemas.ts`, gated on `features.botsHooks`. The local acceptance test
`packages/server/src/server/bots/hooks.local.e2e.test.ts` runs against `wrangler dev --local --port 8972`
with local GitHub, GitLab and Telegram simulators; never run it against the real services.

## Sharing

A bot is shared as a link to an encrypted bundle on the owner's relay Worker (spec 37.13,
ADR-0061 §5). The daemon builds the bundle, seals it with AES-256-GCM under a per-bot key and
uploads only ciphertext to R2. The key lives in the bots secret store and in the link's `#k=`
fragment; HTTP clients never send fragments, so the Worker and Cloudflare never see it. Treat a
link as the bot's contents: anyone holding it can make a copy, and Stop sharing only blocks new
downloads.

- The bundle never carries connectors, tokens, allow-lists, `MEMORY.md`, its history or the
  journal; a skill keeps only its documents and its SKILL.md is rebuilt from `name` and
  `description`. A secret flag from the safety check blocks publishing.
- Publishing needs the relay control socket (`share_create`); with Relay off the dialog says so.
  The 21st live link of one daemon is refused by the Worker, so stop one first.
- A link from another Worker downloads over https only; plain http is accepted only from this
  daemon's own relay origin, which is what local `wrangler dev` tests use.
- Update link re-seals to the same shareId. A review opened before an update fails Create with
  `bot_share_updated`; review it again. Copies keep the link without the key in state and the key
  in the secret store, so View original can read the link's current version.
- Slack, the hook connectors and sharing share the one relay control socket
  (`relay-control-mux.ts`) and one `FileSecretStore`: two stores on the same file drop each
  other's writes.

The RPCs are `bots.share.status`, `prepare`, `view`, `publish`, `stop`, `open`, `original` and
`create` (each `.request` / `.response`), all `daemon.manage`, gated on `features.botsSharing`.
Errors come back as `bot_share_*` codes that the app maps to copy.

## Port sources

Orca `dfdb4fda` (MIT, Copyright (c) 2026 Lovecast Inc.); each ported file names its Orca source in
its header. The MIT text ships in the root `THIRD_PARTY_NOTICES` (vendor `orca`), which the
desktop build copies into its resources and `packages/app/src/legal/third-party-notices.ts`
carries into the app bundles. The mascots in `packages/app/assets/bot-mascots/` are byte-for-byte
copies; `packages/app/src/bots/mascot-assets.ts` requires them. The connectors
port `src/shared/automation-event-triggers.ts:17-41` (GitHub kinds), `src/shared/quoted-text-fence.ts`
and `src/main/bots/bot-owner-writes.ts:22-63` ("asked by"). Sharing
ports `src/main/bots/sharing/*` (bundle, archive, content, sources, recipient, reviews, PNG strip),
`src/shared/bots/bot-package.ts:58-184`, `bot-text-scan.ts` and
`src/renderer/src/components/bots/sharing/*`, with Orca Cloud replaced by the relay Worker.
