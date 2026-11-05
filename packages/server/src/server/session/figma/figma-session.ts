import { randomUUID } from "node:crypto";
import type pino from "pino";
import type { z } from "zod";
import {
  FIGMA_REQUEST_TYPES,
  FigmaResponseSchemas,
  type FigmaError,
  type FigmaRequest,
  type FigmaResponse,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { FigmaServiceError } from "../../figma/context.js";
import type { FigmaService } from "../../figma/service.js";

// The figma.* RPC surface of one client session (spec 32.9). Every request gets exactly one
// response — an error response on failure, never a throw into the socket loop. Request bodies are
// never logged (oauth.* carries the client secret). The allowlist is FIGMA_REQUEST_TYPES, the same
// list the service's handler map is checked against, so a type cannot be listed without a handler.

const RESPONSE_SCHEMAS = new Map(
  FigmaResponseSchemas.map((schema) => [schema.shape.type.value as string, schema]),
);

const REQUEST_TYPES = new Set<string>(FIGMA_REQUEST_TYPES);

export function isFigmaRequest(msg: SessionInboundMessage): msg is FigmaRequest {
  return REQUEST_TYPES.has(msg.type);
}

function toWireError(error: unknown): FigmaError {
  if (error instanceof FigmaServiceError) return error.toWire();
  return { code: "figma_error", message: error instanceof Error ? error.message : String(error) };
}

// Empty value for a schema, used to fill an error response's required data fields.
function emptyFor(schema: z.ZodType): unknown {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  switch (def.type) {
    case "array":
      return [];
    case "record":
      return {};
    case "nullable":
    case "optional":
      return null;
    case "default":
      return emptyFor(def.innerType as z.ZodType);
    case "string":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "enum":
      return Object.values(def.entries as Record<string, string>)[0] ?? null;
    case "literal":
      return (def.values as unknown[])[0] ?? null;
    case "object": {
      const shape = (schema as unknown as { shape: Record<string, z.ZodType> }).shape;
      return Object.fromEntries(
        Object.entries(shape).map(([key, value]) => [key, emptyFor(value)]),
      );
    }
    default:
      return null;
  }
}

function emptyData(responseType: string): Record<string, unknown> {
  const schema = RESPONSE_SCHEMAS.get(responseType);
  if (!schema) return {};
  const payloadShape = (schema.shape.payload as unknown as { shape: Record<string, z.ZodType> })
    .shape;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payloadShape)) {
    if (key === "requestId" || key === "error") continue;
    out[key] = emptyFor(value);
  }
  return out;
}

function buildResponse(type: string, payload: Record<string, unknown>): FigmaResponse {
  const schema = RESPONSE_SCHEMAS.get(type);
  if (!schema) throw new Error(`No Figma response schema for ${type}`);
  return schema.parse({ type, payload }) as FigmaResponse;
}

export class FigmaSession {
  private readonly sessionKey = `figma-session-${randomUUID()}`;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly options: {
      service: FigmaService;
      emit: (msg: SessionOutboundMessage) => void;
      logger: pino.Logger;
      /** True for the Electron desktop client (OAuth loopback callback, 32.2). */
      canRunLoopback: () => boolean;
    },
  ) {
    this.unsubscribe = options.service.onPush((event) =>
      options.emit(event as unknown as SessionOutboundMessage),
    );
  }

  dispose(): void {
    this.unsubscribe();
  }

  async handle(msg: FigmaRequest): Promise<void> {
    const responseType = msg.type.replace(/\.request$/, ".response");
    let data: Record<string, unknown> = emptyData(responseType);
    let error: FigmaError | null = null;
    try {
      data = (await this.options.service.handle(msg, {
        sessionKey: this.sessionKey,
        canRunLoopback: this.options.canRunLoopback(),
      })) as Record<string, unknown>;
    } catch (caught) {
      error = toWireError(caught);
      this.options.logger.info({ type: msg.type, code: error.code }, "figma rpc failed");
    }
    let response: FigmaResponse;
    try {
      response = buildResponse(responseType, { requestId: msg.requestId, error, ...data });
    } catch (invalid) {
      this.options.logger.error({ type: msg.type, err: String(invalid) }, "figma response invalid");
      response = buildResponse(responseType, {
        requestId: msg.requestId,
        error: { code: "figma_error", message: "Figma returned data JAgentDesk could not read." },
        ...emptyData(responseType),
      });
    }
    this.options.emit(response as unknown as SessionOutboundMessage);
  }
}
