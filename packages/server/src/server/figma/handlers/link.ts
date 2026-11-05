import { FigmaServiceError } from "../context.js";
import type { FigmaHandlerMap } from "./types.js";

// Figma Link status, pairing, settings and edit ops (32.4, 32.6). Owner: W6.
// Replace each stub with the real handler; keep the map complete (service.ts checks coverage).

export type LinkRequestType =
  | "figma.link.status.request"
  | "figma.link.pair.request"
  | "figma.link.revoke.request"
  | "figma.link.settings.request"
  | "figma.link.op.request";

const notImplemented = (type: string) => async (): Promise<never> => {
  throw new FigmaServiceError("unsupported", `${type} is not implemented yet`);
};

export const linkHandlers: FigmaHandlerMap<LinkRequestType> = {
  "figma.link.status.request": notImplemented("figma.link.status"),
  "figma.link.pair.request": notImplemented("figma.link.pair"),
  "figma.link.revoke.request": notImplemented("figma.link.revoke"),
  "figma.link.settings.request": notImplemented("figma.link.settings"),
  "figma.link.op.request": notImplemented("figma.link.op"),
};
