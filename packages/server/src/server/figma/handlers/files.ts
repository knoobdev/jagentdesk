import { FigmaServiceError } from "../context.js";
import type { FigmaHandlerMap } from "./types.js";

// Files, teams, projects (32.3) and the REST budget (32.8). Owner: W3.
// Replace each stub with the real handler; keep the map complete (service.ts checks coverage).

export type FilesRequestType =
  | "figma.files.list.request"
  | "figma.files.add.request"
  | "figma.files.remove.request"
  | "figma.files.pin.request"
  | "figma.teams.add.request"
  | "figma.teams.remove.request"
  | "figma.teams.list.request"
  | "figma.teams.projects.request"
  | "figma.teams.files.request"
  | "figma.budget.get.request";

const notImplemented = (type: string) => async (): Promise<never> => {
  throw new FigmaServiceError("unsupported", `${type} is not implemented yet`);
};

export const filesHandlers: FigmaHandlerMap<FilesRequestType> = {
  "figma.files.list.request": notImplemented("figma.files.list"),
  "figma.files.add.request": notImplemented("figma.files.add"),
  "figma.files.remove.request": notImplemented("figma.files.remove"),
  "figma.files.pin.request": notImplemented("figma.files.pin"),
  "figma.teams.add.request": notImplemented("figma.teams.add"),
  "figma.teams.remove.request": notImplemented("figma.teams.remove"),
  "figma.teams.list.request": notImplemented("figma.teams.list"),
  "figma.teams.projects.request": notImplemented("figma.teams.projects"),
  "figma.teams.files.request": notImplemented("figma.teams.files"),
  "figma.budget.get.request": notImplemented("figma.budget.get"),
};
