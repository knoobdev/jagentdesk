import type {
  AgentSnapshotPayload,
  CreateAgentRequestMessage,
  FetchWorkspacesRequestMessage,
  FetchWorkspacesResponseMessage,
  GetProvidersSnapshotResponseMessage,
  ListAvailableProvidersResponse,
  ListProviderFeaturesRequestMessage,
  ListProviderFeaturesResponseMessage,
  ListProviderModelsResponseMessage,
  ListProviderModesResponseMessage,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
  ProviderDiagnosticResponseMessage,
  ProjectPlacementPayload,
  RefreshProvidersSnapshotResponseMessage,
  SendAgentMessageRequest,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
} from "@jagentdesk/protocol/messages";
import { DaemonClient } from "./daemon-client.js";
import type {
  FetchAgentTimelineCursor,
  FetchAgentTimelineDirection,
  FetchAgentTimelinePayload,
  FetchAgentTimelineProjection,
} from "./daemon-client.js";

export { DaemonClient };
export type {
  DaemonClientConfig,
  DaemonEvent,
  BrowserAutomationExecuteRequestMessage,
  BrowserAutomationExecuteResponseMessage,
  WebSocketFactory,
  WebSocketLike,
  DeviceSigningConfig,
  PairingRegistrationConfig,
} from "./daemon-client.js";

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "disconnected"; reason?: string }
  | { status: "disposed" };

export interface JAgentDeskLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface JAgentDeskClientConfig {
  url: string;
  clientId?: string;
  appVersion?: string;
  runtimeGeneration?: number | null;
  password?: string;
  authHeader?: string;
  suppressSendErrors?: boolean;
  logger?: JAgentDeskLogger;
  connectTimeoutMs?: number;
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  runtimeMetricsIntervalMs?: number;
  runtimeMetricsWindowMs?: number;
}

export type JAgentDeskWorkspace = WorkspaceDescriptorPayload;
export type JAgentDeskAgent = AgentSnapshotPayload;
export type JAgentDeskWorkspaceListOptions = Omit<
  FetchWorkspacesRequestMessage,
  "type" | "requestId"
> & {
  requestId?: string;
};

export interface JAgentDeskWorkspaceListResult {
  requestId: string;
  subscriptionId?: string | null;
  entries: JAgentDeskWorkspace[];
  pageInfo: FetchWorkspacesResponseMessage["payload"]["pageInfo"];
}

export interface JAgentDeskWorkspaceOpenOptions {
  cwd: string;
  requestId?: string;
}

export interface JAgentDeskWorkspaceOpenResult {
  requestId: string;
  workspace: JAgentDeskWorkspaceHandle | null;
  error: string | null;
}

export interface JAgentDeskWorkspaceArchiveResult {
  requestId: string;
  workspaceId: string;
  archivedAt: string | null;
  error: string | null;
}

export type JAgentDeskWorkspaceUpdate = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];

export type JAgentDeskWorkspaceUpdateHandler = (update: JAgentDeskWorkspaceUpdate) => void;

/**
 * A handle is a stable typed reference to a daemon resource. Its identity is the
 * daemon id, and `latest()` only returns the most recent snapshot this handle has
 * seen through construction, `refetch()`, or this handle's local subscription.
 */
export interface JAgentDeskWorkspaceHandle {
  readonly id: string;
  latest(): JAgentDeskWorkspace | null;
  /**
   * Fetches a fresh workspace snapshot through the existing workspace list RPC,
   * exact-matches this handle id from the result, and updates `latest()`.
   */
  refetch(options?: { requestId?: string }): Promise<JAgentDeskWorkspace | null>;
  archive(requestId?: string): Promise<JAgentDeskWorkspaceArchiveResult>;
  /**
   * Subscribes to already-emitted daemon workspace_update events for this id.
   * This returns a local unsubscribe function; it does not own app cache state or
   * send a daemon unsubscribe RPC. Call `workspaces.list({ subscribe: {} })` when
   * the daemon should start streaming workspace directory updates.
   */
  subscribe(handler: (update: JAgentDeskWorkspaceUpdate) => void): () => void;
}

