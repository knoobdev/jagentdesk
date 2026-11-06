import type pino from "pino";
import type {
  FigmaBudget,
  FigmaConnection,
  FigmaEditOp,
  FigmaFile,
  FigmaLinkStatus,
  FigmaNode,
  FigmaPush,
  FigmaTeam,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { MemorySecretStore } from "../../database/secret-store.js";
import {
  FigmaServiceError,
  type FigmaCache,
  type FigmaContext,
  type FigmaLinkBridge,
  type FigmaRestClient,
  type FigmaStore,
} from "../context.js";
import { FigmaDiskCache } from "../cache.js";

// Fakes for the Figma content handlers' unit tests (no network, real disk cache in a temp dir).
// The Figma API surface these emulate is fixed by figma-integration.md §3.1/§3.2 and the daemon
// contracts in context.ts.

export interface RecordedCall {
  path: string;
  query: Record<string, string | number | boolean | undefined> | undefined;
  tier: string;
  connectionId: string;
}

export type RestResponder = (input: { query: Record<string, string> }) => unknown;

export class FakeFigmaRest implements FigmaRestClient {
  readonly calls: RecordedCall[] = [];
  readonly byteCalls: string[] = [];
  private readonly responders = new Map<string, unknown>();
  private readonly byteBlobs = new Map<string, { mimeType: string; data: Buffer }>();

  respond(path: string, value: RestResponder): void;
  respond(path: string, value: unknown): void;
  respond(path: string, value: unknown): void {
    this.responders.set(path, value);
  }

  provideBytes(url: string, value: { mimeType: string; data: Buffer }): void {
    this.byteBlobs.set(url, value);
  }

  callsTo(path: string): RecordedCall[] {
    return this.calls.filter((call) => call.path === path);
  }

  async getJson<T>(input: {
    connectionId: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    tier: "1" | "2" | "3";
  }): Promise<T> {
    this.calls.push({
      path: input.path,
      query: input.query,
      tier: input.tier,
      connectionId: input.connectionId,
    });
    const responder = this.responders.get(input.path);
    if (responder === undefined)
      throw new FigmaServiceError("not_found", `fake Figma API has no handler for ${input.path}`);
    const query: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.query ?? {}))
      if (value !== undefined) query[key] = String(value);
    const value =
      typeof responder === "function" ? (responder as RestResponder)({ query }) : responder;
    return structuredClone(value) as T;
  }

  async sendJson<T>(): Promise<T> {
    throw new FigmaServiceError("unsupported", "fake Figma API does not write");
  }

  async getBytes(url: string): Promise<{ mimeType: string; data: Buffer }> {
    this.byteCalls.push(url);
    const blob = this.byteBlobs.get(url);
    if (!blob) throw new FigmaServiceError("not_found", `fake Figma API cannot fetch ${url}`);
    return { mimeType: blob.mimeType, data: blob.data };
  }

  budget(): FigmaBudget {
    return {
      connectionId: "fgc_fake",
      tiers: [],
      planTier: null,
      rateLimitType: null,
      upgradeUrl: null,
    };
  }
}

export class FakeFigmaLink implements FigmaLinkBridge {
  readonly linked = new Set<string>();
  readonly toolCalls: Array<{ fileKey: string; tool: string; args: Record<string, unknown> }> = [];
  getNodesImpl: ((ids: string[]) => Record<string, FigmaNode | null>) | null = null;
  exportImpl:
    | ((
        nodeId: string,
        format: "png" | "jpg" | "svg" | "pdf",
        scale: number,
      ) => { mimeType: string; data: Buffer })
    | null = null;
  exportFailures = new Set<string>();
  private readonly listeners = new Set<
    (event: { fileKey: string | null; nodeIds?: string[] }) => void
  >();
  private changeSubscriptions = 0;

  get activeChangeSubscriptions(): number {
    return this.changeSubscriptions;
  }

  /** The plugin reports a change in a file it has open. */
  emitChange(event: { fileKey: string | null; nodeIds?: string[] }): void {
    for (const listener of this.listeners) listener(event);
  }

  isLinked(fileKey: string): boolean {
    return this.linked.has(fileKey);
  }

  status(): FigmaLinkStatus {
    return {
      server: "listening",
      port: 1995,
      pluginInstalled: true,
      pluginVersion: "1.0.0",
      manifestPath: null,
      runScriptEnabled: false,
      files: [...this.linked].map((fileKey) => ({
        fileKey,
        fileName: `linked ${fileKey}`,
        pageName: null,
        paired: true,
        pluginVersion: "1.0.0",
        connectedAt_ms: 0,
      })),
      pendingPairing: null,
    };
  }

  async callTool(fileKey: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    this.toolCalls.push({ fileKey, tool, args });
    return null;
  }

  async applyOps(
    fileKey: string,
    ops: FigmaEditOp[],
  ): Promise<{ createdIds: Record<string, string>; results: { ok: boolean; message?: string }[] }> {
    this.toolCalls.push({ fileKey, tool: "applyOps", args: { count: ops.length } });
    return { createdIds: {}, results: ops.map(() => ({ ok: true })) };
  }

