import type pino from "pino";
import type {
  FigmaBudget,
  FigmaConnection,
  FigmaEditOp,
  FigmaError,
  FigmaFile,
  FigmaLinkStatus,
  FigmaNode,
  FigmaPush,
  FigmaRemoteCallResult,
  FigmaRemoteStatus,
  FigmaTeam,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { SecretStore } from "../database/secret-store.js";

// Shared contracts between the Figma daemon modules (spec 32, ADR-0035). Each module owns one
// concern and talks to the others only through these interfaces, so they can be built in parallel:
//
//   store.ts        FigmaStore          connections/files/teams JSON under $JAGENTDESK_HOME/figma
//   oauth.ts        FigmaTokenProvider  OAuth begin/complete/delegate, single-flight refresh
//   rest.ts         FigmaRestClient     api.figma.com with tier budgets, Retry-After, 429 headers
//   cache.ts        FigmaCache          node subtrees, image fills, fallback renders, fonts on disk
//   link/*.ts       FigmaLinkBridge     loopback 1995 server from figma-mcp-forge + pairing (32.4)
//   pending.ts      edit queue (32.6.1)
//   handlers/*.ts   one RPC group each, composed by service.ts
//
// Nothing here logs request bodies, tokens or secrets.

/** Thrown by handlers; the session turns it into `payload.error`. */
export class FigmaServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Omit<FigmaError, "code" | "message"> = {},
  ) {
    super(message);
    this.name = "FigmaServiceError";
  }

  toWire(): FigmaError {
    return { code: this.code, message: this.message, ...this.extra };
  }
}

export interface FigmaStore {
  listConnections(): Promise<FigmaConnection[]>;
  getConnection(id: string): Promise<FigmaConnection | null>;
  saveConnection(connection: FigmaConnection): Promise<void>;
  removeConnection(id: string): Promise<void>;
  listFiles(connectionId?: string): Promise<FigmaFile[]>;
  getFile(fileKey: string): Promise<FigmaFile | null>;
  saveFile(file: FigmaFile): Promise<void>;
  removeFile(fileKey: string): Promise<void>;
  listTeams(connectionId: string): Promise<FigmaTeam[]>;
  saveTeam(team: FigmaTeam): Promise<void>;
  removeTeam(connectionId: string, teamId: string): Promise<void>;
}

export interface FigmaTokenProvider {
  /** A valid access token for the connection, refreshing (single-flight) when needed. */
  accessToken(connectionId: string): Promise<string>;
  /** Called by the REST client after a 401 so the next call refreshes. */
  invalidate(connectionId: string): void;
}

/** Figma REST rate-limit tiers (figma-integration.md §4). */
export type FigmaTier = "1" | "2" | "3";

export interface FigmaRestClient {
  getJson<T = unknown>(input: {
    connectionId: string;
    path: string; // e.g. `/v1/files/${key}/nodes`
    query?: Record<string, string | number | boolean | undefined>;
    tier: FigmaTier;
  }): Promise<T>;
  sendJson<T = unknown>(input: {
    connectionId: string;
    method: "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    tier: FigmaTier;
  }): Promise<T>;
  /** Downloads bytes from a URL Figma returned (S3 render or image fill). Never exposed to clients. */
  getBytes(url: string): Promise<{ mimeType: string; data: Buffer }>;
  budget(connectionId: string): FigmaBudget;
}

export interface FigmaCache {
  getJson<T>(key: string): Promise<T | null>;
  putJson(key: string, value: unknown): Promise<void>;
  getBytes(key: string): Promise<{ mimeType: string; data: Buffer } | null>;
  putBytes(key: string, value: { mimeType: string; data: Buffer }): Promise<void>;
}

export interface FigmaLinkFileInfo {
  fileKey: string;
  fileName: string;
  pageName: string | null;
  paired: boolean;
}

export interface FigmaLinkBridge {
  status(): FigmaLinkStatus;
  isLinked(fileKey: string): boolean;
  pair(code: string): Promise<FigmaLinkStatus>;
  revoke(pairingId?: string): Promise<void>;
  setRunScriptEnabled(enabled: boolean): Promise<FigmaLinkStatus>;
  /** Calls one Forge tool (`get_node`, `set_text`, …) in the plugin for that file. */
  callTool(fileKey: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** Applies app edit ops (32.6) through the plugin; tempId → real id for created nodes. */
  applyOps(
    fileKey: string,
    ops: FigmaEditOp[],
  ): Promise<{ createdIds: Record<string, string>; results: { ok: boolean; message?: string }[] }>;
  /** The live subtree of nodes, serialized in REST node format. */
  getNodes(fileKey: string, ids: string[]): Promise<Record<string, FigmaNode | null>>;
  exportNode(
    fileKey: string,
    nodeId: string,
    format: "png" | "jpg" | "svg" | "pdf",
    scale: number,
  ): Promise<{ mimeType: string; data: Buffer }>;
  onChange(listener: (event: { fileKey: string | null; nodeIds?: string[] }) => void): () => void;
  close(): Promise<void>;
}

// ── remote write connector (spec 32.7 / ADR-0040) ──────────────────────────────
// Provider-independent Figma writes driven through the Codex app-server's native
// MCP transport. State is observed from actual native events only; the connector
// never opens OAuth on its own and never retries a write automatically. The wire
// DTOs (status, call results) are the protocol's — the daemon owns no shadow types.

export interface FigmaRemoteExecuteInput {
  fileKey: string;
  code: string;
  description: string;
}

export interface FigmaRemoteExecuteOutcome {
  result: FigmaRemoteCallResult;
  /** Metadata readback after a successful write; absent when the readback itself failed. */
  readback?: FigmaRemoteCallResult;
  /** True only when the post-write metadata readback succeeded — never claim Saved on false. */
  readbackAvailable: boolean;
}

export interface FigmaRemoteGateway {
  /** Snapshot of observed state. Never starts the process, never opens OAuth. */
  getStatus(): Promise<FigmaRemoteStatus>;
  /** Explicit enable + native OAuth start; returns the validated Figma HTTPS URL when present. */
  authBegin(): Promise<{ status: FigmaRemoteStatus; authorizationUrl?: string }>;
  /** Disable + dispose the owned process/pending OAuth only (no native logout). */
  disconnect(): Promise<void>;
  readMetadata(fileKey: string, nodeId?: string): Promise<FigmaRemoteCallResult>;
  execute(input: FigmaRemoteExecuteInput): Promise<FigmaRemoteExecuteOutcome>;
  dispose(): Promise<void>;
}

export interface FigmaContext {
  jagentdeskHome: string;
  logger: pino.Logger;
  secrets: SecretStore;
  store: FigmaStore;
  tokens: FigmaTokenProvider;
  rest: FigmaRestClient;
  cache: FigmaCache;
  link: FigmaLinkBridge;
  /** Lazy remote write connector (ADR-0040); owned by FigmaService, absent when not wired. */
  remote?: FigmaRemoteGateway;
  /** Broadcast a push to every session that subscribed (watches) or to all (link/pending). */
  push(event: FigmaPush): void;
  now(): number;
}
