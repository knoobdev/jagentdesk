import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  FigmaPendingOpSchema,
  type FigmaEditOp,
  type FigmaNode,
  type FigmaPendingOp,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError, type FigmaContext } from "./context.js";
import { writePrivateFileAtomicSync } from "../private-files.js";

// Edit queue (spec 32.6.1): writes without Figma Link are stored in
// $JAGENTDESK_HOME/figma/pending/<fileKey>.json as ops with `baseVersion` and the old values of the
// properties they touch. `apply` runs the queue through the plugin when the file is linked, checks
// every op's stored previous values against the live node, and asks the user (Keep mine / Keep
// Figma) where they differ. Writes are atomic (temp + rename); every mutation pushes
// `figma.pending.changed`.

const PendingQueueFileSchema = z.object({
  fileKey: z.string(),
  ops: z.array(FigmaPendingOpSchema),
});
export type PendingQueueFile = z.infer<typeof PendingQueueFileSchema>;

export const PENDING_FILE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONFLICT_MESSAGE = "Changed in Figma since you edited";

export function pendingQueuePath(jagentdeskHome: string, fileKey: string): string {
  if (!PENDING_FILE_KEY_PATTERN.test(fileKey)) {
    throw new FigmaServiceError("invalid_input", `Invalid file key ${fileKey}`);
  }
  return path.join(jagentdeskHome, "figma", "pending", `${fileKey}.json`);
}

function saveQueue(ctx: FigmaContext, fileKey: string, ops: FigmaPendingOp[]): void {
  const filePath = pendingQueuePath(ctx.jagentdeskHome, fileKey);
  if (ops.length === 0) {
    rmSync(filePath, { force: true });
  } else {
    const file: PendingQueueFile = { fileKey, ops };
    writePrivateFileAtomicSync(filePath, JSON.stringify(file, null, 2));
  }
  ctx.push({ type: "figma.pending.changed", fileKey, count: ops.length });
}

