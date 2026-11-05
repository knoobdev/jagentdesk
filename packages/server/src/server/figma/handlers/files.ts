import {
  type FigmaFile,
  type FigmaProject,
  type FigmaProjectFile,
  type FigmaTeam,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError } from "../context.js";
import type { FigmaContext } from "../context.js";
import type { FigmaHandlerMap } from "./types.js";

// Files, teams, projects (32.3) and the REST budget (32.8). Owner: W3.
//
// Figma has no "my files" API (research §3.3): the file list is user-pasted URLs or keys and the
// daemon fetches each file's name from `GET /v1/files/:key/meta` (Tier 3). Teams are pasted too;
// browsing a team's projects needs the folders/projects endpoints, which public OAuth apps cannot
// use — a 403/404 there becomes `forbidden` telling the user to paste file URLs instead.

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

/** Figma file and branch keys: alphanumeric, branch keys carry one `:` segment. */
const BARE_KEY = /^[A-Za-z0-9]+(?::[A-Za-z0-9]+)?$/;
const FILE_URL_KINDS = new Set(["design", "file", "proto"]);

function figmaUrlSegments(input: string): string[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!/(^|\.)figma\.com$/i.test(url.hostname)) return null;
  return url.pathname.split("/").filter((segment) => segment.length > 0);
}

/** Parses `figma.com/design|file|proto/<key>/…` or a bare file key. Null when neither matches. */
export function parseFigmaFileUrl(input: string): string | null {
  const trimmed = input.trim();
  if (BARE_KEY.test(trimmed)) return trimmed;
  const segments = figmaUrlSegments(input);
  if (!segments || segments.length < 2) return null;
  if (!FILE_URL_KINDS.has(segments[0].toLowerCase())) return null;
  return BARE_KEY.test(segments[1]) ? segments[1] : null;
}

/** Parses `figma.com/files/team/<id>/…` or a bare team id. Null when neither matches. */
export function parseFigmaTeamUrl(input: string): string | null {
  const trimmed = input.trim();
  if (BARE_KEY.test(trimmed)) return trimmed;
  const segments = figmaUrlSegments(input);
  if (!segments || segments.length < 3) return null;
  if (!(segments[0].toLowerCase() === "files" && segments[1].toLowerCase() === "team")) return null;
  return BARE_KEY.test(segments[2]) ? segments[2] : null;
}

interface FileMetaResponse {
  name?: unknown;
  version?: unknown;
  last_touched_at?: unknown;
}

interface TeamProjectsResponse {
  name?: unknown;
  projects?: unknown;
}

interface ProjectFilesResponse {
  name?: unknown;
  files?: unknown;
}

function isoToMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function requireConnection(ctx: FigmaContext, connectionId: string): Promise<void> {
  const connection = await ctx.store.getConnection(connectionId);
  if (!connection) {
    throw new FigmaServiceError("not_found", `Unknown Figma connection ${connectionId}.`);
  }
}

/** Team/project browsing endpoints: public apps answer 403/404 (research §3.3). */
async function getBrowseJson<T>(
  ctx: FigmaContext,
  input: Parameters<FigmaContext["rest"]["getJson"]>[0],
): Promise<T> {
  try {
    return await ctx.rest.getJson<T>(input);
  } catch (error) {
    if (
      error instanceof FigmaServiceError &&
      (error.code === "forbidden" || error.code === "not_found")
    ) {
      throw new FigmaServiceError(
        "forbidden",
        "Figma could not browse this team with your app — paste file URLs instead.",
      );
    }
    throw error;
  }
}

