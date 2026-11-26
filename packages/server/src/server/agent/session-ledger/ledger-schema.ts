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
export const HandoffReasonSchema = z.enum(["manual", "failover", "child"]);

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

export const StoredSessionLedgerSchema = z.object({
  version: z.literal(1),
  agentId: z.string(),
  /** Git state when the ledger first saw the agent; edited-file diffs are taken against it. */
  git: z.object({ root: z.string(), baseCommit: z.string() }).nullable().optional(),
  decisions: z.array(LedgerNoteSchema),
  openItems: z.array(LedgerOpenItemSchema),
  nextStep: LedgerNoteSchema.nullable(),
  handoffs: z.array(LedgerHandoffRecordSchema),
  /** Staged text the next turn on the new provider carries; cleared once that turn starts. */
  pendingHandoff: z.object({ id: z.string(), text: z.string() }).nullable(),
});

export type LedgerNote = z.infer<typeof LedgerNoteSchema>;
export type LedgerOpenItem = z.infer<typeof LedgerOpenItemSchema>;
export type LedgerHandoffRecord = z.infer<typeof LedgerHandoffRecordSchema>;
export type HandoffMode = z.infer<typeof HandoffModeSchema>;
export type HandoffReason = z.infer<typeof HandoffReasonSchema>;
export type StoredSessionLedger = z.infer<typeof StoredSessionLedgerSchema>;

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
