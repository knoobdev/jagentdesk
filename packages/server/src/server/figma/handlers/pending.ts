import { FigmaServiceError } from "../context.js";
import type { FigmaHandlerMap } from "./types.js";

// Edit queue (32.6.1). Owner: W7.
// Replace each stub with the real handler; keep the map complete (service.ts checks coverage).

export type PendingRequestType =
  | "figma.pending.list.request"
  | "figma.pending.add.request"
  | "figma.pending.remove.request"
  | "figma.pending.discard.request"
  | "figma.pending.apply.request";

const notImplemented = (type: string) => async (): Promise<never> => {
  throw new FigmaServiceError("unsupported", `${type} is not implemented yet`);
};

export const pendingHandlers: FigmaHandlerMap<PendingRequestType> = {
  "figma.pending.list.request": notImplemented("figma.pending.list"),
  "figma.pending.add.request": notImplemented("figma.pending.add"),
  "figma.pending.remove.request": notImplemented("figma.pending.remove"),
  "figma.pending.discard.request": notImplemented("figma.pending.discard"),
  "figma.pending.apply.request": notImplemented("figma.pending.apply"),
};
