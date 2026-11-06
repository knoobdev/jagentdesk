import type {
  FigmaRemoteCallResult,
  FigmaRemoteStatus,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { FigmaServiceError } from "../context.js";
import type {
  FigmaContext,
  FigmaRemoteExecuteInput,
  FigmaRemoteExecuteOutcome,
  FigmaRemoteGateway,
} from "../context.js";
import { FigmaRemoteOutcomeUnknownError } from "../remote/connector.js";
import { figmaContent } from "./content.js";
import type { FigmaHandler, FigmaHandlerMap } from "./types.js";

// figma.remote.* RPC group (spec 32.9 / ADR-0040) on the protocol DTOs registered by W4.
// Nothing here stores tokens: every response carries MCP call results and observed status
// only. The connector's guard errors travel verbatim so the app can say "Connect editing".

export type FigmaRemoteRequestType =
  | "figma.remote.status.request"
  | "figma.remote.auth.begin.request"
  | "figma.remote.disconnect.request"
  | "figma.remote.read.request"
  | "figma.remote.execute.request";

function gatewayOrThrow(ctx: FigmaContext): FigmaRemoteGateway {
  if (!ctx.remote)
    throw new FigmaServiceError("unsupported", "The Figma remote write connector is not running.");
  return ctx.remote;
}

/** A FigmaServiceError passes through; connector Errors become readable figma_errors. */
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
function extractReadbackVersion(readback: FigmaRemoteCallResult | undefined): string | null {
  if (!readback) return null;
  const structured = readback.structuredContent;
  if (typeof structured === "object" && structured !== null) {
    const version = (structured as Record<string, unknown>).version;
    if (typeof version === "string" && version) return version;
  }
  for (const block of readback.content) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== "text" || typeof record.text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(record.text);
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
): Promise<FigmaRemoteCallResult> {
  const gateway = gatewayOrThrow(ctx);
  await requireTargetFile(ctx, fileKey);
  try {
    return await gateway.readMetadata(fileKey, nodeId);
  } catch (error) {
    throw toServiceError(error);
  }
}

/**
 * An outcome the connector could not vouch for after the call was DISPATCHED: timeout, helper
 * restart/disconnect mid-call, or a declined native approval. The class covers the real
 * connector; the message shapes keep faked gateways honest at this boundary.
 */
function isOutcomeUnknown(error: unknown): boolean {
  if (error instanceof FigmaRemoteOutcomeUnknownError) return true;
  const message = error instanceof Error ? error.message : "";
  return (
    message.includes("restarted during the write") ||
    message.includes("timed out") ||
    (message.includes("approval") && message.includes("unverified"))
  );
}

/**
 * Target validation + `use_figma` execute. On success the current version memo is dropped and
 * watchers are pushed (primed with the readback-confirmed version when available); ANY unknown
 * dispatched outcome — timeout, restart, declined elicitation — also drops the stale memo and
 * notifies refresh, because the side effect may have landed (ADR-0040, no auto-retry).
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
    if (isOutcomeUnknown(error)) {
      figmaContent.watches.remoteWriteApplied(ctx, input.fileKey, null);
    }
    throw toServiceError(error);
  }
}

const statusHandler: FigmaHandler<"figma.remote.status.request"> = async (_request, ctx) => ({
  status: await gatewayOrThrow(ctx).getStatus(),
});

const authBeginHandler: FigmaHandler<"figma.remote.auth.begin.request"> = async (_request, ctx) => {
  const gateway = gatewayOrThrow(ctx);
  try {
    return await gateway.authBegin();
  } catch (error) {
    throw toServiceError(error);
  }
};

const disconnectHandler: FigmaHandler<"figma.remote.disconnect.request"> = async (
  _request,
  ctx,
) => {
  const gateway = gatewayOrThrow(ctx);
  await gateway.disconnect();
  const status: FigmaRemoteStatus = { state: "disconnected" };
  return { status };
};

const readHandler: FigmaHandler<"figma.remote.read.request"> = async (request, ctx) => ({
  result: await readRemoteMetadata(ctx, request.fileKey, request.nodeId),
});

const executeHandler: FigmaHandler<"figma.remote.execute.request"> = async (request, ctx) => {
  if (!request.code) throw new FigmaServiceError("invalid_request", "code is required.");
  if (!request.description.trim())
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
};

export const remoteHandlers: FigmaHandlerMap<FigmaRemoteRequestType> = {
  "figma.remote.status.request": statusHandler,
  "figma.remote.auth.begin.request": authBeginHandler,
  "figma.remote.disconnect.request": disconnectHandler,
  "figma.remote.read.request": readHandler,
  "figma.remote.execute.request": executeHandler,
};
