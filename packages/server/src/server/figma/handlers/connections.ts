import { FigmaServiceError } from "../context.js";
import type { FigmaHandlerMap } from "./types.js";

// Connections + OAuth (32.2). Owner: work package W2.
// Replace each stub with the real handler; keep the map complete (service.ts checks coverage).

export type ConnectionsRequestType =
  | "figma.connections.list.request"
  | "figma.connections.remove.request"
  | "figma.connections.test.request"
  | "figma.oauth.begin.request"
  | "figma.oauth.complete.request"
  | "figma.oauth.delegate.request";

const notImplemented = (type: string) => async (): Promise<never> => {
  throw new FigmaServiceError("unsupported", `${type} is not implemented yet`);
};

export const connectionsHandlers: FigmaHandlerMap<ConnectionsRequestType> = {
  "figma.connections.list.request": notImplemented("figma.connections.list"),
  "figma.connections.remove.request": notImplemented("figma.connections.remove"),
  "figma.connections.test.request": notImplemented("figma.connections.test"),
  "figma.oauth.begin.request": notImplemented("figma.oauth.begin"),
  "figma.oauth.complete.request": notImplemented("figma.oauth.complete"),
  "figma.oauth.delegate.request": notImplemented("figma.oauth.delegate"),
};