export interface JAgentDeskWorkspaceActions {
  list(options?: JAgentDeskWorkspaceListOptions): Promise<JAgentDeskWorkspaceListResult>;
  ref(workspace: string | JAgentDeskWorkspace): JAgentDeskWorkspaceHandle;
  open(
    input: string | JAgentDeskWorkspaceOpenOptions,
    requestId?: string,
  ): Promise<JAgentDeskWorkspaceOpenResult>;
  create(
    input: string | JAgentDeskWorkspaceOpenOptions,
    requestId?: string,
  ): Promise<JAgentDeskWorkspaceOpenResult>;
  archive(
    workspace: string | JAgentDeskWorkspaceHandle,
    requestId?: string,
  ): Promise<JAgentDeskWorkspaceArchiveResult>;
  /**
   * Local event subscription over the low-level driver's workspace_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: JAgentDeskWorkspaceUpdateHandler): () => void;
}

type JAgentDeskAgentSessionConfig = CreateAgentRequestMessage["config"];
type JAgentDeskAgentProvider = JAgentDeskAgentSessionConfig["provider"];
type JAgentDeskAgentConfigOverrides = Partial<
  Omit<JAgentDeskAgentSessionConfig, "provider" | "cwd">
>;

export interface JAgentDeskAgentCreateOptions extends JAgentDeskAgentConfigOverrides {
  config?: JAgentDeskAgentSessionConfig;
  provider?: CreateAgentRequestMessage["config"]["provider"];
  cwd?: string;
  workspaceId?: string;
  callerAgentId?: string;
  initialPrompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: CreateAgentRequestMessage["images"];
  attachments?: CreateAgentRequestMessage["attachments"];
  git?: CreateAgentRequestMessage["git"];
  requestId?: string;
  labels?: Record<string, string>;
}

export interface JAgentDeskAgentRefetchResult {
  agent: JAgentDeskAgent;
  project: ProjectPlacementPayload | null;
}

export interface JAgentDeskAgentTimelineRefetchOptions {
  direction?: FetchAgentTimelineDirection;
  cursor?: FetchAgentTimelineCursor;
  limit?: number;
  projection?: FetchAgentTimelineProjection;
  requestId?: string;
}

export interface JAgentDeskAgentSendOptions {
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: SendAgentMessageRequest["attachments"];
}

export type JAgentDeskAgentUpdate = Extract<
  SessionOutboundMessage,
  { type: "agent_update" }
>["payload"];

export type JAgentDeskAgentStream = Extract<
  SessionOutboundMessage,
  { type: "agent_stream" }
>["payload"];

export type JAgentDeskAgentUpdateHandler = (update: JAgentDeskAgentUpdate) => void;

export interface JAgentDeskAgentTimelineHandle {
  /**
   * Fetches a fresh timeline page through the existing daemon RPC. If the daemon
   * includes an agent snapshot in the response, the parent handle's `latest()`
   * is updated to that snapshot.
   */
  refetch(options?: JAgentDeskAgentTimelineRefetchOptions): Promise<FetchAgentTimelinePayload>;
  /**
   * Local listener for agent_stream events matching this handle id. It does not
   * retain timeline entries or own application cache state.
   */
  subscribe(handler: (event: JAgentDeskAgentStream) => void): () => void;
}

/**
 * Agent handles follow the same identity/snapshot rule as workspace handles:
 * `id` is stable, while `latest()` is only the newest snapshot observed by this
 * handle through construction, `refetch()`, timeline refetch, archive, or local
 * agent_update subscription.
 */
export interface JAgentDeskAgentHandle {
  readonly id: string;
  readonly timeline: JAgentDeskAgentTimelineHandle;
  latest(): JAgentDeskAgent | null;
  refetch(requestId?: string): Promise<JAgentDeskAgentRefetchResult | null>;
  send(text: string, options?: JAgentDeskAgentSendOptions): Promise<void>;
  archive(): Promise<{ archivedAt: string }>;
  detach(): Promise<void>;
  subscribe(handler: (update: JAgentDeskAgentUpdate) => void): () => void;
}