export async function loadPendingOps(
  ctx: FigmaContext,
  fileKey: string,
): Promise<FigmaPendingOp[]> {
  const filePath = pendingQueuePath(ctx.jagentdeskHome, fileKey);
  if (!existsSync(filePath)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new FigmaServiceError(
      "figma_error",
      `Pending queue for ${fileKey} is corrupt: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = PendingQueueFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FigmaServiceError(
      "figma_error",
      `Pending queue for ${fileKey} is corrupt: ${parsed.error.issues[0]?.message ?? "schema mismatch"}`,
    );
  }
  return parsed.data.ops;
}

/** The node properties each op type must read before queueing, so `apply` can detect conflicts. */
const STATIC_TOUCHED: Partial<Record<FigmaEditOp["op"], readonly string[]>> = {
  rename: ["name"],
  set_visible: ["visible"],
  set_locked: ["locked"],
  set_text: ["characters"],
  set_fill: ["fills"],
  set_corner_radius: ["cornerRadius", "rectangleCornerRadii"],
  apply_style: ["styles"],
  swap_instance: ["componentId"],
  set_reaction: ["reactions"],
};

/** Ops whose touched properties depend on which fields the caller filled in: field → node props. */
const PRESENCE_TOUCHED: Partial<
  Record<FigmaEditOp["op"], readonly (readonly [string, readonly string[]])[]>
> = {
  set_geometry: [
    ["x", ["x"]],
    ["y", ["y"]],
    ["width", ["width"]],
    ["height", ["height"]],
  ],
  set_auto_layout: [
    ["layoutMode", ["layoutMode"]],
    ["itemSpacing", ["itemSpacing"]],
    ["padding", ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]],
    ["primaryAxisSizingMode", ["primaryAxisSizingMode"]],
    ["counterAxisSizingMode", ["counterAxisSizingMode"]],
  ],
  set_layout_child: [
    ["horizontal", ["layoutSizingHorizontal"]],
    ["vertical", ["layoutSizingVertical"]],
  ],
};

function touchedProperties(op: FigmaEditOp): string[] {
  if (op.op === "bind_variable") return [`boundVariables.${op.field}`];
  const statics = STATIC_TOUCHED[op.op];
  if (statics) return [...statics];
  const wanted: string[] = [];
  for (const [field, props] of PRESENCE_TOUCHED[op.op] ?? []) {
    if ((op as Record<string, unknown>)[field] !== undefined) wanted.push(...props);
  }
  return wanted;
}

function opNodeId(op: FigmaEditOp): string | null {
  return "nodeId" in op ? op.nodeId : null;
}

function valueFromNode(node: FigmaNode, property: string): unknown {
  if (property === "x" || property === "y" || property === "width" || property === "height") {
    const bounds = node.absoluteBoundingBox as Record<string, unknown> | undefined;
    return bounds?.[property];
  }
  if (property.startsWith("boundVariables.")) {
    const bound = node.boundVariables as Record<string, unknown> | undefined;
    return bound?.[property.slice("boundVariables.".length)];
  }
  return node[property];
}

/**
 * Reads the current values of the touched properties — through Figma Link when the file is open
 * there, else the REST nodes endpoint. Best effort: when neither answers, the op queues with no
 * previous values (nothing to conflict-check later).
 */
async function readTouchedNodes(
  ctx: FigmaContext,
  fileKey: string,
  nodeIds: string[],
): Promise<Record<string, FigmaNode | null>> {
  if (nodeIds.length === 0) return {};
  if (ctx.link.isLinked(fileKey)) {
    try {
      return await ctx.link.getNodes(fileKey, nodeIds);
    } catch (error) {
      ctx.logger.debug({ err: error }, "figma pending: link read failed, trying REST");
    }
  }
  const file = await ctx.store.getFile(fileKey);
  if (!file) return {};
  try {
    const json = await ctx.rest.getJson<{
      nodes?: Record<string, { document?: FigmaNode } | null>;
    }>({
      connectionId: file.connectionId,
      path: `/v1/files/${fileKey}/nodes`,
      query: { ids: nodeIds.join(",") },
      tier: "1",
    });
    const out: Record<string, FigmaNode | null> = {};
    for (const id of nodeIds) out[id] = json?.nodes?.[id]?.document ?? null;
    return out;
  } catch (error) {
    ctx.logger.debug({ err: error }, "figma pending: REST read failed");
    return {};
  }
}

function previousValues(op: FigmaEditOp, node: FigmaNode | null): Record<string, unknown> {
  if (!node) return {};
  const previous: Record<string, unknown> = {};
  for (const property of touchedProperties(op)) {
    const value = valueFromNode(node, property);
    if (value !== undefined) previous[property] = value;
  }
  return previous;
}

/** Key-order-insensitive comparison of stored previous values against live node values. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function generatePendingOpId(): string {
  return `fpo_${randomBytes(6).toString("hex")}`;
}

export async function addPendingOps(
  ctx: FigmaContext,
  fileKey: string,
  ops: FigmaEditOp[],
  origin: FigmaPendingOp["origin"],
): Promise<FigmaPendingOp[]> {
  const file = await ctx.store.getFile(fileKey);
  const baseVersion = file?.lastVersion ?? "";
  const nodeIds = [...new Set(ops.map(opNodeId).filter((id): id is string => id !== null))];
  const current = await readTouchedNodes(ctx, fileKey, nodeIds);
  const queue = await loadPendingOps(ctx, fileKey);
  const created = ops.map<FigmaPendingOp>((op) => ({
    id: generatePendingOpId(),
    op,
    baseVersion,
    previous: previousValues(op, opNodeId(op) === null ? null : (current[opNodeId(op)!] ?? null)),
    createdAt_ms: ctx.now(),
    origin,
    state: "pending",
  }));
  saveQueue(ctx, fileKey, [...queue, ...created]);
  return created;
}

export async function removePendingOp(
  ctx: FigmaContext,
  fileKey: string,
  opId: string,
): Promise<void> {
  const queue = await loadPendingOps(ctx, fileKey);
  const next = queue.filter((entry) => entry.id !== opId);
  if (next.length === queue.length) {
    throw new FigmaServiceError("invalid_input", `Unknown pending op ${opId}`);
  }
  saveQueue(ctx, fileKey, next);
}

export async function discardPendingOps(ctx: FigmaContext, fileKey: string): Promise<void> {
  saveQueue(ctx, fileKey, []);
}

/** Replaces tempIds a created node got with its real id in every string field of an op. */
export function remapTempIds(op: FigmaEditOp, createdIds: Record<string, string>): FigmaEditOp {
  if (Object.keys(createdIds).length === 0) return op;
  const replace = (value: unknown): unknown => {
    if (typeof value === "string") return createdIds[value] ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, replace(item)]),
      );
    }
    return value;
  };
  return replace(op) as FigmaEditOp;
}

function detectConflict(entry: FigmaPendingOp, current: Record<string, FigmaNode | null>): boolean {
  const nodeId = opNodeId(entry.op);
  if (nodeId === null || Object.keys(entry.previous).length === 0) return false;
  const node = current[nodeId];
  if (!node) return true;
  return Object.entries(entry.previous).some(
    ([property, stored]) => canonical(stored) !== canonical(valueFromNode(node, property)),
  );
}

export async function applyPendingOps(
  ctx: FigmaContext,
  fileKey: string,
  resolutions?: Record<string, "keep_mine" | "keep_figma">,
): Promise<FigmaPendingOp[]> {
  if (!ctx.link.isLinked(fileKey)) {
    throw new FigmaServiceError(
      "link_unavailable",
      "Figma Link is not connected for this file, so queued changes cannot apply yet.",
    );
  }
  const queue = await loadPendingOps(ctx, fileKey);
  if (queue.length === 0) return [];

  const checkIds = [
    ...new Set(
      queue
        .filter((entry) => Object.keys(entry.previous).length > 0 && opNodeId(entry.op) !== null)
        .map((entry) => opNodeId(entry.op)!),
    ),
  ];
  const current = checkIds.length > 0 ? await ctx.link.getNodes(fileKey, checkIds) : {};

  const toApply: FigmaPendingOp[] = [];
  const decisionById = new Map<string, "apply" | "drop" | "conflict">();
  for (const entry of queue) {
    const conflicted = detectConflict(entry, current);
    const resolution = resolutions?.[entry.id];
    if (conflicted && resolution !== "keep_mine") {
      decisionById.set(entry.id, resolution === "keep_figma" ? "drop" : "conflict");
      continue;
    }
    decisionById.set(entry.id, "apply");
    toApply.push(entry);
  }

  let createdIds: Record<string, string> = {};
  let results: { ok: boolean; message?: string }[] = [];
  if (toApply.length > 0) {
    const applied = await ctx.link.applyOps(
      fileKey,
      toApply.map((entry) => entry.op),
    );
    createdIds = applied.createdIds;
    results = applied.results;
  }

  const remaining: FigmaPendingOp[] = [];
  for (const entry of queue) {
    const decision = decisionById.get(entry.id);
    if (decision === "apply") {
      const outcome = results[toApply.indexOf(entry)];
      if (outcome?.ok) continue; // applied: removed from the queue
      remaining.push(remainedFailed(entry, createdIds, outcome?.message));
      continue;
    }
    if (decision === "drop") continue; // keep_figma: the Figma value wins, op discarded
    remaining.push({
      ...entry,
      op: remapTempIds(entry.op, createdIds),
      state: "conflict",
      message: CONFLICT_MESSAGE,
    });
  }
  saveQueue(ctx, fileKey, remaining);
  return remaining;
}

function remainedFailed(
  entry: FigmaPendingOp,
  createdIds: Record<string, string>,
  message: string | undefined,
): FigmaPendingOp {
  return {
    ...entry,
    op: remapTempIds(entry.op, createdIds),
    state: "failed",
    message: message ?? "Figma Link rejected the change.",
  };
}
