import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  InitializeRequestSchema,
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import type { Request } from "express";
import { LRUCache } from "lru-cache";
import type { Logger } from "pino";

interface AgentMcpProtocolSession {
  protocolVersion: string;
  loggedUnsupportedVersion: boolean;
}

interface AgentMcpProtocolRequest {
  request: Request;
  transport: StreamableHTTPServerTransport;
  callerAgentId?: string;
}

export function createAgentMcpProtocolNormalizer(logger: Logger) {
  // Stateless clients can disappear without a DELETE. Retain bounded negotiation
  // metadata without pinning live servers or transports.
  const protocolSessions = new LRUCache<string, AgentMcpProtocolSession>({ max: 1024 });

  return function normalizeAgentMcpProtocol({
    request,
    transport,
    callerAgentId,
  }: AgentMcpProtocolRequest): void {
    const sessionId = request.header("mcp-session-id");
    let protocolSessionKey: string | undefined;
    if (sessionId) {
      protocolSessionKey = `session:${sessionId}`;
    } else if (callerAgentId) {
      // Injected agents use stateless MCP and identify themselves in the URL.
      protocolSessionKey = `agent:${callerAgentId}`;
    }
    // Unidentified stateless callers share log suppression, never negotiation.
    const cacheKey = protocolSessionKey ?? "anonymous";
    const protocolSession = protocolSessions.get(cacheKey) ?? {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      loggedUnsupportedVersion: false,
    };
    const originalProtocolVersion = request.header("mcp-protocol-version");
    // COMPAT(openCodeMcpVersion): added in v0.9.59; remove after 2027-05-23 once OpenCode sends the negotiated version.
    if (
      originalProtocolVersion !== undefined &&
      !SUPPORTED_PROTOCOL_VERSIONS.includes(originalProtocolVersion)
    ) {
      request.headers["mcp-protocol-version"] = protocolSession.protocolVersion;
      // The SDK's Hono adapter reads rawHeaders rather than Node's headers map.
      for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
        if (request.rawHeaders[index]?.toLowerCase() === "mcp-protocol-version") {
          request.rawHeaders.splice(index, 2);
        }
      }
      request.rawHeaders.push("mcp-protocol-version", protocolSession.protocolVersion);
      if (!protocolSession.loggedUnsupportedVersion) {
        logger.info(
          {
            sessionId,
            callerAgentId,
            originalProtocolVersion,
            protocolVersion: protocolSession.protocolVersion,
          },
          "Normalizing unsupported Agent MCP protocol version header",
        );
        protocolSession.loggedUnsupportedVersion = true;
      }
      protocolSessions.set(cacheKey, protocolSession);
    }
    const initialize = InitializeRequestSchema.safeParse(request.body);
    if (initialize.success && protocolSessionKey) {
      const send = transport.send.bind(transport);
      transport.send = async (message, options) => {
        const result = InitializeResultSchema.safeParse(
          "result" in message ? message.result : undefined,
        );
        if (result.success) {
          protocolSession.protocolVersion = result.data.protocolVersion;
          protocolSessions.set(protocolSessionKey, protocolSession);
        }
        await send(message, options);
      };
    }
  };
}