export const filesHandlers: FigmaHandlerMap<FilesRequestType> = {
  "figma.files.list.request": async (request, ctx) => {
    const files = await ctx.store.listFiles(request.connectionId);
    // `linked` is live link-plugin state (32.4), never stored truth.
    for (const file of files) file.linked = ctx.link.isLinked(file.fileKey);
    return { files };
  },

  "figma.files.add.request": async (request, ctx) => {
    const fileKey = parseFigmaFileUrl(request.url);
    if (!fileKey) {
      throw new FigmaServiceError(
        "invalid_input",
        `Not a Figma file URL or file key: ${request.url}`,
      );
    }
    await requireConnection(ctx, request.connectionId);
    const existing = await ctx.store.getFile(fileKey);
    const meta = await ctx.rest.getJson<FileMetaResponse>({
      connectionId: request.connectionId,
      path: `/v1/files/${encodeURIComponent(fileKey)}/meta`,
      tier: "3",
    });
    const name = optionalString(meta?.name);
    if (!name) {
      throw new FigmaServiceError("figma_error", `Figma returned no file name for ${fileKey}.`);
    }
    const file: FigmaFile = {
      fileKey,
      connectionId: request.connectionId,
      name,
      pinned: existing?.pinned ?? false,
      lastVersion: optionalString(meta.version),
      lastModified_ms: isoToMs(meta.last_touched_at),
      lastOpenedAt_ms: existing?.lastOpenedAt_ms,
      linked: ctx.link.isLinked(fileKey),
    };
    await ctx.store.saveFile(file);
    return { file };
  },

  "figma.files.remove.request": async (request, ctx) => {
    const existing = await ctx.store.getFile(request.fileKey);
    if (!existing) {
      throw new FigmaServiceError("not_found", `No tracked Figma file ${request.fileKey}.`);
    }
    await ctx.store.removeFile(request.fileKey);
    return {};
  },

  "figma.files.pin.request": async (request, ctx) => {
    const existing = await ctx.store.getFile(request.fileKey);
    if (!existing) {
      throw new FigmaServiceError("not_found", `No tracked Figma file ${request.fileKey}.`);
    }
    const file: FigmaFile = { ...existing, pinned: request.pinned };
    await ctx.store.saveFile(file);
    return { file };
  },

  "figma.teams.add.request": async (request, ctx) => {
    const teamId = parseFigmaTeamUrl(request.url);
    if (!teamId) {
      throw new FigmaServiceError(
        "invalid_input",
        `Not a Figma team URL or team id: ${request.url}`,
      );
    }
    await requireConnection(ctx, request.connectionId);
    const response = await getBrowseJson<TeamProjectsResponse>(ctx, {
      connectionId: request.connectionId,
      path: `/v1/teams/${encodeURIComponent(teamId)}/projects`,
      tier: "2",
    });
    const name = optionalString(response?.name);
    if (!name) {
      throw new FigmaServiceError("figma_error", `Figma returned no team name for ${teamId}.`);
    }
    const team: FigmaTeam = { teamId, connectionId: request.connectionId, name };
    await ctx.store.saveTeam(team);
    return { team };
  },

  "figma.teams.remove.request": async (request, ctx) => {
    await ctx.store.removeTeam(request.connectionId, request.teamId);
    return {};
  },

  "figma.teams.list.request": async (request, ctx) => {
    return { teams: await ctx.store.listTeams(request.connectionId) };
  },

  "figma.teams.projects.request": async (request, ctx) => {
    const response = await getBrowseJson<TeamProjectsResponse>(ctx, {
      connectionId: request.connectionId,
      path: `/v1/teams/${encodeURIComponent(request.teamId)}/projects`,
      tier: "2",
    });
    const projects = Array.isArray(response?.projects) ? (response.projects as unknown[]) : [];
    const mapped: FigmaProject[] = [];
    for (const project of projects) {
      const record = project as Record<string, unknown>;
      const id = optionalString(record.key);
      const name = optionalString(record.name);
      if (id && name) mapped.push({ id, name });
    }
    return { projects: mapped };
  },

  "figma.teams.files.request": async (request, ctx) => {
    const response = await getBrowseJson<ProjectFilesResponse>(ctx, {
      connectionId: request.connectionId,
      path: `/v1/projects/${encodeURIComponent(request.projectId)}/files`,
      tier: "2",
    });
    const files = Array.isArray(response?.files) ? (response.files as unknown[]) : [];
    const mapped: FigmaProjectFile[] = [];
    for (const file of files) {
      const record = file as Record<string, unknown>;
      const fileKey = optionalString(record.key);
      const name = optionalString(record.name);
      if (!fileKey || !name) continue;
      mapped.push({ fileKey, name, lastModified_ms: isoToMs(record.last_modified) });
    }
    return { files: mapped };
  },

  "figma.budget.get.request": async (request, ctx) => {
    return { budget: ctx.rest.budget(request.connectionId) };
  },
};
