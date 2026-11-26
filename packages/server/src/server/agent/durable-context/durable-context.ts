import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type {
  AgentCompactionHooks,
  AgentPromptInput,
  AgentTimelineItem,
  AgentUsage,
} from "../agent-sdk-types.js";
import {
  DEFAULT_DURABLE_CONTEXT_SETTINGS,
  hasMemoryBlock,
  startsWithCommand,
  type DurableContextSettings,
  type MemoryPort,
  type MemoryTurnInjection,
} from "../memory-port.js";
import {
  collectTimelineLedgerFacts,
  type LedgerTimelineRow,
} from "../session-ledger/ledger-builder.js";
import {
  emptyDurableState,
  MAX_STORED_COMPACTIONS,
  MAX_STORED_REGROUNDINGS,
  type LedgerCompaction,
  type LedgerDurableState,
  type LedgerRegrounding,
  type StoredSessionLedger,
} from "../session-ledger/ledger-schema.js";
import type { SessionLedgerStore } from "../session-ledger/ledger-store.js";
import { CompactionSignalTracker, type DetectedCompaction } from "./compaction-signal.js";
import {
  buildRegroundingDocument,
  contextShare,
  fitRegroundingBlock,
  LEDGER_NUDGE_SHARE,
  LEDGER_NUDGE_TEXT,
  PRE_COMPACT_INSTRUCTION,
  renderRecitation,
} from "./regrounding.js";

/** Claude's PostCompact summary is attached to a compaction seen this recently. */
const SUMMARY_ATTACH_WINDOW_MS = 5 * 60_000;
const MAX_SUMMARY_CHARS = 40_000;
/** The Context compacted row waits at most this long for the size after the compaction. */
const PENDING_ROW_FLUSH_MS = 15_000;

export interface DurableAgentView {
  id: string;
  provider: string;
  cwd: string;
  sessionId: string | null;
  lastUsage?: AgentUsage;
}

export interface DurableContextDeps {
  store: SessionLedgerStore;
  /** The spec 42 switches (Memory settings); defaults when Memory is not installed. */
  settings(): DurableContextSettings | undefined;
  /** The enabled Memory port, for the lessons and memories inside the block. */
  memory(): MemoryPort | undefined;
  rows(agentId: string): readonly LedgerTimelineRow[];
  appendTimelineItem(agentId: string, item: AgentTimelineItem): Promise<unknown>;
  labelFor(provider: string): string;
  logger: Logger;
  tracker?: CompactionSignalTracker;
  now?: () => Date;
}

export interface PreparedDurableTurn {
  prompt: AgentPromptInput;
  /** Call once the provider accepted the turn: records the block and shows its row. */
  accepted(input: { messageId?: string | null }): Promise<void>;
}

function promptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") return prompt;
  return prompt
    .filter(
      (block): block is { type: "text"; text: string } =>
        block.type === "text" && !("title" in block && block.title),
    )
    .map((block) => block.text)
    .join("\n");
}

function prependText(prompt: AgentPromptInput, text: string): AgentPromptInput {
  if (typeof prompt === "string") return `${text}\n\n${prompt}`;
  return [{ type: "text", text }, ...prompt];
}

function appendText(prompt: AgentPromptInput, text: string): AgentPromptInput {
  if (typeof prompt === "string") return `${prompt}\n\n${text}`;
  return [...prompt, { type: "text", text }];
}

function formatTokens(value: number | null): string {
  return value === null ? "?" : Math.round(value).toLocaleString("en-US");
}

