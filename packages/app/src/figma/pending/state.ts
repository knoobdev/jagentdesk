import type { FigmaEditOp, FigmaPendingOp } from "@jagentdesk/protocol/figma/rpc-schemas";

// Pure logic behind the pending bar (spec 32.6.1): what the queue contains, when Apply may run,
// and how conflicts resolve. Kept free of React so the review list, bar and buttons are unit
// testable without a daemon.

export type ConflictChoice = "keep_mine" | "keep_figma";

export interface PendingSummary {
  count: number;
  /** Op kinds present in the queue, in first-seen order, for the badges. */
  byType: FigmaEditOp["op"][];
  /** Ops the daemon flagged — the base version moved under them. */
  conflicts: FigmaPendingOp[];
  hasUserOrigin: boolean;
  hasAgentOrigin: boolean;
}

export function summarizePending(ops: readonly FigmaPendingOp[]): PendingSummary {
  const byType: FigmaEditOp["op"][] = [];
  const conflicts: FigmaPendingOp[] = [];
  let hasUserOrigin = false;
  let hasAgentOrigin = false;
  for (const entry of ops) {
    if (!byType.includes(entry.op.op)) byType.push(entry.op.op);
    if (entry.state === "conflict") conflicts.push(entry);
    if (entry.origin === "user") hasUserOrigin = true;
    else hasAgentOrigin = true;
  }
  return { count: ops.length, byType, conflicts, hasUserOrigin, hasAgentOrigin };
}

/** The bar is visible only while the queue holds something the user can act on. */
export function isPendingBarVisible(ops: readonly FigmaPendingOp[]): boolean {
  return ops.some((entry) => entry.state === "pending" || entry.state === "conflict");
}

/**
 * Apply needs a linked, paired file (edits go through the plugin) and at least one actionable op.
 * Conflicts stay put until each one is resolved.
 */
export function canApplyPending(
  ops: readonly FigmaPendingOp[],
  linked: boolean,
  choices: Readonly<Record<string, ConflictChoice>> = {},
): boolean {
  if (!linked) return false;
  if (!conflictsResolved(ops, choices)) return false;
  return ops.some(
    (entry) =>
      entry.state === "pending" || (entry.state === "conflict" && choices[entry.id] !== undefined),
  );
}

/** One label per queued operation for the review list. */
export function describePendingOp(entry: FigmaPendingOp): string {
  const op = entry.op;
  const name = "name" in op && typeof op.name === "string" ? `“${op.name}”` : null;
  return pendingOpLabel(op, name);
}

function pendingOpLabel(op: FigmaPendingOp["op"], name: string | null): string {
  switch (op.op) {
    case "rename":
      return `Rename ${op.nodeId} to ${name ?? "…"}`;
    case "set_visible":
      return `${op.visible ? "Show" : "Hide"} ${op.nodeId}`;
    case "set_locked":
      return `${op.locked ? "Lock" : "Unlock"} ${op.nodeId}`;
    case "delete":
      return `Delete ${op.nodeId}`;
    case "duplicate":
      return `Duplicate ${op.nodeId}`;
    case "reorder":
      return `Move ${op.nodeId} to position ${op.index}`;
    case "set_text":
      return `Set text of ${op.nodeId} to “${op.characters}”`;
    case "set_fill":
      return `Fill ${op.nodeId}`;
    case "set_corner_radius":
      return `Corner radius of ${op.nodeId} → ${op.radius}`;
    case "set_geometry":
      return `Resize or move ${op.nodeId}`;
    case "set_auto_layout":
      return `Auto layout on ${op.nodeId}`;
    case "set_layout_child":
      return `Layout sizing of ${op.nodeId}`;
    case "apply_style":
      return `Apply style ${op.styleId} to ${op.nodeId}`;
    case "bind_variable":
      return `Bind ${op.field} of ${op.nodeId} to a variable`;
    case "create_node":
      return `Create ${op.kind} in ${op.parentId}`;
    default:
      return `${op.op} ${"nodeId" in op ? op.nodeId : ""}`.trim();
  }
}

/**
 * Builds the `resolutions` map for figma.pending.apply: every conflicted op gets the choice the
 * user picked; unresolved conflicts are omitted so the daemon can reject the apply.
 */
export function buildResolutions(
  ops: readonly FigmaPendingOp[],
  choices: Readonly<Record<string, ConflictChoice>>,
): Record<string, ConflictChoice> | undefined {
  const resolutions: Record<string, ConflictChoice> = {};
  let any = false;
  for (const entry of ops) {
    if (entry.state !== "conflict") continue;
    const choice = choices[entry.id];
    if (!choice) return undefined;
    resolutions[entry.id] = choice;
    any = true;
  }
  return any ? resolutions : undefined;
}

/** Every conflict must carry a choice before Apply may run again (32.6.1). */
export function conflictsResolved(
  ops: readonly FigmaPendingOp[],
  choices: Readonly<Record<string, ConflictChoice>>,
): boolean {
  return ops
    .filter((entry) => entry.state === "conflict")
    .every((entry) => choices[entry.id] !== undefined);
}
