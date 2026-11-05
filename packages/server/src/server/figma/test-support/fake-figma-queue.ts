import type pino from "pino";
import {
  type FigmaBudget,
  type FigmaConnection,
  type FigmaEditOp,
  type FigmaFile,
  type FigmaLinkStatus,
  type FigmaNode,
  type FigmaPush,
  type FigmaTeam,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { MemorySecretStore } from "../../database/secret-store.js";
import type {
  FigmaCache,
  FigmaContext,
  FigmaLinkBridge,
  FigmaRestClient,
  FigmaStore,
  FigmaTokenProvider,
} from "../context.js";
import { FigmaServiceError } from "../context.js";

// Fakes for the Figma daemon modules (spec 32) — no network, no real Figma. REST routes are
// registered per path, the Link bridge is driven programmatically, and every push is collected.

export interface RestCall {
  connectionId: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  tier: string;
  method?: string;
}

export class FakeFigmaRest implements FigmaRestClient {
  readonly calls: RestCall[] = [];
  private readonly getRoutes = new Map<string, (query: Record<string, unknown>) => unknown>();
  private readonly sendRoutes = new Map<string, (body: unknown) => unknown>();
  bytes: Record<string, { mimeType: string; data: Buffer }> = {};
  budgetValue: FigmaBudget = {
    connectionId: "fgc_fake",
    tiers: [],
    planTier: "professional",
    rateLimitType: null,
    upgradeUrl: null,
  };

  reply(path: string, value: unknown | ((query: Record<string, unknown>) => unknown)): void {
    this.getRoutes.set(
      path,
      typeof value === "function"
        ? (value as (q: Record<string, unknown>) => unknown)
        : () => value,
    );
  }

  replySend(path: string, value: unknown | ((body: unknown) => unknown)): void {
    this.sendRoutes.set(
      path,
      typeof value === "function" ? (value as (b: unknown) => unknown) : () => value,
    );
  }

  async getJson<T>(input: {
    connectionId: string;
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    tier: "1" | "2" | "3";
  }): Promise<T> {
    this.calls.push({ ...input, query: input.query });
    const route = this.getRoutes.get(input.path);
    if (!route) {
      throw new FigmaServiceError("not_found", `fake REST: no GET route for ${input.path}`);
    }
    return route(input.query ?? {}) as T;
  }

  async sendJson<T>(input: {
    connectionId: string;
    method: "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    tier: "1" | "2" | "3";
  }): Promise<T> {
    this.calls.push({ ...input });
    const route = this.sendRoutes.get(input.path);
    if (!route) {
      throw new FigmaServiceError(
        "not_found",
        `fake REST: no ${input.method} route for ${input.path}`,
      );
    }
    return route(input.body) as T;
  }

  async getBytes(url: string): Promise<{ mimeType: string; data: Buffer }> {
    const found = this.bytes[url];
    if (!found) throw new FigmaServiceError("not_found", `fake REST: no bytes for ${url}`);
    return found;
  }

  budget(): FigmaBudget {
    return this.budgetValue;
  }
}

export interface AppliedBatch {
  fileKey: string;
  ops: FigmaEditOp[];
}

export class FakeFigmaLink implements FigmaLinkBridge {
  linked = new Set<string>();
  /** Live node values, per file then node id, used by getNodes (conflict checks + previous reads). */
  readonly nodes = new Map<string, Map<string, FigmaNode>>();
  readonly toolCalls: { fileKey: string; tool: string; args: Record<string, unknown> }[] = [];
  readonly applied: AppliedBatch[] = [];
  /** Per-op outcomes for the next applyOps; defaults to ok. */
  failOps: Record<string, string> = {};
  /** tempId → real id produced by applyOps for create ops. */
  createdIdsFor: Record<string, string> = {};
  runScriptEnabled = false;
  callToolResult: unknown = { ok: true };

  setLinked(fileKey: string, linked = true): void {
    if (linked) this.linked.add(fileKey);
    else this.linked.delete(fileKey);
  }

  setNode(fileKey: string, node: FigmaNode): void {
    if (!this.nodes.has(fileKey)) this.nodes.set(fileKey, new Map());
    this.nodes.get(fileKey)!.set(node.id, node);
  }

  status(): FigmaLinkStatus {
    return {
      server: "listening",
      port: 1995,
      pluginInstalled: true,
      pluginVersion: "0.1.0",
      manifestPath: null,
      runScriptEnabled: this.runScriptEnabled,
      files: [...this.linked].map((fileKey) => ({
        fileKey,
        fileName: `file-${fileKey}`,
        pageName: null,
        paired: true,
        pluginVersion: "0.1.0",
        connectedAt_ms: 0,
      })),
      pendingPairing: null,
    };
  }

  isLinked(fileKey: string): boolean {
    return this.linked.has(fileKey);
  }

  async pair(): Promise<FigmaLinkStatus> {
    return this.status();
  }
  async revoke(): Promise<void> {}
  async setRunScriptEnabled(enabled: boolean): Promise<FigmaLinkStatus> {
    this.runScriptEnabled = enabled;
    return this.status();
  }

  async callTool(fileKey: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.isLinked(fileKey)) {
      throw new FigmaServiceError("link_unavailable", `fake link: ${fileKey} not connected`);
    }
    this.toolCalls.push({ fileKey, tool, args });
    return this.callToolResult;
  }

  async applyOps(
    fileKey: string,
    ops: FigmaEditOp[],
  ): Promise<{ createdIds: Record<string, string>; results: { ok: boolean; message?: string }[] }> {
    this.applied.push({ fileKey, ops });
    const createdIds: Record<string, string> = {};
    const results = ops.map((op) => {
      const key = opKey(op);
      if (this.failOps[key] !== undefined) {
        return { ok: false, message: this.failOps[key] };
      }
      if (op.op === "create_node") createdIds[op.tempId] = `99:${createdIdsCount(ops, op.tempId)}`;
      return { ok: true };
    });
    return { createdIds: { ...this.createdIdsFor, ...createdIds }, results };
  }

  async getNodes(fileKey: string, ids: string[]): Promise<Record<string, FigmaNode | null>> {
    const fileNodes = this.nodes.get(fileKey);
    const out: Record<string, FigmaNode | null> = {};
    for (const id of ids) out[id] = fileNodes?.get(id) ?? null;
    return out;
  }

  async exportNode(): Promise<{ mimeType: string; data: Buffer }> {
    return { mimeType: "image/png", data: Buffer.from("png") };
  }

  onChange(): () => void {
    return () => undefined;
  }

  async close(): Promise<void> {}
}

