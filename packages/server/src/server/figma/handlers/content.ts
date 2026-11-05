import { FigmaServiceError } from "../context.js";
import type { FigmaHandlerMap } from "./types.js";

// Outline, nodes, image fills, fallback renders, export, versions, fonts, watches (32.5, 32.8). Owner: W4.
// Replace each stub with the real handler; keep the map complete (service.ts checks coverage).

export type ContentRequestType =
  | "figma.file.outline.request"
  | "figma.file.nodes.request"
  | "figma.file.imageFills.request"
  | "figma.file.render.request"
  | "figma.file.export.request"
  | "figma.file.versions.request"
  | "figma.fonts.get.request"
  | "figma.file.watch.request"
  | "figma.file.unwatch.request";

const notImplemented = (type: string) => async (): Promise<never> => {
  throw new FigmaServiceError("unsupported", `${type} is not implemented yet`);
};

export const contentHandlers: FigmaHandlerMap<ContentRequestType> = {
  "figma.file.outline.request": notImplemented("figma.file.outline"),
  "figma.file.nodes.request": notImplemented("figma.file.nodes"),
  "figma.file.imageFills.request": notImplemented("figma.file.imageFills"),
  "figma.file.render.request": notImplemented("figma.file.render"),
  "figma.file.export.request": notImplemented("figma.file.export"),
  "figma.file.versions.request": notImplemented("figma.file.versions"),
  "figma.fonts.get.request": notImplemented("figma.fonts.get"),
  "figma.file.watch.request": notImplemented("figma.file.watch"),
  "figma.file.unwatch.request": notImplemented("figma.file.unwatch"),
};
