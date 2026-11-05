import { FigmaServiceError } from "../context.js";
import type { FigmaHandlerMap } from "./types.js";

// Comments (32.5.4) and prototype data (32.5.3). Owner: W5.
// Replace each stub with the real handler; keep the map complete (service.ts checks coverage).

export type CommentsRequestType =
  | "figma.file.comments.list.request"
  | "figma.file.comments.post.request"
  | "figma.file.comments.delete.request"
  | "figma.file.comments.react.request"
  | "figma.file.prototype.request";

const notImplemented = (type: string) => async (): Promise<never> => {
  throw new FigmaServiceError("unsupported", `${type} is not implemented yet`);
};

export const commentsHandlers: FigmaHandlerMap<CommentsRequestType> = {
  "figma.file.comments.list.request": notImplemented("figma.file.comments.list"),
  "figma.file.comments.post.request": notImplemented("figma.file.comments.post"),
  "figma.file.comments.delete.request": notImplemented("figma.file.comments.delete"),
  "figma.file.comments.react.request": notImplemented("figma.file.comments.react"),
  "figma.file.prototype.request": notImplemented("figma.file.prototype"),
};