  async getNodes(fileKey: string, ids: string[]): Promise<Record<string, FigmaNode | null>> {
    this.toolCalls.push({ fileKey, tool: "getNodes", args: { ids } });
    if (!this.getNodesImpl)
      throw new FigmaServiceError("unsupported", "fake link getNodes is not wired");
    return this.getNodesImpl(ids);
  }

  async exportNode(
    fileKey: string,
    nodeId: string,
    format: "png" | "jpg" | "svg" | "pdf",
    scale: number,
  ): Promise<{ mimeType: string; data: Buffer }> {
    this.toolCalls.push({ fileKey, tool: "exportNode", args: { nodeId, format, scale } });
    if (!this.exportImpl)
      throw new FigmaServiceError("unsupported", "fake link exportNode is not wired");
    if (this.exportFailures.has(nodeId))
      throw new FigmaServiceError("figma_error", "export failed");
    return this.exportImpl(nodeId, format, scale);
  }

  onChange(listener: (event: { fileKey: string | null; nodeIds?: string[] }) => void): () => void {
    this.listeners.add(listener);
    this.changeSubscriptions += 1;
    return () => {
      this.listeners.delete(listener);
      this.changeSubscriptions -= 1;
    };
  }

  async pair(): Promise<FigmaLinkStatus> {
    return this.status();
  }
  async revoke(): Promise<void> {
    // fake: no persistent pairing
  }
  async setRunScriptEnabled(): Promise<FigmaLinkStatus> {
    return this.status();
  }
  async close(): Promise<void> {
    // fake: nothing to close
  }
}

export class FakeFigmaStore implements FigmaStore {
  private readonly files = new Map<string, FigmaFile>();
  private readonly connections = new Map<string, FigmaConnection>();

  addConnection(connection: FigmaConnection): void {
    this.connections.set(connection.id, connection);
  }

  addFile(file: FigmaFile): void {
    this.files.set(file.fileKey, file);
  }

  async listConnections(): Promise<FigmaConnection[]> {
    return [...this.connections.values()];
  }
  async getConnection(id: string): Promise<FigmaConnection | null> {
    return this.connections.get(id) ?? null;
  }
  async saveConnection(): Promise<void> {
    // fake: no persistence needed
  }
  async removeConnection(): Promise<void> {
    // fake: no persistence needed
  }
  async listFiles(): Promise<FigmaFile[]> {
    return [...this.files.values()];
  }
  async getFile(fileKey: string): Promise<FigmaFile | null> {
    return this.files.get(fileKey) ?? null;
  }
  async saveFile(file: FigmaFile): Promise<void> {
    this.files.set(file.fileKey, file);
  }
  async removeFile(fileKey: string): Promise<void> {
    this.files.delete(fileKey);
  }
  async listTeams(): Promise<FigmaTeam[]> {
    return [];
  }
  async saveTeam(): Promise<void> {
    // fake: no persistence needed
  }
  async removeTeam(): Promise<void> {
    // fake: no persistence needed
  }
}

export interface FakeFigmaApi {
  ctx: FigmaContext;
  rest: FakeFigmaRest;
  link: FakeFigmaLink;
  store: FakeFigmaStore;
  cache: FigmaCache;
  pushes: FigmaPush[];
  /** Mutable clock so tests control cache TTLs and watch intervals. */
  now: () => number;
  setNow(ms: number): void;
  dispose(): void;
}

const fakeConnection: FigmaConnection = {
  id: "fgc_fake",
  account: { figmaUserId: "1", handle: "tester", email: null },
  authState: "connected",
  createdAt_ms: 0,
};

export function makeFile(fileKey: string): FigmaFile {
  return {
    fileKey,
    connectionId: "fgc_fake",
    name: `File ${fileKey}`,
    pinned: false,
    linked: false,
  };
}

/** A real disk cache under a temp home; everything else is a programmable fake. */
export function makeFigmaApi(options: {
  home: string;
  logger: pino.Logger;
  maxCacheBytes?: number;
}): FakeFigmaApi {
  let now = 1_762_000_000_000; // 2026-03-01T00:00:00Z-ish, fixed for deterministic TTL checks.
  const rest = new FakeFigmaRest();
  const link = new FakeFigmaLink();
  const store = new FakeFigmaStore();
  store.addConnection(fakeConnection);
  const cache = new FigmaDiskCache(`${options.home}/figma/cache`, {
    maxBytes: options.maxCacheBytes,
    now: () => now,
  });
  const pushes: FigmaPush[] = [];
  const ctx: FigmaContext = {
    jagentdeskHome: options.home,
    logger: options.logger,
    secrets: new MemorySecretStore(),
    store,
    tokens: {
      accessToken: async () => "token",
      invalidate: () => undefined,
    },
    rest,
    cache,
    link,
    push: (event) => pushes.push(event),
    now: () => now,
  };
  return {
    ctx,
    rest,
    link,
    store,
    cache,
    pushes,
    now: () => now,
    setNow: (ms) => {
      now = ms;
    },
    dispose: () => undefined,
  };
}
