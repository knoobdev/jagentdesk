# Durable agent context

Agents that run for hundreds of turns get compacted, and a compacted agent forgets what was decided and which files it touched. The daemon keeps that context outside the model and puts it back into the conversation. The source of truth is spec 42 and ADR-0059 in the spec repo. Code: `packages/server/src/server/agent/durable-context/`; lessons live in the Memory built-in ([memory.md](memory.md)); the ledger it reads is the session ledger ([cross-provider-continuity.md](cross-provider-continuity.md)).

Every addition goes into the user message, never the system prompt: the system prompt has to stay byte-identical between turns or the provider's prompt cache is lost. Nothing here calls a model or starts a turn on its own.

## Compaction signals

`CompactionSignalTracker` (`compaction-signal.ts`) turns two inputs into "a compaction happened":

- A completed `compaction` timeline row from the provider. Claude (`compact_boundary`), Codex (`contextCompaction`), OpenCode (summary message) and Oh My Pi emit one; history replays are ignored.
- A drop of at least 40 % (and 2 000 tokens) in `contextWindowUsedTokens` between two usage reports, for every provider outside `EXPLICIT_COMPACTION_PROVIDERS`. A new native session id resets the baseline, so `/clear`, a rollover or a switch never reads as a compaction.

An explicit row and an inferred drop within two minutes are the same compaction. A custom API provider that runs through OpenCode gets OpenCode's explicit row; the inferred path covers providers that report usage and nothing else.

Each compaction is recorded in the agent's ledger file (`durable.compactions`) and shows a "Context compacted · Provider · before → after tokens" row. For explicit signals the row waits for the next usage report, which carries the after-size.

## What a turn carries

`DurableContext.prepareTurn` runs inside `buildTurnPrompt`, so every send path (WebSocket, MCP, schedules, failover resends) gets the same additions:

- The first message after a compaction starts with the "Where we are" block: user messages verbatim, next step, decisions, open items, the artifact index (files with last operation and time, commands with exit codes, unresolved errors with their last output lines) and the lessons and memories for this message. It is cut to 3 000 tokens; the next step is never cut, and the first and latest user messages are the last to go. The block is stored in `durable.regroundings` and the "Re-grounded after compaction" row opens it.
- At 80 % of the context window, a one-sentence request to update the ledger, once per compaction cycle.
- On every message, `(JAgentDesk recitation) Goal: … · Next: … · Open: n`, under 120 tokens.

A message that starts with `/` or `$` is left alone so the command still parses; a pending block waits for the next normal message. When the message already carries the "Relevant memories" attachment the block points to it instead of repeating it.

The switches live with the Memory settings (Settings → Memory) and reach the core through `MemoryPort.durableSettings()`. An `AgentManager` nobody wired with `setDurableContextPorts` runs with all of it off; that keeps embedders and unit tests on exact prompts.

## Claude hooks

Claude sessions get `PreCompact` and `PostCompact` hooks through `AgentLaunchContext.compactionHooks`. PreCompact returns the instruction to keep decisions, open items and files in the summary; PostCompact hands Claude's `compact_summary` to the daemon, which keeps it on the compaction record (Ledger tab → Compactions).

## Rollover and Capture lessons

Both are user actions from the agent tab's ⋯ menu.

- Rollover is `switchAgentProvider` to the same provider and model with reason `rollover`: it never resumes the stored native session, stages the full handoff (ledger, artifact trail, last three turns) and appends "Rolled over to a fresh session".
- Capture lessons sends `CAPTURE_LESSONS_PROMPT` through the same path as a user send, so it is one visible turn. The agent saves lessons with `status: "pending"`; they wait under Memory → Pending lessons. Archiving an agent with 20 or more turns offers it first.
