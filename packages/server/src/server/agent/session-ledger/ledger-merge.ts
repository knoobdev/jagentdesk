import type {
  LedgerNote,
  LedgerOpenItem,
  SessionLedgerUpdateInput,
  StoredSessionLedger,
} from "./ledger-schema.js";

export interface LedgerMergeContext {
  /** Timeline seq the update is anchored to (the agent's latest row when it called the tool). */
  seq: number;
  at: string;
  createId: () => string;
}

export interface LedgerMergeResult {
  ledger: StoredSessionLedger;
  added: { decisions: number; openItems: number };
  closed: number;
  goalChanged: boolean;
  nextStepChanged: boolean;
}

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function mergeDecisions(
  existing: readonly LedgerNote[],
  incoming: readonly string[],
  context: LedgerMergeContext,
): LedgerNote[] {
  const decisions = [...existing];
  const known = new Set(decisions.map((note) => normalize(note.text)));
  for (const raw of incoming) {
    const text = raw.trim();
    if (!text || known.has(normalize(text))) continue;
    known.add(normalize(text));
    decisions.push({ id: context.createId(), text, seq: context.seq, at: context.at });
  }
  return decisions;
}

type OpenItemInput = NonNullable<SessionLedgerUpdateInput["openItems"]>[number];

function mergeOpenItems(
  existing: readonly LedgerOpenItem[],
  incoming: readonly OpenItemInput[],
  context: LedgerMergeContext,
): { openItems: LedgerOpenItem[]; added: number; closed: number } {
  const openItems = existing.map((item) => Object.assign({}, item));
  let added = 0;
  let closed = 0;
  for (const entry of incoming) {
    const text = (typeof entry === "string" ? entry : entry.text).trim();
    if (!text) continue;
    const key = normalize(text);
    const match = openItems.find(
      (item) => item.closedSeq == null && (item.id === text || normalize(item.text) === key),
    );
    const done = typeof entry !== "string" && entry.done === true;
    if (done && match) {
      match.closedSeq = context.seq;
      match.closedAt = context.at;
      closed += 1;
    } else if (!done && !match) {
      openItems.push({
        id: context.createId(),
        text,
        seq: context.seq,
        at: context.at,
        closedSeq: null,
        closedAt: null,
      });
      added += 1;
    }
  }
  return { openItems, added, closed };
}

/** A single-value note (goal, next step): a non-empty different text replaces the old one. */
function replaceNote(
  current: LedgerNote | null,
  incoming: string | undefined,
  context: LedgerMergeContext,
): { note: LedgerNote | null; changed: boolean } {
  const text = incoming?.trim() ?? "";
  if (!text || normalize(text) === normalize(current?.text ?? "")) {
    return { note: current, changed: false };
  }
  return {
    note: { id: context.createId(), text, seq: context.seq, at: context.at },
    changed: true,
  };
}

/**
 * Anchored merge: new decisions and open items are appended with the current seq, items marked
 * done are closed in place, and the goal and the next step are replaced. Nothing already written is rewritten,
 * so a later handoff can tell exactly which notes changed after a given seq.
 */
export function mergeSessionLedgerUpdate(
  ledger: StoredSessionLedger,
  update: SessionLedgerUpdateInput,
  context: LedgerMergeContext,
): LedgerMergeResult {
  const decisions = mergeDecisions(ledger.decisions, update.decisions ?? [], context);
  const items = mergeOpenItems(ledger.openItems, update.openItems ?? [], context);
  const goal = replaceNote(ledger.goal ?? null, update.goal, context);
  const nextStep = replaceNote(ledger.nextStep, update.nextStep, context);

  return {
    ledger: {
      ...ledger,
      goal: goal.note,
      decisions,
      openItems: items.openItems,
      nextStep: nextStep.note,
    },
    added: {
      decisions: decisions.length - ledger.decisions.length,
      openItems: items.added,
    },
    closed: items.closed,
    goalChanged: goal.changed,
    nextStepChanged: nextStep.changed,
  };
}