export interface JAgentDeskAgentActions {
  ref(agent: string | JAgentDeskAgent): JAgentDeskAgentHandle;
  create(options: JAgentDeskAgentCreateOptions): Promise<JAgentDeskAgentHandle>;
  /**
   * Local event subscription over the low-level driver's agent_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: JAgentDeskAgentUpdateHandler): () => void;
}

export interface JAgentDeskProviderConfig extends JAgentDeskProviderConfigInput {
  provider: JAgentDeskAgentProvider;
}
export type JAgentDeskProviderFeatureValues = Record<string, unknown>;

export interface JAgentDeskProviderConfigInput {
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: JAgentDeskProviderFeatureValues;
}

export type JAgentDeskProviderModelsResult = ListProviderModelsResponseMessage["payload"];
export type JAgentDeskProviderModesResult = ListProviderModesResponseMessage["payload"];
export type JAgentDeskProviderFeaturesInput = ListProviderFeaturesRequestMessage["draftConfig"];
export type JAgentDeskProviderFeaturesResult = ListProviderFeaturesResponseMessage["payload"];
export type JAgentDeskProviderAvailabilityResult = ListAvailableProvidersResponse["payload"];
export type JAgentDeskProviderSnapshotResult = GetProvidersSnapshotResponseMessage["payload"];
export type JAgentDeskProviderSnapshotUpdate = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>["payload"];
export type JAgentDeskProviderRefreshResult = RefreshProvidersSnapshotResponseMessage["payload"];
export type JAgentDeskProviderDiagnosticResult = ProviderDiagnosticResponseMessage["payload"];

export interface JAgentDeskProviderListOptions {
  cwd?: string;
  requestId?: string;
}

export interface JAgentDeskProviderRefreshOptions {
  cwd?: string;
  providers?: JAgentDeskAgentProvider[];
  requestId?: string;
}

export interface JAgentDeskProviderActions {
  codex(input?: JAgentDeskProviderConfigInput): JAgentDeskProviderConfig;
  claude(input?: JAgentDeskProviderConfigInput): JAgentDeskProviderConfig;
  opencode(input?: JAgentDeskProviderConfigInput): JAgentDeskProviderConfig;
  copilot(input?: JAgentDeskProviderConfigInput): JAgentDeskProviderConfig;
  config(
    provider: JAgentDeskAgentProvider,
    input?: JAgentDeskProviderConfigInput,
  ): JAgentDeskProviderConfig;
  listModels(
    provider: JAgentDeskAgentProvider,
    options?: JAgentDeskProviderListOptions,
  ): Promise<JAgentDeskProviderModelsResult>;
  listModes(
    provider: JAgentDeskAgentProvider,
    options?: JAgentDeskProviderListOptions,
  ): Promise<JAgentDeskProviderModesResult>;
  listFeatures(
    draftConfig: JAgentDeskProviderFeaturesInput,
    options?: { requestId?: string },
  ): Promise<JAgentDeskProviderFeaturesResult>;
  listAvailable(options?: { requestId?: string }): Promise<JAgentDeskProviderAvailabilityResult>;
  snapshot(options?: JAgentDeskProviderListOptions): Promise<JAgentDeskProviderSnapshotResult>;
  refresh(options?: JAgentDeskProviderRefreshOptions): Promise<JAgentDeskProviderRefreshResult>;
  diagnostic(
    provider: JAgentDeskAgentProvider,
    options?: { requestId?: string },
  ): Promise<JAgentDeskProviderDiagnosticResult>;
  subscribe(handler: (update: JAgentDeskProviderSnapshotUpdate) => void): () => void;
}

export interface JAgentDeskConfigActions {
  /**
   * Reads daemon config through the existing config RPC. Provider profiles,
   * custom provider entries, keys/env, custom binaries, and provider enablement
   * are currently config-file-shaped daemon state, so the SDK exposes this raw
   * typed surface instead of pretending there are higher-level provider-settings
   * RPCs.
   */
  get(requestId?: string): Promise<{ requestId: string; config: MutableDaemonConfig }>;
  /**
   * Patches daemon config through the existing config RPC. The daemon validates
   * and persists supported fields; unsupported provider/settings workflows remain
   * daemon gaps until first-class RPCs exist.
   */
  patch(
    config: MutableDaemonConfigPatch,
    requestId?: string,
  ): Promise<{ requestId: string; config: MutableDaemonConfig }>;
}

