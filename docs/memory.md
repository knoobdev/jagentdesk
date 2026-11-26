# Memory

The `memory` built-in (spec 41, ADR-0058) keeps notes agents and the user save, per project and
global, and puts the relevant ones in front of each message. It never calls a model: writing,
deduplicating, searching and injecting are local SQLite work.

Code: `plugins/memory/` (store, service, tools, RPC session, app screens), the port contract in
`packages/server/src/server/agent/memory-port.ts`, the wire schemas in
`packages/protocol/src/memory.ts`.

## Storage

`$JAGENTDESK_HOME/memory.sqlite` holds `memories` (one row per entry), an external-content FTS5
table kept in sync by triggers, `memory_uses` (which agent turn used which memory) and
`settings`. The path is the spec's, not the `builtin-plugins/` directory other features use.

- A project memory belongs to the project of the agent's workspace (`BuiltinDaemonDeps.projects`,
  `packages/server/src/server/plugins/builtin/project-access.ts`); an agent with no workspace
  falls back to the deepest project root holding its cwd. An agent outside every project can only
  save global memories.
- Saving text whose lowercased, whitespace-collapsed form already exists in the same scope
  updates that entry. Editing an entry into another's text merges the two.
- Text matching a credential pattern (`plugins/memory/server/secrets.ts`) is refused with code
  `secret`; nothing is redacted and stored.

## Auto-inject

`session.ts` asks the `memory` port before sending a person's message (send message and the
first prompt of `create_agent_request`); agent-to-agent messages get nothing. The block goes in as
a text attachment titled "Relevant memories", so the user's bubble shows only what they typed.
When the message leads with a command (an attached skill, a Spec mode phase, `/` or `$`), the
block goes last so the command stays first for the provider.

Selection: at most 5 memories that pass the threshold plus every pinned one (at most 10), pinned
first, within the token cap (default 1 500, four characters per token). A memory that does not fit
is skipped, never cut.

The threshold does not use FTS5's `bm25()`. FTS5 clamps the IDF of a term found in more than half
of the rows to almost zero, and a project holds a handful of memories, so its scores cannot carry a
fixed cutoff. FTS5 still finds the candidates (porter stemming, diacritics removed) and breaks ties;
the score is BM25 with `k1 = 0` and the Lucene IDF `ln(1 + (N - n + 0.5) / (n + 0.5))`. A
memory qualifies with two distinct query terms, or one path/identifier term, or every term of a
one-term message. Query terms drop English and Vietnamese stopwords; `src/app.ts` becomes the
phrase `"src app ts"` because that is how the index tokenized it. Full-text search misses
paraphrases by design (ADR-0058); agents use `search_memory` for the rest.

## Tools and timeline rows

Every new agent gets `remember`, `search_memory` and `list_memories` while the built-in is on; with
Memory switched off in Settings they answer code `disabled`. Results are JSON.

Both visible artifacts are daemon plugin timeline items, not tool-call cards: a completed turn
folds its tool calls into one summary line, and only rows a built-in appended stay outside the fold
(`isDaemonPluginRow` in `packages/app/src/agent-stream/turn-collapse/model.ts`).

- `memory`/`memory-remembered`, one per saved memory: "Remembered · …" with Undo and Edit.
- `memory`/`memory-used`, one per turn keyed by the turn id: the "Used N memories" chip. It
  freezes what was injected or found (text, scope, score, source), so it opens exactly what the
  provider saw even after an edit. A later `search_memory` in the turn re-appends the same item
  id, which updates the row in place.

Plugin item kinds must match `^[a-z][a-z0-9-]*$`.

## App surfaces

- Memory page: main sidebar after Skills (`APP_NAV_ORDER`, the Gumloop `PRIMARY_ORDER`, the
  classic skills slot), route `h/[serverId]/memory.tsx`, the same screen on phones.
- "Remember this": a message action under every user message and assistant turn; it opens the
  editor with the selected text on web, else the whole message.
- Inspector tab "Memory": the `builtin_inspector` workspace tab kind on desktop, and an extra tab
  in the compact inspector sheet. It shows the inspected agent: the focused pane's agent, else the
  first agent tab.
- Settings: a "Memory" section on host Settings → Plugins (enabled, auto-inject, token cap).

Strings live in `packages/app/src/i18n/resources/memory.ts`, English in every locale for now.

## Not done yet

Spec 41 §4 ("Previously in this project", "Continue from…") needs the session ledger (spec 40 §2).
