import { FigmaServiceError } from "../context.js";
import type {
  FigmaContext,
  FigmaMcpCallResult,
  FigmaRemoteExecuteInput,
  FigmaRemoteExecuteOutcome,
  FigmaRemoteGateway,
} from "../context.js";
import { figmaContent } from "./content.js";
import type { FigmaSessionInfo } from "./types.js";

// figma.remote.* RPC group (spec 32.9 / ADR-0040). The RPC types are not in the protocol yet
// (W4 owns that registration), so this module defines the wire shapes locally and FigmaService
// widens its handler lookup with a cast. Nothing here stores tokens: every response carries MCP
// call results and observed status only.

export const FIGMA_REMOTE_REQUEST_TYPES = [
  "figma.remote.status.request",
  "figma.remote.auth.begin.request",
  "figma.remote.disconnect.request",
  "figma.remote.read.request",
  "figma.remote.execute.request",
] as const;
export type FigmaRemoteRequestType = (typeof FIGMA_REMOTE_REQUEST_TYPES)[number];

export interface FigmaRemoteStatusRequest {
  type: "figma.remote.status.request";
  requestId: string;
}
export interface FigmaRemoteAuthBeginRequest {
  type: "figma.remote.auth.begin.request";
  requestId: string;
}
export interface FigmaRemoteDisconnectRequest {
  type: "figma.remote.disconnect.request";
  requestId: string;
}
export interface FigmaRemoteReadRequest {
  type: "figma.remote.read.request";
  requestId: string;
  fileKey: string;
  nodeId?: string;
}
export interface FigmaRemoteExecuteRequest {
  type: "figma.remote.execute.request";
  requestId: string;
  fileKey: string;
  code: string;
  description: string;
}
export type FigmaRemoteRequest =
  | FigmaRemoteStatusRequest
  | FigmaRemoteAuthBeginRequest
  | FigmaRemoteDisconnectRequest
  | FigmaRemoteReadRequest
  | FigmaRemoteExecuteRequest;

export type FigmaRemoteHandler = (
  request: FigmaRemoteRequest,
  ctx: FigmaContext,
  session: FigmaSessionInfo,
) => Promise<Record<string, unknown>>;

export function isFigmaRemoteRequestType(type: string): type is FigmaRemoteRequestType {
  return (FIGMA_REMOTE_REQUEST_TYPES as readonly string[]).includes(type);
}

function gatewayOrThrow(ctx: FigmaContext): FigmaRemoteGateway {
  if (!ctx.remote)
    throw new FigmaServiceError("unsupported", "The Figma remote write connector is not running.");
  return ctx.remote;
}

/** The connector's clear message travels verbatim — the UI tells the user to Connect editing. */
function toServiceError(error: unknown): FigmaServiceError {
  if (error instanceof FigmaServiceError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new FigmaServiceError("figma_error", message);
}

async function requireTargetFile(ctx: FigmaContext, fileKey: string): Promise<void> {
  if (!fileKey) throw new FigmaServiceError("invalid_request", "fileKey is required.");
  const file = await ctx.store.getFile(fileKey);
  if (!file)
    throw new FigmaServiceError("not_found", `File ${fileKey} has not been added to JAgentDesk`);
}

/** Best-effort version extraction from a metadata readback (structuredContent or a JSON text block). */
function extractReadbackVersion(readback: FigmaMcpCallResult | undefined): string | null {
  if (!readback) return null;
  const structured = readback.structuredContent;
  if (typeof structured === "object" && structured !== null) {
    const version = (structured as Record<string, unknown>).version;
    if (typeof version === "string" && version) return version;
  }
  for (const block of readback.content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(block.text);
      if (typeof parsed === "object" && parsed !== null) {
        const version = (parsed as Record<string, unknown>).version;
        if (typeof version === "string" && version) return version;
      }
    } catch {
      // text is not JSON; keep looking
    }
  }
  return null;
}

/** Target validation + metadata read via the official server, shared with the agent tools. */
export async function readRemoteMetadata(
  ctx: FigmaContext,
  fileKey: string,
  nodeId?: string,
): Promise<FigmaMcpCallResult> {
  const gateway = gatewayOrThrow(ctx);
  await requireTargetFile(ctx, fileKey);
  try {
    return await gateway.readMetadata(fileKey, nodeId);
  } catch (error) {
    throw toServiceError(error);
  }
}

/**
 * Target validation + `use_figma` execute. On success the current version memo is dropped and
 * watchers are pushed (primed with the readback-confirmed version when available); a write whose
 * outcome was lost to a helper restart still drops the stale memo (ADR-0040, no auto-retry).
 */
export async function executeRemoteWrite(
  ctx: FigmaContext,
  input: FigmaRemoteExecuteInput,
): Promise<FigmaRemoteExecuteOutcome> {
  const gateway = gatewayOrThrow(ctx);
  await requireTargetFile(ctx, input.fileKey);
  try {
    const outcome = await gateway.execute(input);
    figmaContent.watches.remoteWriteApplied(
      ctx,
      input.fileKey,
      extractReadbackVersion(outcome.readback),
    );
    return outcome;
  } catch (error) {
    if (error instanceof FigmaServiceError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("restarted during the write")) {
      figmaContent.watches.remoteWriteApplied(ctx, input.fileKey, null);
    }
    throw toServiceError(error);
  }
}

export const REMOTE_HANDLERS: Record<FigmaRemoteRequestType, FigmaRemoteHandler> = {
  "figma.remote.status.request": async (request, ctx) => {
    const gateway = gatewayOrThrow(ctx);
    return { status: await gateway.getStatus() };
  },

  "figma.remote.auth.begin.request": async (request, ctx) => {
    const gateway = gatewayOrThrow(ctx);
    try {
      const begun = await gateway.authBegin();
      return { ...begun };
    } catch (error) {
      throw toServiceError(error);
    }
  },

  "figma.remote.disconnect.request": async (request, ctx) => {
    const gateway = gatewayOrThrow(ctx);
    await gateway.disconnect();
    return { status: { state: "disconnected" as const } };
  },

  "figma.remote.read.request": async (request, ctx) => {
    const result = await readRemoteMetadata(ctx, request.fileKey, request.nodeId);
    return { result };
  },

  "figma.remote.execute.request": async (request, ctx) => {
    if (typeof request.code !== "string" || !request.code)
      throw new FigmaServiceError("invalid_request", "code is required.");
    if (typeof request.description !== "string" || !request.description.trim())
      throw new FigmaServiceError("invalid_request", "description is required.");
    const outcome = await executeRemoteWrite(ctx, {
      fileKey: request.fileKey,
      code: request.code,
      description: request.description,
    });
    return {
      result: outcome.result,
      ...(outcome.readback ? { readback: outcome.readback } : {}),
      readbackAvailable: outcome.readbackAvailable,
    };
  },
};
