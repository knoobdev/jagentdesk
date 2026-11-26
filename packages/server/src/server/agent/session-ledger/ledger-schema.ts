import { z } from "zod";

/** A note the agent wrote with `update_session_ledger`, anchored to the timeline seq it was written at. */
export const LedgerNoteSchema = z.object({
  id: z.string(),
  text: z.string(),
  seq: z.number().int(),
  at: z.string(),
});

export const LedgerOpenItemSchema = LedgerNoteSchema.extend({
  closedSeq: z.number().int().nullable().optional(),
  closedAt: z.string().nullable().optional(),
});

export const HandoffModeSchema = z.enum(["handoff", "delta"]);
export const HandoffReasonSchema = z.enum(["manual", "failover", "child", "rollover"]);

/** A handoff or delta message the daemon sent (or staged) for a provider that took over the agent. */
export const LedgerHandoffRecordSchema = z.object({
  id: z.string(),
  at: z.string(),
  seq: z.number().int(),
  fromProvider: z.string(),
  toProvider: z.string(),
  model: z.string().nullable(),
  mode: HandoffModeSchema,
  reason: HandoffReasonSchema,
  text: z.string(),
  estimatedTokens: z.number().int(),
  budgetTokens: z.number().int(),
});

/** One compaction the daemon saw (spec 42 §1), with Claude's own summary when it reported one. */
export const LedgerCompactionSchema = z.object({
  id: z.string(),
  at: z.string(),
  provider: z.string(),
  trigger: z.string().nullable(),
  preTokens: z.number().nullable(),
  postTokens: z.number().nullable(),
  inferred: z.boolean(),
  summary: z.string().nullable(),
});

/** A "Where we are" block the daemon sent after a compaction (spec 42 §2). */
export const LedgerRegroundingSchema = z.object({
  id: z.string(),
  at: z.string(),
  compactionId: z.string().nullable(),
  text: z.string(),
  estimatedTokens: z.number().int(),
});

/** Spec 42 per-agent state; survives a daemon restart between a compaction and the next turn. */
export const LedgerDurableStateSchema = z.object({
  /** Compaction cycle: grows by one with every compaction or fresh session. */
  cycle: z.number().int(),
  /** The cycle the 80 % ledger nudge was last sent in (at most once per cycle). */
  nudgedCycle: z.number().int().nullable(),
  /** Set by a compaction; the next turn carries the re-grounding block and clears it. */
  pendingRegrounding: z.object({ compactionId: z.string() }).nullable(),
  compactions: z.array(LedgerCompactionSchema),
  regroundings: z.array(LedgerRegroundingSchema),
});

export const StoredSessionLedgerSchema = z.object({
  version: z.literal(1),
  agentId: z.string(),
  /** Git state when the ledger first saw the agent; edited-file diffs are taken against it. */
  git: z.object({ root: z.string(), baseCommit: z.string() }).nullable().optional(),
  /**
   * The task the user is giving the agent now, written by the agent itself (spec 40 §2, 42 §2).
   * The per-turn recitation reads its Goal from here and nowhere else.
   */
  goal: LedgerNoteSchema.nullable().optional(),
  decisions: z.array(LedgerNoteSchema),
  openItems: z.array(LedgerOpenItemSchema),
  nextStep: LedgerNoteSchema.nullable(),
  handoffs: z.array(LedgerHandoffRecordSchema),
  /** Staged text the next turn on the new provider carries; cleared once that turn starts. */
  pendingHandoff: z.object({ id: z.string(), text: z.string() }).nullable(),
  durable: LedgerDurableStateSchema.optional(),
});

export type LedgerNote = z.infer<typeof LedgerNoteSchema>;
export type LedgerOpenItem = z.infer<typeof LedgerOpenItemSchema>;
export type LedgerHandoffRecord = z.infer<typeof LedgerHandoffRecordSchema>;
export type HandoffMode = z.infer<typeof HandoffModeSchema>;
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;
export type StoredSessionLedger = z.infer<typeof StoredSessionLedgerSchema>;
export type LedgerCompaction = z.infer<typeof LedgerCompactionSchema>;
export type LedgerRegrounding = z.infer<typeof LedgerRegroundingSchema>;
export type LedgerDurableState = z.infer<typeof LedgerDurableStateSchema>;

export const MAX_STORED_COMPACTIONS = 20;
export const MAX_STORED_REGROUNDINGS = 10;

export function emptyDurableState(): LedgerDurableState {
  return {
    cycle: 0,
    nudgedCycle: null,
    pendingRegrounding: null,
    compactions: [],
    regroundings: [],
  };
}

export const MAX_STORED_HANDOFFS = 10;

export function emptySessionLedger(agentId: string): StoredSessionLedger {
  return {
    version: 1,
    agentId,
    decisions: [],
    openItems: [],
    nextStep: null,
    handoffs: [],
    pendingHandoff: null,
  };
}

/** Input of the `update_session_ledger` tool. */
export const SessionLedgerUpdateInputSchema = z.object({
  goal: z
    .string()
    .optional()
    .describe(
      "The task the user is giving you now, in one line. Set it when the user gives you a new task; it replaces the old goal.",
    ),
  decisions: z
    .array(z.string())
    .optional()
    .describe("Decisions made so far, with the reason in one line each. New entries are appended."),
  openItems: z
    .array(
      z.union([
        z.string(),
        z.object({
          text: z.string(),
          done: z.boolean().optional(),
        }),
      ]),
    )
    .optional()
    .describe(
      'Unfinished work. A plain string adds an item; {"text", "done": true} closes the item with that text or id.',
    ),
  nextStep: z
    .string()
    .optional()
    .describe("The single next step you would take. Replaces the old one."),
});

export type SessionLedgerUpdateInput = z.infer<typeof SessionLedgerUpdateInputSchema>;
