# Agent stream performance

How assistant text gets from a provider to the screen, and why it is paced on the way. Read this before changing `packages/server/src/server/agent/agent-stream-coalescer.ts`, the reducer queue in `packages/app/src/timeline/session-stream-reducers.ts`, or the reveal in `packages/app/src/hooks/use-revealed-text.ts`.

For terminal output, which is a separate pipeline with separate budgets, see [terminal-performance.md](terminal-performance.md).

## The pipeline

```
provider deltas (every provider streams incrementally)
  → AgentStreamCoalescer (daemon, leading + trailing, ≤1 message per 60ms per agent)
  → recordTimeline: one canonical row per flushed item
  → agent_stream ws message
  → reducer queue (app, one commit per frame) → session store
  → paced reveal (app, per assistant/reasoning item) → shared Markdown renderer → paint
```

Every provider delivers incremental text, so there is no provider that needs special handling: Claude via `includePartialMessages`, Codex via `agent_message_delta`, ACP agents via `agent_message_chunk`, Pi and OMP via `text_delta`.

## Why the reveal is paced

Arrival is lumpy and there is no fixing that at the source. A 60ms coalescing window carries however many characters the model produced in those 60ms, which swings by an order of magnitude within a single turn. Painting each delta as it lands makes the size of those lumps visible, and that is what reads as jagged.

So arrival sets a _target_ and the reveal rate is derived from the backlog instead. A burst makes the text catch up faster; it does not make the text jump. Shrinking the coalescing window does not fix this — it makes the lumps smaller and more frequent, at the cost of message rate on a daemon loop that already contends with terminal frames and per-message relay encryption.

## Invariants

- **The coalescer is leading + trailing.** The first delta after an idle window flushes synchronously; only the rest of the burst waits for the trailing timer. Reverting to trailing-only adds a full window to the first character of every turn. Same shape and the same reason as `TerminalOutputCoalescer`.
- **The leading flush adds a canonical row, and that is fine.** A burst's first chunk lands as its own timeline row. `mergeAssistantChunks` / `mergeReasoningChunks` in `timeline-projection.ts` join contiguous same-turn rows, and clients read the projected timeline, so history is unaffected. Tests that assert on raw rows have to account for the extra row; tests that assert on what a client sees do not.
- **The store holds the full text; only the rendered slice is paced.** Copy, selection, the chat outline, and scroll geometry all read the same string the user can see. Pacing the store instead would leave the bottom anchor chasing a content height that is ahead of the reveal.
- **First sight of a text is revealed whole.** Only growth is paced. This is what makes history hydration, timeline replay, a virtualized row remounting on scroll, and an already-finished message all render complete on first paint without a special case for each.
- **Leaving `phase: "streaming"` snaps the reveal.** A completed turn must never be left holding characters. `layoutStream` sets the phase, so anything outside the live head with an active turn is already complete.
- **The reducer queue commits on a frame, with a timer as the ceiling.** A frame callback never fires in a hidden tab, so a timer races it and wins when nothing is painting — the store has to keep advancing either way.
- **A history row re-renders only when its item or layout item identity changes.** Native keeps the
  LegendList viewport. Web retains a row's DOM and local state when recent history becomes
  virtualized. `layoutStream` shares unchanged layout items; `useRevisedHistoryRows` replaces items
  whose group, expansion, or breakpoint changed. Add new layout fields to
  `areLayoutItemsEquivalent`, or sharing silently stops.
- **Markdown uses one engine across chat and file previews.** Keep pacing in the reveal hook.
  Native splits only the immutable streaming prefix from the mutable tail, and keeps synchronous
  updates to populated views in the enriched-markdown patch. Web parses new rows synchronously
  after WASM initialization so an empty measurement cannot move the reading anchor.
- **Do not rebrand embedded WASM bytes.** The enriched-markdown patch includes compiler build paths
  inside its binary payload. Changing their spelling corrupts section lengths. Keep the factory
  hunks byte-for-byte upstream and run the renderer browser regression; a successful bundle export
  does not prove the parser can initialize.

## Measuring

- **Reproducing bursty arrival:** the `bursty-stream` model of the dev-only `mock` provider (`packages/server/src/server/agent/providers/mock-load-test-agent.ts`) emits uneven runs of tokens separated by idle gaps. Burst sizes come from a seeded generator, so a run repeats exactly.
- **Rate policy in isolation:** `computeRevealStep` in `packages/app/src/agent-stream/text-reveal.ts` is pure. Setting `TEXT_REVEAL_HORIZON_MS` to 0 paints on arrival, which gives you the unpaced baseline.
- **User-perceived smoothness:** there is no checked-in browser spec. Sample two numbers per frame while a `bursty-stream` agent streams: the coefficient of variation of characters painted per frame (smoothness) and the p95 gap between visible updates (stalls). You need both, because a stalled stream is perfectly smooth.

Measure the **total** length across every `assistant-message` element, not the last one. A turn emits many assistant messages, so the tail element keeps changing identity and its length is not monotonic; sampling only the tail reads those handovers as resets and reports almost no growth.