/**
 * The daemon-facing action surface (workspaces / agents / providers / config)
 * without any connection lifecycle. Built over an existing {@link DaemonClient}
 * so multiple consumers — the CLI client, plugin subprocesses — can share one
 * daemon session. See {@link createJAgentDeskApi}.
 */
export interface JAgentDeskApi {
  readonly workspaces: JAgentDeskWorkspaceActions;
  readonly agents: JAgentDeskAgentActions;
  readonly providers: JAgentDeskProviderActions;
  readonly config: JAgentDeskConfigActions;
}

export interface JAgentDeskClient extends JAgentDeskApi {
  connect(): Promise<void>;
  close(): Promise<void>;
  ensureConnected(): void;
  getConnectionState(): ConnectionState;
}

/**
 * Build the daemon action facade over an existing DaemonClient, without owning
 * the connection lifecycle. This is the surface handed to plugin backends (which
 * reach the daemon over an IPC transport) and the core of
 * {@link createJAgentDeskClient}.
 */
export function createJAgentDeskApi(daemonClient: DaemonClient): JAgentDeskApi {
  const createWorkspaceHandle = createWorkspaceHandleFactory(daemonClient);
  const createAgentHandle = createAgentHandleFactory(daemonClient);

  return {
    workspaces: {
      list: (options) => daemonClient.fetchWorkspaces(options),
      ref: (workspace) => createWorkspaceHandle(workspace),
      open: (input, requestId) =>
        openWorkspace(daemonClient, createWorkspaceHandle, input, requestId),
      create: (input, requestId) =>
        openWorkspace(daemonClient, createWorkspaceHandle, input, requestId),
      archive: (workspace, requestId) =>
        daemonClient.archiveWorkspace(resolveWorkspaceId(workspace), requestId),
      subscribe: (handler) =>
        daemonClient.on("workspace_update", (message) => {
          handler(message.payload);
        }),
    },
    agents: {
      ref: (agent) => createAgentHandle(agent),
      create: async (options) => {
        const agent = await daemonClient.createAgent(options);
        return createAgentHandle(agent);
      },
      subscribe: (handler) =>
        daemonClient.on("agent_update", (message) => {
          handler(message.payload);
        }),
    },
    providers: {
      codex: (input) => providerConfig("codex", input),
      claude: (input) => providerConfig("claude", input),
      opencode: (input) => providerConfig("opencode", input),
      copilot: (input) => providerConfig("copilot", input),
      config: (provider, input) => providerConfig(provider, input),
      listModels: (provider, options) => daemonClient.listProviderModels(provider, options),
      listModes: (provider, options) => daemonClient.listProviderModes(provider, options),
      listFeatures: (draftConfig, options) =>
        daemonClient.listProviderFeatures(draftConfig, options),
      listAvailable: (options) => daemonClient.listAvailableProviders(options),
      snapshot: (options) => daemonClient.getProvidersSnapshot(options),
      refresh: (options) => daemonClient.refreshProvidersSnapshot(options),
      diagnostic: (provider, options) => daemonClient.getProviderDiagnostic(provider, options),
      subscribe: (handler) =>
        daemonClient.on("providers_snapshot_update", (message) => {
          handler(message.payload);
        }),
    },
    config: {
      get: (requestId) => daemonClient.getDaemonConfig(requestId),
      patch: (patch, requestId) => daemonClient.patchDaemonConfig(patch, requestId),
    },
  };
}

export function createJAgentDeskClient(config: JAgentDeskClientConfig): JAgentDeskClient {
  const daemonClient = new DaemonClient({
    ...config,
    clientId: config.clientId ?? createGeneratedClientId(),
    clientType: "cli",
  });

  return {
    ...createJAgentDeskApi(daemonClient),
    connect: () => daemonClient.connect(),
    close: () => daemonClient.close(),
    ensureConnected: () => daemonClient.ensureConnected(),
    getConnectionState: () => daemonClient.getConnectionState(),
  };
}

type WorkspaceHandleFactory = (
  workspace: string | JAgentDeskWorkspace,
) => JAgentDeskWorkspaceHandle;
type AgentHandleFactory = (agent: string | JAgentDeskAgent) => JAgentDeskAgentHandle;