function opKey(op: FigmaEditOp): string {
  let nodeId = "*";
  if ("nodeId" in op) nodeId = op.nodeId;
  else if ("parentId" in op) nodeId = op.parentId;
  return `${op.op}:${nodeId}`;
}

function createdIdsCount(ops: FigmaEditOp[], tempId: string): number {
  return ops.findIndex((op) => op.op === "create_node" && op.tempId === tempId) + 1;
}

export class FakeFigmaStore implements FigmaStore {
  readonly connections = new Map<string, FigmaConnection>();
  readonly files = new Map<string, FigmaFile>();
  readonly teams = new Map<string, FigmaTeam>();

  async listConnections(): Promise<FigmaConnection[]> {
    return [...this.connections.values()];
  }
  async getConnection(id: string): Promise<FigmaConnection | null> {
    return this.connections.get(id) ?? null;
  }
  async saveConnection(connection: FigmaConnection): Promise<void> {
    this.connections.set(connection.id, connection);
  }
  async removeConnection(id: string): Promise<void> {
    this.connections.delete(id);
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
    return [...this.teams.values()];
  }
  async saveTeam(team: FigmaTeam): Promise<void> {
    this.teams.set(`${team.connectionId}/${team.teamId}`, team);
  }
  async removeTeam(connectionId: string, teamId: string): Promise<void> {
    this.teams.delete(`${connectionId}/${teamId}`);
  }
}

export class FakeFigmaCache implements FigmaCache {
  readonly json = new Map<string, unknown>();
  readonly bytes = new Map<string, { mimeType: string; data: Buffer }>();
  async getJson<T>(key: string): Promise<T | null> {
    return (this.json.get(key) as T) ?? null;
  }
  async putJson(key: string, value: unknown): Promise<void> {
    this.json.set(key, value);
  }
  async getBytes(key: string): Promise<{ mimeType: string; data: Buffer } | null> {
    return this.bytes.get(key) ?? null;
  }
  async putBytes(key: string, value: { mimeType: string; data: Buffer }): Promise<void> {
    this.bytes.set(key, value);
  }
}

/** A complete FigmaContext over fakes, writing queues under `jagentdeskHome`. */
export function fakeFigmaContext(options: {
  jagentdeskHome: string;
  logger: pino.Logger;
  store?: FakeFigmaStore;
  rest?: FakeFigmaRest;
  link?: FakeFigmaLink;
  cache?: FakeFigmaCache;
  now?: () => number;
}): { ctx: FigmaContext; pushes: FigmaPush[] } {
  const pushes: FigmaPush[] = [];
  const store = options.store ?? new FakeFigmaStore();
  const rest = options.rest ?? new FakeFigmaRest();
  const link = options.link ?? new FakeFigmaLink();
  const cache = options.cache ?? new FakeFigmaCache();
  const tokens: FigmaTokenProvider = {
    accessToken: async () => "tok",
    invalidate: () => undefined,
  };
  const ctx: FigmaContext = {
    jagentdeskHome: options.jagentdeskHome,
    logger: options.logger,
    secrets: new MemorySecretStore(),
    store,
    tokens,
    rest,
    cache,
    link,
    push: (event) => pushes.push(event),
    now: options.now ?? (() => 1_700_000_000_000),
  };
  return { ctx, pushes };
}

export function fakeFile(overrides: Partial<FigmaFile> & { fileKey: string }): FigmaFile {
  return {
    connectionId: "fgc_fake",
    name: `File ${overrides.fileKey}`,
    pinned: false,
    linked: false,
    ...overrides,
  };
}
