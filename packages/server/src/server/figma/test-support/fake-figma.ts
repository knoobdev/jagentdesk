import pino from "pino";
import type {
  FigmaBudget,
  FigmaConnection,
  FigmaFile,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { MemorySecretStore } from "../../database/secret-store.js";
import { FigmaServiceError, type FigmaContext } from "../context.js";
import type {
  FigmaCache,
  FigmaLinkBridge,
  FigmaRestClient,
  FigmaStore,
  FigmaTokenProvider,
} from "../context.js";

// Fakes for the comments/prototype handlers (W5 tests). The REST client and the Link bridge
// record every call so tests can assert paths, tiers, bodies and tool args; nothing here hits
// the network.

export interface RestCall {
  method: "GET" | "POST" | "PUT" | "DELETE";
  connectionId: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  tier: "1" | "2" | "3";
}

export interface ToolCall {
  fileKey: string;
  tool: string;
  args: Record<string, unknown>;
}

export function fakeFile(overrides: Partial<FigmaFile> = {}): FigmaFile {
  return {
    fileKey: "Kx7QmP2vTnYhW3cLdRf5Ba",
    connectionId: "fgc_test",
    name: "Checkout Redesign",
    pinned: false,
    linked: false,
    ...overrides,
  };
}

export function fakeConnection(overrides: Partial<FigmaConnection> = {}): FigmaConnection {
  return {
    id: "fgc_test",
    account: { figmaUserId: "450:900", handle: "me", email: "me@example.dev" },
    authState: "connected",
    createdAt_ms: 1775121600000,
    ...overrides,
  };
}

const notUsed = (what: string) => {
  return () => {
    throw new FigmaServiceError("unsupported", `${what} is not used by these handlers`);
  };
};

export function fakeStore(options: {
  files?: FigmaFile[];
  connections?: FigmaConnection[];
}): FigmaStore {
  const files = options.files ?? [];
  const connections = options.connections ?? [];
  return {
    listConnections: notUsed("store.listConnections"),
    getConnection: async (id) => connections.find((c) => c.id === id) ?? null,
    saveConnection: notUsed("store.saveConnection"),
    removeConnection: notUsed("store.removeConnection"),
    listFiles: notUsed("store.listFiles"),
    getFile: async (fileKey) => files.find((f) => f.fileKey === fileKey) ?? null,
    saveFile: notUsed("store.saveFile"),
    removeFile: notUsed("store.removeFile"),
    listTeams: notUsed("store.listTeams"),
    saveTeam: notUsed("store.saveTeam"),
    removeTeam: notUsed("store.removeTeam"),
  };
}

export function fakeRest(options: {
  getJson?: (call: RestCall) => unknown;
  sendJson?: (call: RestCall) => unknown;
}): { rest: FigmaRestClient; calls: RestCall[] } {
  const calls: RestCall[] = [];
  const rest: FigmaRestClient = {
    getJson: async <T>(input: {
      connectionId: string;
      path: string;
      query?: Record<string, string | number | boolean | undefined>;
      tier: "1" | "2" | "3";
    }): Promise<T> => {
      const call: RestCall = { method: "GET", ...input };
      calls.push(call);
      return (options.getJson?.(call) ?? null) as T;
    },
    sendJson: async <T>(input: {
      connectionId: string;
      method: "POST" | "PUT" | "DELETE";
      path: string;
      body?: unknown;
      tier: "1" | "2" | "3";
    }): Promise<T> => {
      const call: RestCall = { ...input };
      calls.push(call);
      return (options.sendJson?.(call) ?? null) as T;
    },
    getBytes: notUsed("rest.getBytes"),
    budget: (connectionId): FigmaBudget => ({
      connectionId,
      tiers: [],
      planTier: null,
      rateLimitType: null,
      upgradeUrl: null,
    }),
  };
  return { rest, calls };
}

export function fakeLink(options: {
  linked?: boolean;
  callTool?: (fileKey: string, tool: string, args: Record<string, unknown>) => unknown;
}): { link: FigmaLinkBridge; calls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const link: FigmaLinkBridge = {
    status: notUsed("link.status"),
    isLinked: () => options.linked ?? false,
    pair: notUsed("link.pair"),
    revoke: notUsed("link.revoke"),
    setRunScriptEnabled: notUsed("link.setRunScriptEnabled"),
    callTool: async (fileKey, tool, args) => {
      calls.push({ fileKey, tool, args });
      return options.callTool?.(fileKey, tool, args) ?? null;
    },
    applyOps: notUsed("link.applyOps"),
    getNodes: notUsed("link.getNodes"),
    exportNode: notUsed("link.exportNode"),
    onChange: notUsed("link.onChange"),
    close: notUsed("link.close"),
  };
  return { link, calls };
}

export function makeFigmaContext(parts: {
  store: FigmaStore;
  rest: FigmaRestClient;
  link: FigmaLinkBridge;
}): FigmaContext {
  const tokens: FigmaTokenProvider = {
    accessToken: notUsed("tokens.accessToken"),
    invalidate: () => undefined,
  };
  const cache: FigmaCache = {
    getJson: notUsed("cache.getJson"),
    putJson: notUsed("cache.putJson"),
    getBytes: notUsed("cache.getBytes"),
    putBytes: notUsed("cache.putBytes"),
  };
  return {
    jagentdeskHome: "/tmp/jad-fg-w5-test-home",
    logger: pino({ level: "silent" }),
    secrets: new MemorySecretStore(),
    store: parts.store,
    tokens,
    rest: parts.rest,
    cache,
    link: parts.link,
    push: () => undefined,
    now: () => 1775121600000,
  };
}