/** The memory lines of a Memory block ("- [lesson, project] …"), for the re-grounding block. */
function memoryLines(injection: MemoryTurnInjection | null): string[] {
  if (!injection) return [];
  return injection.block.text.split("\n").filter((line) => line.startsWith("- "));
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * Goal is the ledger goal the agent wrote itself (spec 42 §2) and never a user message; Next and
 * Open also come from the ledger notes.
 */
function recitationFor(ledger: StoredSessionLedger): string | null {
  return renderRecitation({
    goal: ledger.goal?.text ?? null,
    nextStep: ledger.nextStep?.text ?? null,
    openCount: ledger.openItems.filter((item) => item.closedSeq == null).length,
  });
}

/**
 * Spec 42 §1–§3 for every provider: detects compactions, re-grounds the next turn with the
 * "Where we are" block, recites Goal · Next · Open on every turn and nudges the agent to update its
 * ledger at 80 %. All of it goes into the user's message, never the system prompt, and nothing here
 * ever calls a model or starts a turn.
 */
export class DurableContext {
  private readonly tracker: CompactionSignalTracker;
  private readonly now: () => Date;
  /** Explicit compactions waiting for their after-size before the row is shown. */
  private readonly pendingRows = new Map<string, { compactionId: string; provider: string }>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: DurableContextDeps) {
    this.tracker = deps.tracker ?? new CompactionSignalTracker();
    this.now = deps.now ?? (() => new Date());
  }

  private settings(): DurableContextSettings {
    return this.deps.settings() ?? DEFAULT_DURABLE_CONTEXT_SETTINGS;
  }

  /** Serializes ledger writes per agent so a turn never reads a half-recorded compaction. */
  private enqueue(agentId: string, work: () => Promise<void>): void {
    const previous = this.chains.get(agentId) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
      this.deps.logger.warn({ err: error, agentId }, "Durable context update failed");
    });
    this.chains.set(agentId, next);
    void next.finally(() => {
      if (this.chains.get(agentId) === next) this.chains.delete(agentId);
    });
  }

  /** Waits for compaction records already in flight for this agent. */
  async settle(agentId: string): Promise<void> {
    await (this.chains.get(agentId) ?? Promise.resolve());
  }

  private updateDurable(
    agentId: string,
    mutate: (durable: LedgerDurableState, ledger: StoredSessionLedger) => LedgerDurableState,
  ): Promise<StoredSessionLedger> {
    return this.deps.store.update(agentId, (ledger) => ({
      ...ledger,
      durable: mutate(ledger.durable ?? emptyDurableState(), ledger),
    }));
  }

  observeTimelineItem(agent: DurableAgentView, item: AgentTimelineItem): void {
    if (item.type !== "compaction") return;
    const detected = this.tracker.observeTimelineItem({
      agentId: agent.id,
      provider: agent.provider,
      sessionId: agent.sessionId,
      item,
    });
    if (detected) this.enqueue(agent.id, () => this.recordCompaction(agent.id, detected));
  }

  observeUsage(agent: DurableAgentView, usage: AgentUsage): void {
    const observation = this.tracker.observeUsage({
      agentId: agent.id,
      provider: agent.provider,
      sessionId: agent.sessionId,
      usage,
    });
    if (observation.detected) {
      const detected = observation.detected;
      this.enqueue(agent.id, () => this.recordCompaction(agent.id, detected));
    } else if (observation.postTokens !== null) {
      const postTokens = observation.postTokens;
      this.enqueue(agent.id, () => this.flushRow(agent.id, postTokens));
    }
  }

  /** A turn ended: an explicit compaction still without its after-size shows its row now. */
  onTurnEnded(agentId: string): void {
    if (this.pendingRows.has(agentId)) this.enqueue(agentId, () => this.flushRow(agentId, null));
  }

  /**
   * A fresh native session (rollover, provider switch, `/clear`): a new compaction cycle with
   * nothing pending; the handoff carries the context instead.
   */
  async onFreshSession(agentId: string): Promise<void> {
    this.tracker.reset(agentId);
    this.pendingRows.delete(agentId);
    await this.settle(agentId);
    await this.updateDurable(agentId, (durable) => ({
      ...durable,
      cycle: durable.cycle + 1,
      pendingRegrounding: null,
    }));
  }

  /** Claude's PreCompact / PostCompact hooks (spec 42 §3). */
  hooksFor(agentId: string): AgentCompactionHooks {
    return {
      preCompactInstruction: () => (this.settings().ledgerNudge ? PRE_COMPACT_INSTRUCTION : null),
      onCompactSummary: (input) => {
        this.enqueue(agentId, () => this.recordCompactSummary(agentId, input));
      },
    };
  }

  private async recordCompaction(agentId: string, detected: DetectedCompaction): Promise<void> {
    const at = this.now().toISOString();
    if (detected.confirmsPrevious) {
      // The provider confirmed a compaction already read off the usage drop: same record.
      await this.updateDurable(agentId, (durable) => {
        const last = durable.compactions.at(-1);
        if (!last) return durable;
        const confirmed: LedgerCompaction = {
          ...last,
          inferred: false,
          trigger: detected.trigger ?? last.trigger,
        };
        return { ...durable, compactions: [...durable.compactions.slice(0, -1), confirmed] };
      });
      return;
    }
    const compaction: LedgerCompaction = {
      id: randomUUID(),
      at,
      provider: detected.provider,
      trigger: detected.trigger,
      preTokens: detected.preTokens,
      postTokens: detected.postTokens,
      inferred: detected.inferred,
      summary: null,
    };
    await this.updateDurable(agentId, (durable) => ({
      ...durable,
      cycle: durable.cycle + 1,
      pendingRegrounding: { compactionId: compaction.id },
      compactions: [...durable.compactions, compaction].slice(-MAX_STORED_COMPACTIONS),
    }));
    if (detected.inferred) {
      await this.appendCompactionRow(agentId, compaction);
    } else {
      this.pendingRows.set(agentId, { compactionId: compaction.id, provider: detected.provider });
      // A provider that never reports a smaller size still gets its row.
      const timer = setTimeout(() => {
        if (this.pendingRows.get(agentId)?.compactionId === compaction.id) {
          this.enqueue(agentId, () => this.flushRow(agentId, null));
        }
      }, PENDING_ROW_FLUSH_MS);
      timer.unref?.();
    }
  }

  private async flushRow(agentId: string, postTokens: number | null): Promise<void> {
    const pending = this.pendingRows.get(agentId);
    if (!pending) return;
    this.pendingRows.delete(agentId);
    const ledger = await this.updateDurable(agentId, (durable) => ({
      ...durable,
      compactions: durable.compactions.map((entry) =>
        entry.id === pending.compactionId && postTokens !== null ? { ...entry, postTokens } : entry,
      ),
    }));
    const compaction = ledger.durable?.compactions.find(
      (entry) => entry.id === pending.compactionId,
    );
    if (compaction) await this.appendCompactionRow(agentId, compaction);
  }

  private async appendCompactionRow(agentId: string, compaction: LedgerCompaction): Promise<void> {
    const label = this.deps.labelFor(compaction.provider);
    const sizes =
      compaction.preTokens === null && compaction.postTokens === null
        ? ""
        : ` · ${formatTokens(compaction.preTokens)} → ${formatTokens(compaction.postTokens)} tokens`;
    await this.deps.appendTimelineItem(agentId, {
      type: "notification",
      level: "info",
      message: `Context compacted · ${label}${sizes}${compaction.inferred ? " (inferred)" : ""}`,
      contextCompaction: {
        id: compaction.id,
        provider: compaction.provider,
        trigger: compaction.trigger,
        preTokens: compaction.preTokens,
        postTokens: compaction.postTokens,
        inferred: compaction.inferred,
      },
    });
  }

  private async recordCompactSummary(
    agentId: string,
    input: { summary: string; trigger: "auto" | "manual" | null },
  ): Promise<void> {
    const summary = input.summary.slice(0, MAX_SUMMARY_CHARS);
    const now = this.now();
    await this.updateDurable(agentId, (durable) => {
      const last = durable.compactions.at(-1);
      if (last && now.getTime() - Date.parse(last.at) <= SUMMARY_ATTACH_WINDOW_MS) {
        return {
          ...durable,
          compactions: [...durable.compactions.slice(0, -1), { ...last, summary }],
        };
      }
      // The hook ran before the boundary event reached the daemon: keep the summary on its own
      // record; the boundary event confirms it.
      return {
        ...durable,
        compactions: [
          ...durable.compactions,
          {
            id: randomUUID(),
            at: now.toISOString(),
            provider: "claude",
            trigger: input.trigger,
            preTokens: null,
            postTokens: null,
            inferred: false,
            summary,
          },
        ].slice(-MAX_STORED_COMPACTIONS),
      };
    });
  }

  /**
   * The additions for one turn: the "Where we are" block in front of the first message after a
   * compaction, then the ledger nudge and the recitation line after the message. Null when there
   * is nothing to add. A message that leads with a command (`/compact`, a skill) is left alone.
   */
  async prepareTurn(
    agent: DurableAgentView,
    prompt: AgentPromptInput,
  ): Promise<PreparedDurableTurn | null> {
    await this.settle(agent.id);
    if (this.pendingRows.has(agent.id)) await this.flushRow(agent.id, null);
    const text = promptText(prompt);
    if (startsWithCommand(text)) return null;
    const settings = this.settings();
    const ledger = await this.deps.store.read(agent.id);
    const durable = ledger.durable ?? emptyDurableState();
    const rows = this.deps.rows(agent.id);
    const clearPending = durable.pendingRegrounding !== null;
    const block =
      durable.pendingRegrounding && settings.regroundAfterCompaction
        ? await this.buildRegrounding({
            agent,
            prompt,
            text,
            ledger,
            rows,
            compactionId: durable.pendingRegrounding.compactionId,
          })
        : null;
    const nudge = this.shouldNudge(settings, durable, agent.lastUsage);
    const tail = [
      ...(nudge ? [LEDGER_NUDGE_TEXT] : []),
      ...(settings.recitation ? [recitationFor(ledger)].filter(isPresent) : []),
    ];
    if (!block && !clearPending && tail.length === 0) return null;
    let enriched = block ? prependText(prompt, block.regrounding.text) : prompt;
    if (tail.length > 0) enriched = appendText(enriched, tail.join("\n\n"));
    return {
      prompt: enriched,
      accepted: ({ messageId }) =>
        this.acceptTurn({ agentId: agent.id, block, nudge, clearPending, messageId }),
    };
  }

  private shouldNudge(
    settings: DurableContextSettings,
    durable: LedgerDurableState,
    usage: AgentUsage | undefined,
  ): boolean {
    if (!settings.ledgerNudge || durable.nudgedCycle === durable.cycle) return false;
    const share = contextShare(usage);
    return share !== null && share >= LEDGER_NUDGE_SHARE;
  }

  private async buildRegrounding(input: {
    agent: DurableAgentView;
    prompt: AgentPromptInput;
    text: string;
    ledger: StoredSessionLedger;
    rows: readonly LedgerTimelineRow[];
    compactionId: string;
  }): Promise<{ regrounding: LedgerRegrounding; injection: MemoryTurnInjection | null }> {
    const attached = hasMemoryBlock(input.prompt);
    const injection = attached
      ? null
      : ((await this.deps
          .memory()
          ?.prepareUserTurn({ agentId: input.agent.id, text: input.text })
          .catch(() => null)) ?? null);
    const facts = collectTimelineLedgerFacts({ rows: input.rows, cwd: input.agent.cwd });
    const document = buildRegroundingDocument({
      facts,
      notes: input.ledger,
      memories: memoryLines(injection),
      memoriesAttached: attached,
    });
    const fitted = fitRegroundingBlock(document);
    return {
      regrounding: {
        id: randomUUID(),
        at: this.now().toISOString(),
        compactionId: input.compactionId,
        text: fitted.text,
        estimatedTokens: fitted.estimatedTokens,
      },
      injection,
    };
  }

  private async acceptTurn(input: {
    agentId: string;
    block: { regrounding: LedgerRegrounding; injection: MemoryTurnInjection | null } | null;
    nudge: boolean;
    clearPending: boolean;
    messageId?: string | null;
  }): Promise<void> {
    const regrounding = input.block?.regrounding ?? null;
    await this.updateDurable(input.agentId, (current) => ({
      ...current,
      pendingRegrounding: input.clearPending ? null : current.pendingRegrounding,
      nudgedCycle: input.nudge ? current.cycle : current.nudgedCycle,
      regroundings: regrounding
        ? [...current.regroundings, regrounding].slice(-MAX_STORED_REGROUNDINGS)
        : current.regroundings,
    }));
    if (!regrounding) return;
    await this.deps.appendTimelineItem(input.agentId, {
      type: "notification",
      level: "info",
      message: "Re-grounded after compaction",
      regrounding: {
        id: regrounding.id,
        compactionId: regrounding.compactionId,
        estimatedTokens: regrounding.estimatedTokens,
      },
    });
    await input.block?.injection?.commit({ messageId: input.messageId ?? null });
  }

  async view(
    agentId: string,
  ): Promise<{ compactions: LedgerCompaction[]; regroundings: LedgerRegrounding[] }> {
    const durable = (await this.deps.store.read(agentId)).durable ?? emptyDurableState();
    return { compactions: durable.compactions, regroundings: durable.regroundings };
  }
}
