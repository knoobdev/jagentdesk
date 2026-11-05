import type { FigmaHandlerMap } from "./types.js";
import {
  addPendingOps,
  applyPendingOps,
  discardPendingOps,
  loadPendingOps,
  removePendingOp,
} from "../pending.js";

// Edit queue RPC handlers (spec 32.9). The queue itself lives in ../pending.ts; these handlers
// only map requests onto it. `figma.pending.add` comes from the canvas UI, so its ops queue with
// origin "user"; the agent's figma_queue_ops tool calls the queue module directly with "agent".

export type PendingRequestType =
  | "figma.pending.list.request"
  | "figma.pending.add.request"
  | "figma.pending.remove.request"
  | "figma.pending.discard.request"
  | "figma.pending.apply.request";

export const pendingHandlers: FigmaHandlerMap<PendingRequestType> = {
  "figma.pending.list.request": async (request, ctx) => ({
    ops: await loadPendingOps(ctx, request.fileKey),
  }),
  "figma.pending.add.request": async (request, ctx) => ({
    ops: await addPendingOps(ctx, request.fileKey, request.ops, "user"),
  }),
  "figma.pending.remove.request": async (request, ctx) => {
    await removePendingOp(ctx, request.fileKey, request.opId);
    return {};
  },
  "figma.pending.discard.request": async (request, ctx) => {
    await discardPendingOps(ctx, request.fileKey);
    return {};
  },
  "figma.pending.apply.request": async (request, ctx) => ({
    ops: await applyPendingOps(ctx, request.fileKey, request.resolutions),
  }),
};
