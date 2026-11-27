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

A worker's worktree lists under the chat that started it in the Bots section, never in Projects;
a project whose only workspaces belong to bots is left out of Projects too. The daemon builds the
bot's chat tree from live agents and stored agent records
([daemon-runtime.ts](../packages/server/src/server/bots/daemon-runtime.ts) `agents`): agents load
on demand after a restart and idle runtimes are closed, so a tree of live agents alone loses its
Home Chat and workers, and their worktrees fall back into Projects. In the worker's workspace the
Workspace agents roster lists that chat as the Supervisor; phones open it from the header's
Workspace agents button.

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

The first-run screen reads Home Chat history with `botFirstScreenState` (`bots/rules`), as Orca
does: it leads from the kickoff until the bot speaks or the owner writes. A kickoff turn that ends
without words, or that the host cannot start, gets an `assistant` row with `source: "error"`; the
screen shows it with Try again (`bots.kickoff.retry`, gated on `features.botsKickoff`). The drain
never resends a failed kickoff on its own. `firstRun` is a different thing: it lasts until the
owner's first turn ends, because the first-run rules steer that turn too, so never use it alone to
decide whether to show the screen. In the agent timeline the kickoff is a notice row, not a user
bubble.

## Automations

A bot's automation is a core schedule with `bot: { botId, runsIn, chatId? }`
([schedule service](../packages/server/src/server/schedule/service.ts), ADR-0060). There is no
second scheduler: the schedule service owns cadence, next run and run history, and hands each due
bot schedule to the bots service's launcher, which runs it the way a bot runs: a Home Chat note
(running, done, failed), the prompt in the Home Chat (`runsIn: "home"`), one of the bot's side
chats (`"chat"`, the Home Chat when that chat is gone) or a new "Automation run" conversation in
its home (`"new"`, in the bot's permission mode, its cards going to the owner). A reply ending in
the quiet marker posts nothing.

- Created and changed only in the bot's chat: `bot_automation_*`, or the core schedule tools,
  which a bot's own chat may use for its own schedules only. `schedule/update` refuses a bot
  schedule, and the Schedules screen offers "Edit in {{bot}}'s chat" instead of the form. Pause,
  resume, Run now and Delete work from both places.
- A paused bot's due slot is not claimed; resuming runs it once. The Schedules row shows
  "Bot paused" meanwhile.
- `target` is a new-agent target for the bot's provider in its home, so apps that don't read
  `bot` still list it. It follows provider and model changes.
- Round-1 bots kept `Bot.schedules` on the record. On start each one becomes a core schedule with
  the same id, cron, prompt, on/off and next run; the record is cleared only after all of them
  are in, and an id already present is kept, so a rerun makes no duplicates. `Bot.schedules` is
  `[]` from then on.
- Deleting a bot deletes its schedules. Templates and shared bots create theirs off.

## Triggers

Look around slots and wait deadlines use persisted occurrence keys. Paused bots queue chat but run
no turns or background work.
A daemon restart wakes a bot only when it cut the bot's turn: one `[restart]` turn per cut
message, in Orca's words, shown in the app as a notice row. Open items, waits and workers need no
turn and stay as stored (ADR-0060 §6 allows no other model calls).
Look around catches up a slot the host slept through on the same day only, never one from before
it was turned on, and never before the bot's first conversation. Tidy memory runs in the 3–8 AM
window after a night with chat.

Event automations run a prompt in the Home Chat when a GitHub, GitLab or Telegram event of the bot
happens (`event-automations.ts`), through the same Home Chat launch as a scheduled run. The bot
creates them only with its `bot_event_automation_save` tool; they list in `bots.automations.list`
with `event` set. They live in the bots state table, not in core schedules, because a schedule
needs a cadence and older apps parse every schedule's. An event
runs every matching automation whoever caused it (Who can ask gates only asking the bot), once
per automation and event key, and nothing while the bot is paused. Slack and Jira events do not
reach them yet.

GitHub reaches a bot only through its webhook (spec 37.10); the round-1 five-minute `gh` poll is
gone (spec 37.2.6, ADR-0061 §2). The only `gh` call left is the first-run screen's open-PR count.

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
- Telegram linking: the code arrives as `<code>` or as `/start <code>` from the `t.me/<bot>?start=<code>`
  button. Until someone is linked, every refusal carries the "tap Link my Telegram account" hint, at most
  once a minute per sender, because the sender is most likely the owner who never sent the code. After
  that it is one refusal a day. The status's `linked` (who sent the current code) lives in daemon memory
  and the daemon pushes `bots.changed` on link, so the open dialog turns into "Linked" without polling.

The RPCs and the client contract are in `bots.github.*`, `bots.gitlab.*` and `bots.telegram.*` of
`packages/protocol/src/bots/rpc-schemas.ts`, gated on `features.botsHooks`. The local acceptance test
`packages/server/src/server/bots/hooks.local.e2e.test.ts` runs against `wrangler dev --local --port 8972`
with local GitHub, GitLab and Telegram simulators; never run it against the real services. Run it with
`JAGENTDESK_TAILSCALE_ENABLED=0`, or the daemon fails to start without the embedded Tailscale bridge.

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
