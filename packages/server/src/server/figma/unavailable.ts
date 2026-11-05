import type { FigmaBudget, FigmaLinkStatus } from "@jagentdesk/protocol/figma/rpc-schemas";
import type {
  FigmaCache,
  FigmaLinkBridge,
  FigmaRestClient,
  FigmaStore,
  FigmaTokenProvider,
} from "./context.js";
import { FigmaServiceError } from "./context.js";

// Placeholders for parts that are not built yet, so the daemon composes and starts while the
// modules are developed in parallel. Each work package replaces one of these in bootstrap.ts
// (`createFigmaService`) with its real implementation. They never fake data: reads are empty and
// actions fail with `unsupported`.

const unsupported = (what: string): never => {
  throw new FigmaServiceError("unsupported", `${what} is not available yet`);
};

export const unavailableStore: FigmaStore = {
  listConnections: async () => [],
  getConnection: async () => null,
  saveConnection: async () => unsupported("Figma storage"),
  removeConnection: async () => unsupported("Figma storage"),
  listFiles: async () => [],
  getFile: async () => null,
  saveFile: async () => unsupported("Figma storage"),
  removeFile: async () => unsupported("Figma storage"),
  listTeams: async () => [],
  saveTeam: async () => unsupported("Figma storage"),
  removeTeam: async () => unsupported("Figma storage"),
};

export const unavailableTokens: FigmaTokenProvider = {
  accessToken: async () => unsupported("Figma sign-in"),
  invalidate: () => undefined,
};

export const unavailableRest: FigmaRestClient = {
  getJson: async () => unsupported("Figma REST client"),
  sendJson: async () => unsupported("Figma REST client"),
  getBytes: async () => unsupported("Figma REST client"),
  budget: (connectionId): FigmaBudget => ({
    connectionId,
    tiers: [],
    planTier: null,
    rateLimitType: null,
    upgradeUrl: null,
  }),
};

export const unavailableCache: FigmaCache = {
  getJson: async () => null,
  putJson: async () => undefined,
  getBytes: async () => null,
  putBytes: async () => undefined,
};

const stoppedStatus: FigmaLinkStatus = {
  server: "stopped",
  port: 1995,
  pluginInstalled: false,
  pluginVersion: null,
  manifestPath: null,
  runScriptEnabled: false,
  files: [],
  pendingPairing: null,
};

export const unavailableLink: FigmaLinkBridge = {
  status: () => stoppedStatus,
  isLinked: () => false,
  pair: async () => unsupported("Figma Link"),
  revoke: async () => unsupported("Figma Link"),
  setRunScriptEnabled: async () => unsupported("Figma Link"),
  callTool: async () => unsupported("Figma Link"),
  applyOps: async () => unsupported("Figma Link"),
  getNodes: async () => unsupported("Figma Link"),
  exportNode: async () => unsupported("Figma Link"),
  onChange: () => () => undefined,
  close: async () => undefined,
};