function createWorkspaceHandleFactory(daemonClient: DaemonClient): WorkspaceHandleFactory {
  return (workspace) => {
    const id = typeof workspace === "string" ? workspace : workspace.id;
    let latest = typeof workspace === "string" ? null : workspace;

    return {
      id,
      latest: () => latest,
      refetch: async (options) => {
        // Best-effort: fetches one page and matches by id client-side, so a workspace beyond
        // the first page won't be found. TODO: add a "get workspace by id" lookup and resolve
        // by exact id instead of paging.
        const result = await daemonClient.fetchWorkspaces({
          requestId: options?.requestId,
          page: { limit: 25 },
        });
        latest = result.entries.find((entry) => entry.id === id) ?? null;
        return latest;
      },
      archive: async (requestId) => {
        const result = await daemonClient.archiveWorkspace(id, requestId);
        if (latest) {
          latest = { ...latest, archivingAt: result.archivedAt };
        }
        return result;
      },
      subscribe: (handler) =>
        daemonClient.on("workspace_update", (message) => {
          const update = message.payload;
          if (update.kind === "upsert" && update.workspace.id === id) {
            latest = update.workspace;
            handler(update);
          }
          if (update.kind === "remove" && update.id === id) {
            latest = null;
            handler(update);
          }
        }),
    };
  };
}

function createAgentHandleFactory(daemonClient: DaemonClient): AgentHandleFactory {
  return (agent) => {
    const id = typeof agent === "string" ? agent : agent.id;
    let latest = typeof agent === "string" ? null : agent;

    const handle: JAgentDeskAgentHandle = {
      id,
      timeline: {
        refetch: async (options) => {
          const result = await daemonClient.fetchAgentTimeline(id, options);
          if (result.agent) {
            latest = result.agent;
          }
          return result;
        },
        subscribe: (handler) =>
          daemonClient.on("agent_stream", (message) => {
            if (message.payload.agentId === id) {
              handler(message.payload);
            }
          }),
      },
      latest: () => latest,
      refetch: async (requestId) => {
        const result = await daemonClient.fetchAgent({ agentId: id, requestId });
        latest = result?.agent ?? null;
        return result;
      },
      send: async (text, options) => {
        await daemonClient.sendAgentMessage(id, text, options);
      },
      archive: async () => {
        const result = await daemonClient.archiveAgent(id);
        if (latest) {
          latest = { ...latest, archivedAt: result.archivedAt };
        }
        return result;
      },
      detach: async () => {
        await daemonClient.detachAgent(id);
      },
      subscribe: (handler) =>
        daemonClient.on("agent_update", (message) => {
          const update = message.payload;
          if (update.kind === "upsert" && update.agent.id === id) {
            latest = update.agent;
            handler(update);
          }
          if (update.kind === "remove" && update.agentId === id) {
            latest = null;
            handler(update);
          }
        }),
    };

    return handle;
  };
}

async function openWorkspace(
  daemonClient: DaemonClient,
  createWorkspaceHandle: WorkspaceHandleFactory,
  input: string | JAgentDeskWorkspaceOpenOptions,
  requestId?: string,
): Promise<JAgentDeskWorkspaceOpenResult> {
  const options = typeof input === "string" ? { cwd: input, requestId } : input;
  const result = await daemonClient.openProject(options.cwd, options.requestId);
  return {
    ...result,
    workspace: result.workspace ? createWorkspaceHandle(result.workspace) : null,
  };
}

function resolveWorkspaceId(workspace: string | JAgentDeskWorkspaceHandle): string {
  return typeof workspace === "string" ? workspace : workspace.id;
}

function providerConfig(
  provider: JAgentDeskAgentProvider,
  input: JAgentDeskProviderConfigInput = {},
): JAgentDeskProviderConfig {
  return {
    provider,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.modeId !== undefined ? { modeId: input.modeId } : {}),
    ...(input.thinkingOptionId !== undefined ? { thinkingOptionId: input.thinkingOptionId } : {}),
    ...(input.featureValues !== undefined ? { featureValues: input.featureValues } : {}),
  };
}

function createGeneratedClientId(): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `jagentdesk-sdk-${randomId}`;
}
