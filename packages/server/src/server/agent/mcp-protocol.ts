import {
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";
import type { Request } from "express";
import { LRUCache } from "lru-cache";
import type { Logger } from "pino";

interface AgentMcpProtocolSession {
  protocolVersion: string;
  loggedUnsupportedVersion: boolean;
}

interface AgentMcpProtocolRequest {
  request: Request;
  callerAgentId?: string;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRequestParams(body: unknown): Record<string, unknown> | undefined {
  return readObject(readObject(body)?.params);
}

// A 2026-07-28 request repeats its protocol version in the per-request `_meta`
// envelope. Only requests without that envelope are 2025-era requests that
// carry a header the legacy path cannot serve.
function carriesModernEnvelope(body: unknown): boolean {
  return readObject(readRequestParams(body)?._meta)?.[PROTOCOL_VERSION_META_KEY] !== undefined;
}

// The legacy handshake answers with the requested version when it supports it
// and with its latest version otherwise.
function negotiatedLegacyVersion(body: unknown): string | undefined {
  if (readObject(body)?.method !== "initialize") return undefined;
  const requested = readRequestParams(body)?.protocolVersion;
  if (typeof requested !== "string") return undefined;
  return SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
}

export function createAgentMcpProtocolNormalizer(logger: Logger) {
  // Stateless clients can disappear without a DELETE. Retain bounded negotiation
  // metadata without pinning live servers or handlers.
  const protocolSessions = new LRUCache<string, AgentMcpProtocolSession>({ max: 1024 });

  return function normalizeAgentMcpProtocol({
    request,
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
      !SUPPORTED_PROTOCOL_VERSIONS.includes(originalProtocolVersion) &&
      !carriesModernEnvelope(request.body)
    ) {
      request.headers["mcp-protocol-version"] = protocolSession.protocolVersion;
      // The SDK's Node adapter reads rawHeaders rather than Node's headers map.
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
    const negotiated = negotiatedLegacyVersion(request.body);
    if (negotiated !== undefined && protocolSessionKey) {
      protocolSession.protocolVersion = negotiated;
      protocolSessions.set(protocolSessionKey, protocolSession);
    }
  };
}
