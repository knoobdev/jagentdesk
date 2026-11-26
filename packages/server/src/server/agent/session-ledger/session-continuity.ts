import { randomUUID } from "node:crypto";
import { collectTimelineLedgerFacts, type LedgerTimelineRow } from "./ledger-builder.js";
import { readLedgerFileDiffs, readLedgerGitBase } from "./ledger-git.js";
import { mergeSessionLedgerUpdate, type LedgerMergeResult } from "./ledger-merge.js";
import {
  buildLedgerDocument,
  fitHandoff,
  renderHandoffText,
  renderLedgerMarkdown,
  type LedgerDocument,
} from "./ledger-render.js";
import {
  MAX_STORED_HANDOFFS,
  type HandoffMode,
  type HandoffReason,
  type LedgerHandoffRecord,
  type SessionLedgerUpdateInput,
  type StoredSessionLedger,
} from "./ledger-schema.js";
import type { SessionLedgerStore } from "./ledger-store.js";

export const SESSION_LEDGER_INSTRUCTION = [
  "JAgentDesk keeps a session ledger for you so another model can pick this work up without losing context.",
  "Call the update_session_ledger tool during normal work, in the same turn, whenever the user gives you a " +
    "new task (set goal to it in one line, replacing the old goal), you make a decision worth remembering " +
    "(with a one-line reason), open or finish a piece of work, or change what you would do next. Keep entries short. Do not call it for trivial turns. Files, commands, errors and the user's " +
    "messages are recorded automatically; do not repeat them.",
  "Before you create a child agent on a provider other than your own, call list_child_providers and " +
    "pick the entry marked suggested unless the task needs a specific model.",
].join(" ");

export interface LedgerDocumentInput {
  agentId: string;
  cwd: string;
  rows: readonly LedgerTimelineRow[];
  sinceSeq?: number;
  recentTurns?: number;
}

export interface StageHandoffInput extends LedgerDocumentInput {
  mode: HandoffMode;
  reason: HandoffReason;
  fromProvider: string;
  toProvider: string;
  model: string | null;
  budgetTokens: number;
}

/** Ledger reads, anchored note merges and handoff staging for one daemon. No model is ever called. */
export class SessionContinuity {
  constructor(readonly store: SessionLedgerStore) {}

  read(agentId: string): Promise<StoredSessionLedger> {
    return this.store.read(agentId);
  }

  /** Records the git HEAD the first time the ledger sees an agent; edited-file diffs use it. */
  async ensureGitBase(agentId: string, cwd: string): Promise<void> {
    const ledger = await this.store.read(agentId);
    // `null` means the cwd was checked and is not a git checkout.
    if (ledger.git !== undefined) return;
    const base = await readLedgerGitBase(cwd);
    await this.store.update(agentId, (current) =>
      current.git !== undefined ? current : { ...current, git: base },
    );
  }

  async updateNotes(input: {
    agentId: string;
    update: SessionLedgerUpdateInput;
    seq: number;
  }): Promise<LedgerMergeResult> {
    let result: LedgerMergeResult | null = null;
    await this.store.update(input.agentId, (ledger) => {
      result = mergeSessionLedgerUpdate(ledger, input.update, {
        seq: input.seq,
        at: new Date().toISOString(),
        createId: () => randomUUID().slice(0, 8),
      });
      return result.ledger;
    });
    if (!result) throw new Error(`Session ledger update for ${input.agentId} did not run`);
    return result;
  }

  async buildDocument(input: LedgerDocumentInput): Promise<LedgerDocument> {
    const ledger = await this.store.read(input.agentId);
    const facts = collectTimelineLedgerFacts({
      rows: input.rows,
      cwd: input.cwd,
      sinceSeq: input.sinceSeq,
    });
    const changed = facts.files
      .filter((file) => file.operations.some((operation) => operation !== "read"))
      .map((file) => file.path);
    const diffs =
      ledger.git && changed.length > 0
        ? await readLedgerFileDiffs({ cwd: input.cwd, base: ledger.git, paths: changed })
        : undefined;
    return buildLedgerDocument({
      facts,
      notes: ledger,
      diffs,
      sinceSeq: input.sinceSeq,
      recentTurns: input.recentTurns,
    });
  }

  async renderMarkdown(input: LedgerDocumentInput & { title: string | null }): Promise<string> {
    const document = await this.buildDocument({ ...input, recentTurns: 0 });
    return renderLedgerMarkdown({ document, agentTitle: input.title, agentId: input.agentId });
  }

  /**
   * Builds the handoff (full ledger plus the last turns) or the delta (what changed after
   * `sinceSeq`), fits it to the budget and stages it for the next turn.
   */
  async stageHandoff(input: StageHandoffInput): Promise<LedgerHandoffRecord> {
    const document = await this.buildDocument({
      ...input,
      recentTurns: input.mode === "delta" ? Number.POSITIVE_INFINITY : input.recentTurns,
    });
    const fitted = fitHandoff({
      document,
      budgetTokens: input.budgetTokens,
      render: (current) =>
        renderHandoffText({
          document: current,
          mode: input.mode,
          agentId: input.agentId,
          fromProvider: input.fromProvider,
          toProvider: input.toProvider,
        }),
    });
    const seq = input.rows.reduce((latest, row) => Math.max(latest, row.seq), 0);
    const record: LedgerHandoffRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      seq,
      fromProvider: input.fromProvider,
      toProvider: input.toProvider,
      model: input.model,
      mode: input.mode,
      reason: input.reason,
      text: fitted.text,
      estimatedTokens: fitted.estimatedTokens,
      budgetTokens: fitted.budgetTokens,
    };
    await this.store.update(input.agentId, (ledger) => ({
      ...ledger,
      handoffs: [...ledger.handoffs, record].slice(-MAX_STORED_HANDOFFS),
      pendingHandoff: { id: record.id, text: record.text },
    }));
    return record;
  }

  /**
   * Spec 40 §5: a child on another provider gets its parent's ledger cut down to the parent's goal,
   * the user's messages (newest first) and the files touched, instead of the parent's transcript.
   */
  async renderChildHandoff(input: {
    parentId: string;
    cwd: string;
    rows: readonly LedgerTimelineRow[];
    fromProvider: string;
    toProvider: string;
    budgetTokens: number;
  }): Promise<string> {
    const facts = collectTimelineLedgerFacts({ rows: input.rows, cwd: input.cwd });
    const parent = await this.store.read(input.parentId);
    const document = buildLedgerDocument({
      facts: { ...facts, commands: [], errors: [], turns: [] },
      notes: { goal: parent.goal ?? null, decisions: [], openItems: [], nextStep: null },
      recentTurns: 0,
    });
    return fitHandoff({
      document,
      budgetTokens: input.budgetTokens,
      render: (current) =>
        renderHandoffText({
          document: current,
          mode: "child",
          agentId: input.parentId,
          fromProvider: input.fromProvider,
          toProvider: input.toProvider,
        }),
    }).text;
  }

  /** Renders a handoff without staging it. */
  async renderHandoff(input: StageHandoffInput): Promise<string> {
    const document = await this.buildDocument(input);
    return fitHandoff({
      document,
      budgetTokens: input.budgetTokens,
      render: (current) =>
        renderHandoffText({
          document: current,
          mode: input.mode,
          agentId: input.agentId,
          fromProvider: input.fromProvider,
          toProvider: input.toProvider,
        }),
    }).text;
  }

  async peekPendingHandoff(agentId: string): Promise<{ id: string; text: string } | null> {
    return (await this.store.read(agentId)).pendingHandoff;
  }

  async clearPendingHandoff(agentId: string, id: string): Promise<void> {
    await this.store.update(agentId, (ledger) =>
      ledger.pendingHandoff?.id === id ? { ...ledger, pendingHandoff: null } : ledger,
    );
  }

  async discardPendingHandoff(agentId: string): Promise<void> {
    await this.store.update(agentId, (ledger) =>
      ledger.pendingHandoff ? { ...ledger, pendingHandoff: null } : ledger,
    );
  }
}
