import {
  CROSS_PROVIDER_CHILDREN_DISABLED,
  FAILOVER_DISABLED,
  type CrossProviderChildrenConfig,
  type FailoverConfig,
} from "./agent/failover/failover-policy.js";
import { ProviderQuotaTracker } from "./agent/failover/provider-quota.js";
import { ProviderUsageService } from "../services/quota-fetcher/service.js";
import { builtinServerRegistry } from "./plugins/builtin/loaded.js";
import { createBuiltinCoreServices } from "./plugins/builtin/services.js";
import { createBuiltinHostToolSet } from "./plugins/builtin/host-tool-set.js";
import {
  createFinishSubscriptions as createRemoteFinishSubscriptions,
  createJsonFinishSubscriptionStore as createRemoteFinishStore,
  createFinishObservation as createRemoteFinishObservation,
  type FinishSubscriptions as RemoteFinishSubscriptions,
} from "./agent/remote-finish-subscriptions/index.js";
import { connectThroughProxy } from "./ssh/proxy/connect.js";
import { BotsSlack } from "./bots/slack.js";
import { BotsHookConnectors } from "./bots/hooks/connectors.js";
import type { ForgeCli } from "./bots/hooks/cli.js";
import { BotsSharing } from "./bots/sharing/service.js";
import { relayControlMux } from "./relay-control-mux.js";
import { createIdleRuntimeCleanup } from "./agent/idle-runtime-cleanup/index.js";
import { createChangeRequestRouter } from "../services/change-request-router.js";
import { createForgeService } from "../services/forge-registry.js";
import { createForgeResolver } from "../services/forge-resolver.js";
import { createChangeRequestWatches } from "./agent/change-request-watches/index.js";
import { getAgentMessageDelivery, setupFinishNotification } from "./agent/agent-prompt.js";
import { BotStorage } from "./bots/storage.js";
import { BotsService } from "./bots/service.js";
import type { BotTriggerSource } from "./bots/service.js";
import { DaemonBotRuntime } from "./bots/daemon-runtime.js";
import { LocalBotTriggers, countOwnOpenPullRequests } from "./bots/triggers.js";
import { createBotAgentTools } from "./bots/agent-tools.js";
import { isBotBackgroundRun } from "./bots/runtime.js";
import { createRestartRecovery } from "./agent/restart-recovery/index.js";
import { PROVIDER_BACKGROUND_REFRESH_INTERVAL_MS } from "./agent/provider-refresh-schedule.js";
import { resolveJAgentDeskToolPolicy } from "./agent/jagentdesk-tool-policy.js";
import { BuiltinPluginLoader } from "./plugins/builtin/index.js";
import { withTimeout } from "../utils/promise-timeout.js";
import { describeHookWorkspace } from "./plugins/lifecycle/index.js";
import { WorkspaceArchiveOperations } from "./workspace-archive-operations.js";
import { HostCapabilityService } from "./host-capabilities/service.js";
import { closeAgentMessageDelivery } from "./agent/agent-prompt.js";
import {
  FinishSubscriptionStore,
  restoreFinishSubscriptions,
  hasOutstandingFinishSubscriptions,
  setRemoteDelegationProbe,
  suspendFinishNotifications,
} from "./agent/finish-subscriptions/index.js";
import { ensureToolDirsOnPath, HostToolInstaller } from "./host-tools/installer.js";
import type { HttpFetch } from "./host-tools/release.js";
import { setSharedHostToolInstaller } from "./host-tools/shared-installer.js";
import { unarchiveAgentState } from "./agent/agent-prompt.js";
import { unarchiveWorkspaceAgents } from "./workspace-archive-service.js";
import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import express from "express";
import {
  agentShimDir,
  installAgentBrowserShims,
  writeAgentShimEndpoint,
} from "./agent-browser-shim/install.js";
import {
  AGENT_BROWSER_OPEN_ROUTE,
  AGENT_FILES_ROUTE,
  AgentFileShares,
  createAgentBrowserOpenRouteHandler,
  createAgentFilesRouteHandler,
} from "./agent-browser-shim/routes.js";
import { createServer as createHTTPServer, type IncomingMessage, type ServerResponse } from "http";
import { constants, existsSync, unlinkSync } from "fs";
import { open } from "fs/promises";
import { randomUUID } from "node:crypto";
import { getCachedHostMachineKind, primeHostMachineKind } from "./host-machine-kind.js";
import { getHostName } from "./host-name.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import type { Logger } from "pino";
import { z } from "zod";
import { createBranchChangeRouteHandler } from "./script-route-branch-handler.js";

export type ListenTarget =
  | { type: "tcp"; host: string; port: number }
  | { type: "socket"; path: string }
  | { type: "pipe"; path: string };

function resolveBoundListenTarget(
  listenTarget: ListenTarget,
  httpServer: ReturnType<typeof createHTTPServer>,
): ListenTarget {
  if (listenTarget.type !== "tcp") {
    return listenTarget;
  }

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address after listening");
  }

  return {
    type: "tcp",
    host: listenTarget.host,
    port: address.port,
  };
}

// Matches a Windows drive-letter path like C:\ or D:\
const WINDOWS_DRIVE_RE = /^[A-Za-z]:\\/;

export function parseListenString(listen: string): ListenTarget {
  // 1. Windows named pipes: \\.\pipe\... or pipe://...
  if (listen.startsWith("\\\\.\\pipe\\") || listen.startsWith("pipe://")) {
    return {
      type: "pipe",
      path: listen.startsWith("pipe://") ? listen.slice("pipe://".length) : listen,
    };
  }
  // 2. Explicit unix:// prefix
  if (listen.startsWith("unix://")) {
    return { type: "socket", path: listen.slice(7) };
  }
  // 3. Reject Windows absolute drive paths — they are not Unix sockets
  if (WINDOWS_DRIVE_RE.test(listen)) {
    throw new Error(`Invalid listen string (Windows path is not a valid listen target): ${listen}`);
  }
  // 4. POSIX absolute path (/ or ~) — Unix socket
  if (listen.startsWith("/") || listen.startsWith("~")) {
    return { type: "socket", path: listen };
  }
  // 5. Pure numeric — TCP port on 127.0.0.1
  const trimmed = listen.trim();
  if (/^\d+$/.test(trimmed)) {
    const port = parseInt(trimmed, 10);
    return { type: "tcp", host: "127.0.0.1", port };
  }
  // 6. host:port — TCP
  if (listen.includes(":")) {
    const lastColonIdx = listen.lastIndexOf(":");
    const host = listen.slice(0, lastColonIdx);
    const portStr = listen.slice(lastColonIdx + 1);
    const parsedPort = parseInt(portStr, 10);
    if (!Number.isFinite(parsedPort)) {
      throw new Error(`Invalid port in listen string: ${listen}`);
    }
    const cleanHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    return { type: "tcp", host: cleanHost || "127.0.0.1", port: parsedPort };
  }
  throw new Error(`Invalid listen string: ${listen}`);
}

function formatListenTarget(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget) {
    return null;
  }
  if (listenTarget.type === "tcp") {
    return `${listenTarget.host}:${listenTarget.port}`;
  }
  return listenTarget.path;
}

export async function fanOutReconciledWorkspaceUpdates(input: {
  sessions: Iterable<{
    syncWorkspaceGitObserversForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
    emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void>;
  }>;
  workspaceIds: readonly string[];
  logger: Pick<Logger, "warn">;
}): Promise<void> {
  await Promise.all(
    Array.from(input.sessions, async (session) => {
      try {
        await session.syncWorkspaceGitObserversForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn(
          { err: error },
          "Failed to sync workspace Git observers after reconciliation",
        );
      }
      try {
        await session.emitWorkspaceUpdatesForExternalWorkspaceIds(input.workspaceIds);
      } catch (error) {
        input.logger.warn({ err: error }, "Failed to emit workspace updates after reconciliation");
      }
    }),
  );
}

import { VoiceAssistantWebSocketServer, isDaemonOriginAllowed } from "./websocket-server.js";
import { enrichProcessPath } from "./enrich-path.js";
import { createGitHubService } from "../services/github-service.js";
import { createJAgentDeskWorktree as createRegisteredJAgentDeskWorktree } from "./jagentdesk-worktree-service.js";
import { createWorkspaceProvisioningService } from "./session/workspace-provisioning/workspace-provisioning-service.js";
import { createJAgentDeskWorktreeWorkflow } from "./worktree-session.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { formatAttachmentContentDisposition } from "./file-download/content-disposition.js";
import type { OpenAiSpeechProviderConfig } from "./speech/providers/openai/config.js";
import type { LocalSpeechProviderConfig } from "./speech/providers/local/config.js";
import type { RequestedSpeechProviders } from "./speech/speech-types.js";
import { createSpeechService } from "./speech/speech-runtime.js";
import { createSpeechSettingsOwner } from "./speech/speech-settings.js";
import { AgentManager } from "./agent/agent-manager.js";
import { AgentTimelineSnapshots } from "./agent/agent-timeline-snapshots.js";
import { AgentStorage } from "./agent/agent-storage.js";
import { attachAgentStoragePersistence } from "./persistence-hooks.js";
import { createAgentMcpServer } from "./agent/mcp-server.js";
import { createAgentMcpProtocolNormalizer } from "./agent/mcp-protocol.js";
import {
  createJAgentDeskToolCatalog,
  createJAgentDeskAgentToolManifest,
  type JAgentDeskToolHostDependencies,
} from "./agent/tools/jagentdesk-tools.js";
import type { JAgentDeskToolRuntimeContext } from "./agent/tools/types.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import { createAgentProviderRuntime } from "./agent/provider-runtime.js";
import { bootstrapWorkspaceRegistries } from "./workspace-registry-bootstrap.js";
import { WorkspaceReconciliationService } from "./workspace-reconciliation-service.js";
import {
  FileBackedProjectRegistry,
  FileBackedWorkspaceRegistry,
  type WorkspaceArchiveContext,
} from "./workspace-registry.js";
import { FileBackedChatService } from "./chat/chat-service.js";
import { CheckoutDiffManager } from "./checkout-diff-manager.js";
import { LoopService } from "./loop-service.js";
import { ClusterRegistry } from "./cluster/cluster-registry.js";
import { DatabaseRegistry } from "./database/database-registry.js";
import { ScheduleService } from "./schedule/service.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import { createBuiltinProjectAccess } from "./plugins/builtin/project-access.js";
import { TunnelManager } from "./tunnels/tunnel-manager.js";
import { DaemonConfigStore, type MutableDaemonConfig } from "./daemon-config-store.js";
import { PluginService } from "./plugins/index.js";
import { ManagedPluginSources } from "./plugins/managed-source.js";
import { BrowserToolsBroker } from "./browser-tools/broker.js";
import { WorkspaceGitServiceImpl } from "./workspace-git-service.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import { FileSecretStore } from "./database/secret-store.js";
import { DEFAULT_RELAY_ENDPOINT, extractProviderOverrides } from "./config.js";
import { createCustomProviderService } from "./custom-providers/service.js";
import {
  archiveByScope,
  archivePersistedWorkspaceRecord,
  killTerminalsForWorkspace,
  type ActiveWorkspaceRef,
} from "./workspace-archive-service.js";
import { setupAutoArchiveOnMerge } from "./auto-archive-on-merge/index.js";
import {
  assertWorkspaceAutomationAllowedForWorkspace,
  isCheckoutUntrusted,
} from "./workspace-automation-gate.js";
import { wrapSessionMessage, type SessionOutboundMessage } from "./messages.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";
import { startWorkerTerminalManager } from "../terminal/worker-terminal-manager.js";
import { withTerminalCreateHook } from "../terminal/terminal-create-hook.js";
import { createSshTerminalManager } from "../terminal/ssh-terminal-manager.js";
import { SshService } from "./ssh/ssh-service.js";
import { removeRetiredFigmaData } from "./retired-figma-data.js";
import { SshModules } from "./ssh/ssh-modules.js";
import { SshModules as SshServerModules } from "./ssh/modules.js";
import { applyTerminalAgentHookSetting } from "../terminal/agent-hooks/terminal-agent-hook-setting.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { createTsnetListener, type TsnetListener } from "./tsnet-listener.js";
import { createRelayRuntime, type RelayRuntime } from "./relay-runtime.js";
import { admitSecuredRelaySocket } from "./websocket/secure-relay-ingress.js";
import { createPairedDeviceStore, type PairedDeviceStore } from "./pairing/paired-devices.js";
import {
  createNonceChallengeManager,
  type NonceChallengeManager,
} from "./pairing/nonce-challenge.js";
import { createPairingCodeManager, type PairingCodeManager } from "./pairing/pairing-code.js";
import type { PushNotifications, PushNotificationSender } from "./push/index.js";
import { getOrCreateServerId } from "./server-id.js";
import { resolveDaemonVersion } from "./daemon-version.js";
import type { AgentClient, AgentProvider } from "./agent/agent-sdk-types.js";
import type { FirstAgentContext, TerminalProfile } from "@jagentdesk/protocol/messages";
import {
  createDefaultOrchestrationConfig,
  type OrchestrationConfig,
} from "@jagentdesk/protocol/orchestration";
import { OrchestrationRuntime } from "./orchestration/runtime.js";
import type {
  AgentProviderRuntimeSettingsMap,
  ProviderOverride,
} from "./agent/provider-launch-config.js";
import { loadPersistedConfig, type PersistedConfig } from "./persisted-config.js";
import { createServiceProxySubsystem, type ServiceProxySubsystem } from "./service-proxy.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { ScriptHealthMonitor } from "./script-health-monitor.js";
import { createScriptStatusEmitter } from "./script-status-projection.js";
import { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import { createWorkspaceScriptsService } from "./session/workspace-scripts/workspace-scripts-service.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import {
  createManagedProcessRegistry,
  createSystemManagedProcessTable,
  type ManagedProcessRegistry,
} from "./managed-processes/managed-processes.js";
import { terminateWithTreeKill } from "../utils/tree-kill.js";
import { isHostnameAllowed, type HostnamesConfig } from "./hostnames.js";
import {
  createRequireBearerMiddleware,
  isAgentMcpRequestAuthorized,
  type DaemonAuthConfig,
} from "./auth.js";
import { createWebUiMiddleware } from "./web-ui.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createGitMutationService } from "./session/git-mutation/git-mutation-service.js";
import { workspaceIdsOnCheckout } from "./workspace-directory.js";
import { configureGitProcessPolicy } from "../utils/run-git-command.js";
import { resolveGitProcessPolicy } from "../utils/git-process-scheduler.js";
import { resolveFirstAgentPromptTitle } from "./agent/create-agent-title.js";
import {
  createAgentCommand,
  type CreateAgentCommandDependencies,
} from "./agent/create-agent/create.js";
import { archiveAgentCommand, cancelAgentRunCommand } from "./agent/lifecycle-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import {
  HubRelationshipController,
  type HubRelationshipClock,
  type HubRelationshipRetryPolicy,
} from "./hub/relationship-controller.js";
import {
  DirectHubRelationshipRemote,
  type HubRelationshipRemote,
} from "./hub/relationship-remote.js";
import { DaemonExecutions } from "./hub/daemon-executions.js";
import { hubScopesForPermissions } from "./authorization/index.js";

const MAX_MCP_DEBUG_BATCH_ITEMS = 10;
const REDACTED_LOG_VALUE = "[redacted]";
const DOWNLOAD_OPEN_FLAGS =
  process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveAgentMcpClientHost(host: string): string {
  if (host === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (host === "::" || host === "[::]") {
    return "::1";
  }
  return host;
}

function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

function createLoopbackBaseUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`;
}

function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }
  const host = resolveAgentMcpClientHost(listenTarget.host);
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(host)}:${listenTarget.port}`,
  ).toString();
}

const TerminalActivityReportSchema = z.object({
  terminalId: z.string().min(1),
  token: z.string().min(1),
  state: z.enum(["running", "idle", "needs-input"]),
});

const TERMINAL_ACTIVITY_STATE_MAP = {
  running: "working",
  idle: "idle",
  "needs-input": "attention",
} as const;

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

export function createTerminalActivityRouteHandler(
  terminalManager: TerminalManager,
): express.RequestHandler {
  return async (req, res) => {
    if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const parsed = TerminalActivityReportSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid terminal activity report" });
      return;
    }

    const validation = terminalManager.validateTerminalActivityToken(
      parsed.data.terminalId,
      parsed.data.token,
    );
    if (validation !== "valid") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    try {
      const updated = await terminalManager.setTerminalActivity(
        parsed.data.terminalId,
        TERMINAL_ACTIVITY_STATE_MAP[parsed.data.state],
      );
      if (!updated) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      res.status(204).end();
    } catch {
      res.status(500).json({ error: "Failed to update terminal activity" });
    }
  };
}

function summarizeAgentMcpDebugMessage(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      type: body === null ? "null" : typeof body,
    };
  }

  const record = body as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : undefined;
  return {
    type: "object",
    ...(typeof record.jsonrpc === "string" ? { jsonrpc: record.jsonrpc } : {}),
    ...(method ? { method } : {}),
    hasId: Object.prototype.hasOwnProperty.call(record, "id"),
    hasParams: Object.prototype.hasOwnProperty.call(record, "params"),
  };
}

function summarizeAgentMcpDebugBody(body: unknown): Record<string, unknown> {
  if (!Array.isArray(body)) {
    return summarizeAgentMcpDebugMessage(body);
  }

  const messages = body.slice(0, MAX_MCP_DEBUG_BATCH_ITEMS).map(summarizeAgentMcpDebugMessage);
  return {
    type: "batch",
    count: body.length,
    messages,
    ...(body.length > messages.length ? { omitted: body.length - messages.length } : {}),
  };
}

export type JAgentDeskOpenAIConfig = OpenAiSpeechProviderConfig;
export type JAgentDeskLocalSpeechConfig = LocalSpeechProviderConfig;

export interface JAgentDeskSpeechSttLanguages {
  dictation: string;
  voice: string;
}

export interface JAgentDeskSpeechConfig {
  providers: RequestedSpeechProviders;
  // Where local models live, whether or not a feature currently uses the local provider.
  localModelsDir: string;
  sttLanguages?: JAgentDeskSpeechSttLanguages;
  local?: JAgentDeskLocalSpeechConfig;
}

export type DaemonLifecycleIntent =
  | {
      type: "shutdown";
      clientId: string;
      requestId: string;
      reason: string;
      keepTerminals: boolean;
    }
  | {
      type: "restart";
      clientId: string;
      requestId: string;
      reason: string;
      keepTerminals: boolean;
    };

export interface JAgentDeskDaemonConfig {
  listen: string;
  jagentdeskHome: string;
  daemonVersion?: string;
  resumeOnStartup?: boolean;
  resumePrompt?: string;
  desktopManaged?: boolean;
  worktreesRoot?: string;
  corsAllowedOrigins: string[];
  allowedHosts?: HostnamesConfig;
  hostnames?: HostnamesConfig;
  trustedProxies?: true | string[];
  mcpEnabled?: boolean;
  mcpInjectIntoAgents?: boolean;
  browserToolsEnabled?: boolean;
  // Anti-detect fingerprint profiles and the active one (ADR-0011), persisted in config.json.
  browserFingerprintProfiles?: NonNullable<MutableDaemonConfig["browserTools"]["profiles"]>;
  browserActiveProfileId?: string | null;
  builtinPlugins?: MutableDaemonConfig["builtinPlugins"];
  pluginsEnabled?: boolean;
  plugins?: MutableDaemonConfig["plugins"];
  // Autonomous run (spec §20). Default OFF; only exposes the autorun.* RPC surface +
  // `features.autorun` capability when explicitly enabled in persisted config.
  autorunEnabled?: boolean;
  // Session sharing (spec §21). Default OFF; exposes one agent chat via a Cloudflare tunnel.
  sessionSharingEnabled?: boolean;
  // Relay second path (spec 35). Default ON; daemon dials the Worker alongside the tailnet.
  relayEnabled?: boolean;
  relayEnabledMutable?: boolean;
  relayEndpoint?: string;
  relayUseTls?: boolean;
  // Directory of the app web build served to session-share guests as the real UI (ADR-0019).
  sessionShareAppDistDir?: string;
  git?: {
    maxProcessesPerSecond: number;
    maxProcessConcurrency: number;
  };
  autoArchiveAfterMerge?: boolean;
  enableTerminalAgentHooks?: boolean;
  appendSystemPrompt?: string;
  // Operator / engagement authorization context injected first into every agent's system prompt.
  operatorContext?: string;
  hideProviderJiraConnectors?: boolean;
  terminalProfiles?: TerminalProfile[];
  orchestration?: OrchestrationConfig;
  staticDir: string;
  mcpDebug: boolean;
  isDev?: boolean;
  agentClients: Partial<Record<AgentProvider, AgentClient>>;
  agentStoragePath: string;
  tailnetHost?: string;
  tailnetStateDir?: string;
  tailnetHostname?: string;
  serviceProxy?: {
    publicBaseUrl: string | null;
    standaloneListen: string | null;
  };
  webUi?: {
    enabled: boolean;
    distDir: string | null;
  };
  appBaseUrl?: string;
  auth?: DaemonAuthConfig;
  openai?: JAgentDeskOpenAIConfig;
  speech?: JAgentDeskSpeechConfig;
  voiceLlmProvider?: AgentProvider | null;
  voiceLlmProviderExplicit?: boolean;
  voiceLlmModel?: string | null;
  dictationFinalTimeoutMs?: number;
  downloadTokenTtlMs?: number;
  agentProviderSettings?: AgentProviderRuntimeSettingsMap;
  idleRuntimeCleanup?: boolean;
  agentFailover?: FailoverConfig;
  crossProviderChildren?: CrossProviderChildrenConfig;
  metadataGeneration?: {
    providers?: Array<{
      provider: string;
      model?: string;
      thinkingOptionId?: string;
    }>;
  };
  providerOverrides?: Record<string, ProviderOverride>;
  log?: PersistedConfig["log"];
  onLifecycleIntent?: (intent: DaemonLifecycleIntent) => void;
  pushNotificationSender?: PushNotificationSender;
  pushNotifications?: PushNotifications;
  managedProcesses?: ManagedProcessRegistry;
}

export interface JAgentDeskDaemon {
  config: JAgentDeskDaemonConfig;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  terminalManager: TerminalManager;
  serviceProxy: ServiceProxySubsystem;
  scriptRuntimeStore: WorkspaceScriptRuntimeStore;
  browserToolsBroker: BrowserToolsBroker;
  start(): Promise<void>;
  /** Stops the daemon. Terminals keep running for the next daemon only with keepTerminals. */
  stop(options?: { keepTerminals?: boolean }): Promise<void>;
  getListenTarget(): ListenTarget | null;
}

export interface JAgentDeskDaemonDependencies {
  hostCapabilities?: HostCapabilityService;
  botsTriggerSource?: BotTriggerSource;
  slackApiBaseUrl?: string;
  /** Test seams for the bot connectors (spec 37.10–37.12); production runs `gh`, `glab` and api.telegram.org. */
  telegramApiBaseUrl?: string;
  botsGh?: ForgeCli;
  botsGlab?: ForgeCli;
  sessionShareTunnelManager?: TunnelManager;
  builtinPlugins?: BuiltinPluginLoader;
  hubRelationshipRemote?: HubRelationshipRemote;
  hubRelationshipClock?: HubRelationshipClock;
  hubRelationshipRetryPolicy?: HubRelationshipRetryPolicy;
  createHubDaemonId?: () => string;
  serverFeatureOverrides?: {
    daemonStatusRpc?: boolean;
  };
}

function createBootstrapManagedProcessRegistry(
  config: Pick<JAgentDeskDaemonConfig, "jagentdeskHome" | "managedProcesses">,
  logger: Logger,
): ManagedProcessRegistry {
  if (config.managedProcesses) {
    return config.managedProcesses;
  }

  return createManagedProcessRegistry({
    jagentdeskHome: config.jagentdeskHome,
    processTable: createSystemManagedProcessTable(),
    terminateProcess: terminateWithTreeKill,
    logger,
  });
}

async function reconcileManagedProcessLedger(
  managedProcesses: ManagedProcessRegistry,
  logger: Logger,
): Promise<void> {
  const reapResult = await managedProcesses.reapStale();
  if (reapResult.checked > 0 || reapResult.errors.length > 0) {
    logger.info(reapResult, "Managed helper process ledger reconciled");
  }
}

function mountWebUi(
  app: express.Application,
  config: JAgentDeskDaemonConfig,
  logger: Logger,
): void {
  app.use(
    createWebUiMiddleware({
      enabled: config.webUi?.enabled ?? false,
      distDir: config.webUi?.distDir ?? null,
      label: getHostName(),
      logger,
    }),
  );
}

function resolveExpressTrustProxySetting(config: JAgentDeskDaemonConfig): true | string[] {
  return config.trustedProxies ?? ["loopback"];
}

function createInitialRelayConfig(config: JAgentDeskDaemonConfig): MutableDaemonConfig["relay"] {
  return {
    enabled: config.relayEnabled ?? true,
    endpoint: config.relayEndpoint ?? DEFAULT_RELAY_ENDPOINT,
    useTls: config.relayUseTls ?? true,
  };
}

function createInitialMutableDaemonConfig(config: JAgentDeskDaemonConfig): MutableDaemonConfig {
  const providers: MutableDaemonConfig["providers"] = Object.fromEntries(
    Object.entries(config.providerOverrides ?? {}).map(([providerId, override]) => {
      const providerConfig: MutableDaemonConfig["providers"][string] = {};
      if (override.enabled !== undefined) {
        providerConfig.enabled = override.enabled;
      }
      if (override.jagentdeskTools) providerConfig.jagentdeskTools = override.jagentdeskTools;
      if (override.additionalModels) {
        providerConfig.additionalModels = override.additionalModels;
      }
      return [providerId, providerConfig];
    }),
  );

  const initialConfig: MutableDaemonConfig = {
    mcp: { injectIntoAgents: config.mcpInjectIntoAgents ?? true },
    browserTools: {
      enabled: config.browserToolsEnabled ?? false,
      ...(config.browserFingerprintProfiles ? { profiles: config.browserFingerprintProfiles } : {}),
      ...(config.browserActiveProfileId !== undefined
        ? { activeProfileId: config.browserActiveProfileId }
        : {}),
    },
    autorun: { enabled: config.autorunEnabled ?? false },
    sessionSharing: { enabled: config.sessionSharingEnabled ?? false },
    relay: createInitialRelayConfig(config),
    providers,
    metadataGeneration: {
      providers: config.metadataGeneration?.providers ?? [],
    },
    autoArchiveAfterMerge: config.autoArchiveAfterMerge ?? false,
    enableTerminalAgentHooks: config.enableTerminalAgentHooks ?? false,
    idleRuntimeCleanup: config.idleRuntimeCleanup !== false,
    appendSystemPrompt: config.appendSystemPrompt ?? "",
    resumeOnStartup: config.resumeOnStartup === true,
    resumePrompt: config.resumePrompt ?? "Resume working.",
    operatorContext: config.operatorContext ?? "",
    jira: { hideProviderConnectors: config.hideProviderJiraConnectors !== false },
    orchestration: config.orchestration ?? createDefaultOrchestrationConfig(),
    ...continuityConfigFromStartup(config),
  };

  if (config.terminalProfiles !== undefined) {
    initialConfig.terminalProfiles = config.terminalProfiles;
  }
  if (config.builtinPlugins !== undefined) initialConfig.builtinPlugins = config.builtinPlugins;
  if (config.pluginsEnabled !== undefined) initialConfig.pluginsEnabled = config.pluginsEnabled;
  if (config.plugins !== undefined) initialConfig.plugins = config.plugins;

  return initialConfig;
}

// oxlint-disable-next-line complexity
export async function createJAgentDeskDaemon(
  config: JAgentDeskDaemonConfig,
  rootLogger: Logger,
  dependencies: JAgentDeskDaemonDependencies = {},
): Promise<JAgentDeskDaemon> {
  // Start hardware detection at the beginning of bootstrap so it overlaps with disk/registry init
  // and does not hold up the listener when probes are slow.
  const hostMachineKindReady = primeHostMachineKind();
  configureGitProcessPolicy(config.git ?? resolveGitProcessPolicy({ env: process.env }));
  const logger = rootLogger.child({ module: "bootstrap" });
  // Recover the user's real PATH before any provider CLI discovery runs. A
  // GUI-launched daemon otherwise inherits a minimal PATH and reports every
  // provider as "unavailable" even when the CLIs are installed.
  await enrichProcessPath(logger);
  const bootstrapStart = performance.now();
  const elapsed = () => `${(performance.now() - bootstrapStart).toFixed(0)}ms`;
  const daemonVersion = config.daemonVersion ?? resolveDaemonVersion(import.meta.url);
  const speechService = createSpeechService({
    logger,
    openaiConfig: config.openai,
    speechConfig: config.speech,
  });
  const daemonConfigStore = new DaemonConfigStore(
    config.jagentdeskHome,
    createInitialMutableDaemonConfig(config),
    logger,
    {
      speech: createSpeechSettingsOwner({
        jagentdeskHome: config.jagentdeskHome,
        env: process.env,
        speechService,
      }),
    },
  );
  const browserToolsBroker = new BrowserToolsBroker({});
  // Built-ins load independently of the user-plugin switch. Managed git sources
  // back marketplace installs and are rebranded before compilation.
  const pluginRuntime = new PluginService(logger, daemonConfigStore, daemonVersion, {
    resolveUsageLaunch: (provider) => providerSnapshotManager.resolveUsageLaunch(provider),
    usageAgents: {
      hasAgent: (id) => agentManager.getAgent(id) !== null,
      usageSession: (id) => agentManager.usageSession(id),
      resolveLaunch: (provider) => providerSnapshotManager.resolveUsageLaunch(provider),
      isProviderActive: (provider, options) =>
        providerSnapshotManager.isProviderActiveForUsage(provider, options),
    },
    builtinPlugins: dependencies.builtinPlugins ?? new BuiltinPluginLoader(),
    managedSources: new ManagedPluginSources(config.jagentdeskHome),
    settingsDirectory: path.join(config.jagentdeskHome, "plugin-settings"),
  });

  const serverId = getOrCreateServerId(config.jagentdeskHome, { logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(config.jagentdeskHome, logger);
  const pairedDevices: PairedDeviceStore = createPairedDeviceStore({
    jagentdeskHome: config.jagentdeskHome,
    logger,
  });
  // The desktop app owns one device key for its own tailnet connection. It is
  // passed through the supervisor as a public key only; the private key never
  // enters the daemon process. Registering this local owner key at bootstrap
  // lets the desktop use the same signed tailnet handshake as mobile without
  // weakening the six-digit gate for every other device.
  const desktopDevicePublicKeyB64 = process.env.JAGENTDESK_DESKTOP_DEVICE_PUBLIC_KEY?.trim();
  if (
    desktopDevicePublicKeyB64 &&
    Buffer.from(desktopDevicePublicKeyB64, "base64").byteLength === 32 &&
    !pairedDevices.isPaired(desktopDevicePublicKeyB64)
  ) {
    try {
      pairedDevices.register({
        devicePublicKeyB64: desktopDevicePublicKeyB64,
        deviceName: "JAgentDesk Desktop",
      });
    } catch (error) {
      logger.warn({ err: error }, "Failed to register the desktop owner device");
    }
  }
  const nonceChallenges: NonceChallengeManager = createNonceChallengeManager({ logger });
  const pairingCodeManager: PairingCodeManager = createPairingCodeManager();
  // ADR-0010: when enabled, direct/loopback connections must also present a
  // signed hello from a paired device. Off by default so a daemon whose only
  // trusted device has not bootstrapped yet keeps local control; flipping it on
  // requires every local client (CLI included) to be a paired device.
  const requireSignedHelloForDirect =
    process.env.JAGENTDESK_REQUIRE_LOCAL_PAIRING === "1" ||
    process.env.JAGENTDESK_REQUIRE_LOCAL_PAIRING === "true";
  const managedProcesses = createBootstrapManagedProcessRegistry(config, logger);
  // Reconcile the helper-process ledger in the background so it never blocks the
  // daemon from coming up; terminating a live leftover can take a few seconds.
  // Best-effort, so a failure is logged here rather than crashing startup.
  void reconcileManagedProcessLedger(managedProcesses, logger).catch((error) => {
    logger.warn({ err: error }, "Failed to reconcile managed helper process ledger");
  });
  let tsnetListener: TsnetListener | null = null;
  let remoteFinishSubscriptions: RemoteFinishSubscriptions | null = null;
  let relayRuntime: RelayRuntime | null = null;

  const staticDir = config.staticDir;
  const downloadTokenTtlMs = config.downloadTokenTtlMs ?? 60000;

  const downloadTokenStore = new DownloadTokenStore({
    ttlMs: downloadTokenTtlMs,
  });

  // Capability token authenticating the daemon's own agents to the loopback
  // Agent MCP endpoint (/mcp/agents). Random per daemon run, injected only into
  // local agent configs and the daemon's own MCP client — never sent to remote
  // clients — so it cannot be replayed off-box. This lets the injected MCP
  // authenticate even when the daemon password is set via the app (hash only,
  // no plaintext available). Mirrors the /api/files/download capability-token
  // pattern.
  const agentMcpAuthToken = randomUUID();

  const listenTarget = parseListenString(config.listen);

  const app = express();
  app.set("trust proxy", resolveExpressTrustProxySetting(config));
  let boundListenTarget: ListenTarget | null = null;
  let workspaceRegistry: FileBackedWorkspaceRegistry | null = null;
  // SSH servers (spec 25 / ADR-0027): storage under <home>/ssh, secrets in its encrypted
  // store, prompts + connection state fan out to every connected client (wsServer is
  // late-bound). SSH terminals live in this process, outside the terminal worker: the
  // composite manager resolves SSH ids against the service first and delegates
  // everything else to the worker manager, so every existing terminal RPC (subscribe,
  // input, resize, capture, kill, rename) drives SSH sessions unchanged.
  const sshService = new SshService({
    jagentdeskHome: config.jagentdeskHome,
    logger,
    broadcast: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
    // Spec 33.2: via:"tailnet" servers dial the first hop through the bridge's
    // loopback SOCKS5 (tsnetListener is created later, the accessor is late-bound
    // and re-read on every connect attempt).
    tailnetSocks: () => tsnetListener?.getTailnetSocks() ?? null,
  });
  const localTerminalManager = await startWorkerTerminalManager({
    jagentdeskHome: config.jagentdeskHome,
    jagentdeskVersion: daemonVersion,
    logger,
    getTerminalActivityUrl: () => createTerminalActivityUrl(boundListenTarget),
  });
  // SSH terminals run on the remote host, where a plugin's launch wrap does not exist; only local
  // terminals run through terminal.create.before.
  const terminalManager = createSshTerminalManager(
    withTerminalCreateHook(localTerminalManager, pluginRuntime),
    () => sshService,
  );
  applyTerminalAgentHookSetting({ store: daemonConfigStore, logger });

  const serviceProxyPublicBaseUrl = config.serviceProxy?.publicBaseUrl
    ? config.serviceProxy.publicBaseUrl
    : null;
  const serviceProxy = createServiceProxySubsystem({
    logger,
    publicBaseUrl: serviceProxyPublicBaseUrl,
  });
  const scriptRuntimeStore = new WorkspaceScriptRuntimeStore();
  const configuredHostnames = config.hostnames ?? config.allowedHosts;
  let wsServer: VoiceAssistantWebSocketServer | null = null;
  let serviceProxyListenTarget: ListenTarget | null = null;
  const scriptHealthMonitor = new ScriptHealthMonitor({
    serviceProxy,
    onChange: createScriptStatusEmitter({
      sessions: () =>
        wsServer?.listTrustedSessions().map((session) => ({
          emit: (message) => session.emitServerMessage(message),
        })) ?? [],
      serviceProxy,
      runtimeStore: scriptRuntimeStore,
      daemonPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      resolveWorkspaceDirectory: async (workspaceId) =>
        (await workspaceRegistry?.get(workspaceId))?.cwd ?? null,
      logger,
      serviceProxyPublicBaseUrl,
    }),
  });
  const handleBranchChange = createBranchChangeRouteHandler({
    serviceProxy,
    onRoutesChanged: (workspaceId) => {
      scriptHealthMonitor.invalidateWorkspace(workspaceId);
    },
    logger,
  });

  // Service proxy classifies service hosts before daemon auth/route fallthrough.
  // Registered service hosts proxy directly; known service namespaces without a
  // route return 404 and never reach daemon APIs.
  app.use(serviceProxy.middleware());

  // Host allowlist / DNS rebinding protection (vite-like semantics).
  // For non-TCP (unix sockets), skip host validation.
  if (listenTarget.type === "tcp") {
    app.use((req, res, next) => {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isHostnameAllowed(hostHeader, configuredHostnames)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
  }

  // CORS - allow same-origin + configured origins
  const allowedOrigins = new Set([
    ...config.corsAllowedOrigins,
    // Packaged JAgentDesk renderers use the custom application scheme. The
    // Electron WebSocket includes this Origin during the direct desktop
    // health probe, so it must be accepted by the daemon's upgrade guard.
    "jagentdesk://app",
    ...(config.appBaseUrl?.trim() ? [config.appBaseUrl.trim()] : []),
    // For TCP, add localhost variants
    ...(listenTarget.type === "tcp"
      ? [
          `http://${listenTarget.host}:${listenTarget.port}`,
          `http://localhost:${listenTarget.port}`,
          `http://127.0.0.1:${listenTarget.port}`,
        ]
      : []),
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isDaemonOriginAllowed(origin, req.headers.host ?? null, allowedOrigins)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // Local, harmless, and token-gated; deliberately skips daemon auth.
  app.post(
    "/api/terminal-activity",
    express.json(),
    createTerminalActivityRouteHandler(terminalManager),
  );

  // Spec 04 §27b item 3b: the agent shims (`open`, `xdg-open`, BROWSER) post web targets here and
  // the in-app tab loads opened local files from the file route. Loopback only; the open route
  // takes the per-run agent token, the file route an unguessable per-directory token.
  const agentFileShares = new AgentFileShares();
  app.post(
    AGENT_BROWSER_OPEN_ROUTE,
    express.json(),
    createAgentBrowserOpenRouteHandler({
      token: agentMcpAuthToken,
      resolveAgent: (agentId) => {
        const agent = agentManager.getAgent(agentId);
        return agent ? { cwd: agent.cwd, workspaceId: agent.workspaceId ?? null } : null;
      },
      execute: (input) => browserToolsBroker.execute(input),
      shares: agentFileShares,
      baseUrl: () => createLoopbackBaseUrl(boundListenTarget),
      logger,
    }),
  );
  app.use(AGENT_FILES_ROUTE, createAgentFilesRouteHandler(agentFileShares));

  // Serve the bundled browser web UI when enabled. Mounted after service-proxy
  // classification and host/CORS handling, but before daemon bearer auth, so
  // static app files load without the daemon password while API/WebSocket calls
  // remain protected.
  mountWebUi(app, config, logger);

  app.use(
    createRequireBearerMiddleware(config.auth, (context) => {
      logger.warn(context, "Rejected HTTP request with invalid daemon password");
    }),
  );

  app.use(express.json());

  // Serve static files from public directory
  app.use("/public", express.static(staticDir));

  // Health check endpoint
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/status", (_req, res) => {
    const machineKind = getCachedHostMachineKind();
    res.json({
      status: "server_info",
      serverId,
      hostname: getHostName(),
      version: daemonVersion,
      ...(machineKind ? { machineKind } : {}),
      listen: formatListenTarget(boundListenTarget ?? listenTarget),
    });
  });

  const handleFileDownload = async (req: express.Request, res: express.Response): Promise<void> => {
    const token =
      typeof req.query.token === "string" && req.query.token.trim().length > 0
        ? req.query.token.trim()
        : null;

    if (!token) {
      res.status(400).json({ error: "Missing download token" });
      return;
    }

    const entry = downloadTokenStore.consumeToken(token);
    if (!entry) {
      res.status(403).json({ error: "Invalid or expired token" });
      return;
    }

    let fileHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      fileHandle = await open(entry.absolutePath, DOWNLOAD_OPEN_FLAGS);
      const fileStats = await fileHandle.stat();
      if (res.destroyed) {
        return;
      }
      if (!fileStats.isFile()) {
        res.status(404).json({ error: "File not found" });
        return;
      }

      res.setHeader("Content-Type", entry.mimeType);
      res.setHeader("Content-Disposition", formatAttachmentContentDisposition(entry.fileName));
      res.setHeader("Content-Length", fileStats.size.toString());

      const stream = fileHandle.createReadStream();
      fileHandle = null;
      res.once("close", () => stream.destroy());
      stream.on("error", (err) => {
        logger.error({ err }, "Failed to stream download");
        if (!res.headersSent) {
          res.status(500).json({ error: "Failed to read file" });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      logger.error({ err }, "Failed to download file");
      if (!res.headersSent) {
        res.status(404).json({ error: "File not found" });
      }
    } finally {
      await fileHandle?.close().catch(() => undefined);
    }
  };

  app.get("/api/files/download", (req, res) => {
    void handleFileDownload(req, res);
  });

  const httpServer = createHTTPServer(app);

  // Script proxy WebSocket upgrade handler — must be registered before the
  // VoiceAssistantWebSocketServer attaches its own "upgrade" listener so that
  // script-bound upgrades are forwarded first. The handler is a no-op for
  // requests that don't match a registered script route.
  httpServer.on("upgrade", serviceProxy.upgradeHandler({ passthroughUnknown: true }));

  if (config.serviceProxy?.standaloneListen) {
    serviceProxyListenTarget = parseListenString(config.serviceProxy.standaloneListen);
  }

  const agentStorage = new AgentStorage(config.agentStoragePath, logger);
  const projectRegistry = new FileBackedProjectRegistry(
    path.join(config.jagentdeskHome, "projects", "projects.json"),
    logger,
  );
  workspaceRegistry = new FileBackedWorkspaceRegistry(
    path.join(config.jagentdeskHome, "projects", "workspaces.json"),
    logger,
  );
  const chatService = new FileBackedChatService({
    jagentdeskHome: config.jagentdeskHome,
    logger,
  });
  const github = createGitHubService();
  const forgeResolver = createForgeResolver({
    createService: (forge) => (forge === "github" ? github : createForgeService(forge)),
  });
  const workspaceGitService = new WorkspaceGitServiceImpl({
    logger,
    jagentdeskHome: config.jagentdeskHome,
    worktreesRoot: config.worktreesRoot,
    deps: {
      forgeResolver,
    },
  });
  workspaceRegistry.subscribeToMutations((mutation) => {
    if (mutation.kind === "archive" && mutation.workspace)
      pluginRuntime.emit("workspace.archive.after", {
        workspace: describeHookWorkspace(mutation.workspace),
      });
  });
  const workspaceRuntimeStore = createWorkspaceRuntimeStore();
  const workspaceArchiveOperations = new WorkspaceArchiveOperations();
  workspaceGitService.onSnapshotUpdated((snapshot) => workspaceRuntimeStore.set(snapshot));
  workspaceRegistry.subscribeToMutations(async (mutation) => {
    if (mutation.kind === "remove" && mutation.workspace) {
      const cwd = path.resolve(mutation.workspace.cwd);
      const workspaces = await workspaceRegistry.list();
      const hasActiveWorkspace = workspaces.some(
        (workspace) => !workspace.archivedAt && path.resolve(workspace.cwd) === cwd,
      );
      if (!hasActiveWorkspace) workspaceRuntimeStore.remove(cwd);
    }
  });
  const workspaceProvisioning = createWorkspaceProvisioningService({
    lifecycle: pluginRuntime,
    unarchiveWorkspaceAgents: (request) =>
      unarchiveWorkspaceAgents({
        ...request,
        agentStorage,
        unarchiveAgent: (id) => unarchiveAgentState(agentStorage, agentManager, id),
        sessionLogger: logger,
      }),
    serverId,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  // Custom API providers (spec 34 / ADR-0047): config.json entries with an `api`
  // block, keys in the encrypted secret store, loopback forwards for tailnet/ssh
  // routes. reloadRegistry is late-bound to the snapshot manager + agent manager
  // consts below; it only fires after boot (save/delete from RPCs).
  const customProviderSecretStore = new FileSecretStore(
    path.join(config.jagentdeskHome, "custom-providers"),
  );
  let reloadProviderRegistry: (
    removeProviders: readonly string[],
    changedProviders: readonly string[],
  ) => Promise<void> = async () => {};
  const customProviderService = createCustomProviderService({
    jagentdeskHome: config.jagentdeskHome,
    logger,
    secretStore: customProviderSecretStore,
    getTailnetSocks: () => tsnetListener?.getTailnetSocks() ?? null,
    acquireSshClient: (acquireServerId) => sshService.acquireClient(acquireServerId),
    sshServerExists: (existsServerId) => sshService.storage.getServer(existsServerId) !== undefined,
    reloadRegistry: (removeProviders, changedProviders) =>
      reloadProviderRegistry(removeProviders, changedProviders),
  });
  // The OpenCode tool bridge gives OpenCode agents JAgentDesk's tools and, on servers that report
  // `features.mcpTools`, their own MCP servers without a server of their own (spec 33.7).
  const agentProviderRuntime = await createAgentProviderRuntime({
    jagentdeskHome: config.jagentdeskHome,
    logger,
    snapshotManager: {
      backgroundRefresh: { intervalMs: PROVIDER_BACKGROUND_REFRESH_INTERVAL_MS },
      runtimeSettings: config.agentProviderSettings,
      providerOverrides: config.providerOverrides,
      workspaceGitService,
      managedProcesses,
      isDev: config.isDev === true,
      extraClients: config.agentClients,
      openCodeProviderInjection: (providerId) =>
        customProviderService.materializeOpenCodeProvider(providerId),
      claudeSpawnEnv: (providerId) => customProviderService.materializeClaudeEnv(providerId),
      checkApiProviderEndpoint: (providerId) => customProviderService.checkEndpoint(providerId),
    },
  });
  const providerSnapshotManager = agentProviderRuntime.snapshotManager;
  const initialAgentManagerState = providerSnapshotManager.getAgentManagerProviderState();
  const timelineSnapshots = new AgentTimelineSnapshots({
    directory: path.join(config.jagentdeskHome, "agent-timelines"),
    logger,
  });
  // Remaining quota per provider for failover and list_child_providers (spec 40 §4–§5).
  const providerQuota = new ProviderQuotaTracker(new ProviderUsageService({ logger }));
  const agentManager: AgentManager = new AgentManager({
    pluginLifecycle: pluginRuntime,
    timelineSnapshots,
    resolveContinuityConfig: () => {
      const current = daemonConfigStore.get();
      return {
        failover: current.agentFailover ?? FAILOVER_DISABLED,
        crossProviderChildren: current.crossProviderChildren ?? CROSS_PROVIDER_CHILDREN_DISABLED,
      };
    },
    isProviderUsageExhausted: (provider) => providerQuota.isExhausted(provider),
    resolveProviderQuota: async (provider) => {
      await providerQuota.refresh().catch(() => undefined);
      return providerQuota.quota(provider);
    },
    resolveProviderLabel: (provider) => providerSnapshotManager.getProviderLabel(provider),
    resolveModelContextWindow: async ({ provider, model }) =>
      resolveSnapshotContextWindow(providerSnapshotManager.getSnapshot(), provider, model),
    resolveJAgentDeskToolPolicy: (provider) =>
      resolveJAgentDeskToolPolicy(provider, daemonConfigStore.get().providers),
    pluginSessions: pluginRuntime,
    clients: initialAgentManagerState.clients,
    providerDefinitions: initialAgentManagerState.providerDefinitions,
    registry: agentStorage,
    appendSystemPrompt: config.appendSystemPrompt,
    operatorContext: config.operatorContext,
    onWorkspaceStateMayHaveChanged: ({ cwd }) => {
      workspaceGitService.onWorkspaceStateMayHaveChanged(cwd);
    },
    // Insights records billed turns; agents cannot run before the built-ins start.
    onUsageBilled: (billed) => builtinDaemon.port("usageHistory")?.record(billed),
    mcpAuthToken: agentMcpAuthToken,
    logger,
  });
  // Spec 04 §27b item 3b: shims first on every agent's PATH, BROWSER on the `.js` one.
  const agentShimDirectory = agentShimDir(config.jagentdeskHome);
  try {
    await installAgentBrowserShims({ dir: agentShimDirectory });
    agentManager.setAgentShimDir(agentShimDirectory);
  } catch (error) {
    logger.warn({ err: error }, "Could not install the agent browser shims");
  }

  // Spec 04 §27b.1: built-in tool groups are compared at the start of every turn.
  const builtinHostToolSet = createBuiltinHostToolSet({
    state: pluginRuntime.builtin,
    registry: builtinServerRegistry,
    launchHints: (ids) => builtinServerRegistry.launchHints(config.jagentdeskHome, ids),
  });
  agentManager.setHostToolSet(builtinHostToolSet.source);
  agentManager.setHideProviderConnectors(
    () => daemonConfigStore.get().jira?.hideProviderConnectors !== false,
  );
  agentManager.setProviderLabel((provider) => providerSnapshotManager.getProviderLabel(provider));

  const unsubscribeBuiltinAgentSnapshots = agentManager.subscribe(
    (event) => {
      if (event.type === "agent_state") pluginRuntime.builtin.forAgent(event.agent.id);
    },
    { replayState: false },
  );

  const unsubscribePluginProviders = pluginRuntime.subscribeProviderRegistrations(() => {
    agentManager.updateProviderRegistry(
      providerSnapshotManager.replacePluginProviders(pluginRuntime.getProviderRegistrations()),
    );
  });

  const detachAgentStoragePersistence = attachAgentStoragePersistence(
    logger,
    agentManager,
    agentStorage,
  );
  await agentStorage.initialize();
  // The host capability probe is created with the WebSocket server below and assigned there.
  let daemonHostCapabilities: HostCapabilityService | null = null;

  const restartRecovery = createRestartRecovery({
    storage: agentStorage,
    settings: () => ({
      enabled: daemonConfigStore.get().resumeOnStartup === true,
      prompt: daemonConfigStore.get().resumePrompt ?? "Resume working.",
    }),
    eligible: async (record) =>
      !record.workspaceId || !(await workspaceRegistry?.get(record.workspaceId))?.archivedAt,
    dispatch: (agentId, prompt) =>
      sendPromptToAgent({ agentId, prompt, agentManager, agentStorage, logger, unarchive: false }),
    report: (agentId, err) => logger.error({ agentId, err }, "Agent restart recovery failed"),
  });
  await restartRecovery.prepareStartup();
  // Failover resends the failed turn's message the way a user send does (spec 40 §4).
  agentManager.setFailoverResend(async (agentId, prompt) => {
    await sendPromptToAgent({
      agentId,
      prompt,
      agentManager,
      agentStorage,
      logger,
      messageId: randomUUID(),
    });
  });

  // Spec 34.6 hot reload: after a custom provider save/delete, re-read the
  // persisted config, rebuild the provider registry (base overrides replaced,
  // removed providers dropped) and swap it into the live agent manager. The
  // providers_snapshot_update broadcast happens via the snapshot "change" event.
  reloadProviderRegistry = async (removeProviders, changedProviders) => {
    const persisted = loadPersistedConfig(config.jagentdeskHome, logger);
    const baseOverrides = extractProviderOverrides(
      persisted.agents?.providers as Record<string, unknown> | undefined,
    );
    const nextAgentManagerState = providerSnapshotManager.applyMutableProviderConfig(undefined, {
      baseOverrides: baseOverrides ?? {},
      removeProviders,
      changedProviders,
    });
    agentManager.updateProviderRegistry(nextAgentManagerState);
  };
  logger.info({ elapsed: elapsed() }, "Agent storage initialized");
  // Reconcile after startup continuation admission so a running child is observed through its next finish.
  await restoreFinishSubscriptions({
    agentManager,
    store: FinishSubscriptionStore.forHome(config.jagentdeskHome, logger),
    reconcile: async (record, signal, subscriptionIds) => {
      await restartRecovery.waitForResume(record.childAgentId, signal);
      signal.throwIfAborted();
      await setupFinishNotification({
        agentManager,
        agentStorage,
        childAgentId: record.childAgentId,
        callerAgentId: record.callerAgentId,
        requireParentOwnership: record.requireParentOwnership,
        restoredSubscriptionId: record.id,
        restoredSubscriptionIds: subscriptionIds,
        restoredFollowingSince: record.followingSince,
        logger,
      }).ready;
    },
    isArchived: async (agentId) => Boolean((await agentStorage.get(agentId))?.archivedAt),
    logger,
  }).catch((error: unknown) => {
    logger.error({ err: error }, "Failed to restore finish subscriptions");
  });
  await bootstrapWorkspaceRegistries({
    serverId,
    jagentdeskHome: config.jagentdeskHome,
    agentStorage,
    projectRegistry,
    workspaceRegistry,
    workspaceGitService,
    logger,
  });
  logger.info({ elapsed: elapsed() }, "Workspace registries bootstrapped");
  const teardownArchivedWorkspaceRuntime = (workspaceId: string): void => {
    scriptRuntimeStore.removeForWorkspace(workspaceId);
    releaseWorkspaceServicePortPlan(workspaceId);
  };
  const workspaceReconciliation = new WorkspaceReconciliationService({
    serverId,
    projectRegistry,
    workspaceRegistry,
    logger,
    workspaceGitService,
    onProjectUpdate: (update) => wsServer?.publishProjectUpdate(update),
    onWorkspaceArchived: teardownArchivedWorkspaceRuntime,
    onWorkspacesChanged: async (workspaceIds) => {
      await fanOutReconciledWorkspaceUpdates({
        sessions: wsServer?.listTrustedSessions() ?? [],
        workspaceIds,
        logger,
      });
    },
  });
  await workspaceReconciliation.start();
  void workspaceReconciliation.reconcileNow().catch((error) => {
    logger.warn({ err: error }, "Initial workspace reconciliation failed");
  });
  await chatService.initialize();
  logger.info({ elapsed: elapsed() }, "Chat service initialized");
  const checkoutDiffManager = new CheckoutDiffManager({
    logger,
    jagentdeskHome: config.jagentdeskHome,
    workspaceGitService,
    workspaceRuntimeStore,
  });
  const archiveWorkspaceRecordExternal = async (
    workspaceId: string,
    context?: WorkspaceArchiveContext,
    archivedAt?: string,
  ) => {
    const existingWorkspace = await archivePersistedWorkspaceRecord({
      workspaceId,
      workspaceRegistry,
      context,
      archivedAt,
    });
    if (!existingWorkspace || existingWorkspace.archivedAt) return;
    teardownArchivedWorkspaceRuntime(workspaceId);
  };
  // external path→workspace adapter, not ownership: archive-by-path requests that
  // arrive with a worktree path and no workspaceId (old clients / CLI).
  const findWorkspaceIdForCwdExternal = async (cwd: string): Promise<string | null> => {
    return resolveWorkspaceIdForPath(cwd, await workspaceRegistry.list());
  };
  const ensureWorkspaceForCreateExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { background?: boolean; callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      cwd,
      resolveFirstAgentPromptTitle(firstAgentContext),
      undefined,
      context,
    );
    if (firstAgentContext) {
      workspaceAutoName.scheduleForDirectory({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        firstAgentContext,
      });
    }
    return workspace.workspaceId;
  };
  const listActiveWorkspacesExternal = async (): Promise<ActiveWorkspaceRef[]> => {
    const workspaces = await workspaceRegistry.list();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        worktreeRoot: workspace.worktreeRoot,
        isJAgentDeskOwnedWorktree: workspace.isJAgentDeskOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
        worktreeManagerPluginId: workspace.worktreeManagerPluginId,
        untrustedSource: workspace.untrustedSource,
      }));
  };
  const markWorkspaceArchiving = (workspaceIds: Iterable<string>, archivingAt: string) =>
    workspaceArchiveOperations.markArchiving(workspaceIds, archivingAt);
  const clearWorkspaceArchiving = (workspaceIds: Iterable<string>) =>
    workspaceArchiveOperations.clearArchiving(workspaceIds);
  const emitWorkspaceUpdatesExternal = async (workspaceIds: Iterable<string>) => {
    await wsServer?.publishWorkspaceUpdates(workspaceIds);
  };
  const ensureWorkspaceForCreateAndBroadcastExternal = async (
    cwd: string,
    firstAgentContext?: FirstAgentContext,
    context?: { background?: boolean; callerWorkspaceId?: string },
  ): Promise<string> => {
    const workspaceId = await ensureWorkspaceForCreateExternal(cwd, firstAgentContext, context);
    await emitWorkspaceUpdatesExternal([workspaceId]);
    return workspaceId;
  };
  const emitWorkspaceUpdateForCwdExternal = async (cwd: string) => {
    const workspaceIds = workspaceIdsOnCheckout(await workspaceRegistry.list(), cwd);
    await emitWorkspaceUpdatesExternal(workspaceIds);
  };
  const emitExternalSessionMessage = (message: SessionOutboundMessage) => {
    wsServer?.broadcast(wrapSessionMessage(message));
  };
  const workspaceAutoName = new WorkspaceAutoName({
    agentManager,
    workspaceRegistry,
    workspaceGitService,
    providerSnapshotManager,
    readDaemonConfig: () => ({ metadataGeneration: daemonConfigStore.get().metadataGeneration }),
    gitMutation: createGitMutationService({
      workspaceGitService,
      logger,
    }),
    emitWorkspaceUpdateForCwd: emitWorkspaceUpdateForCwdExternal,
    emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
      await emitWorkspaceUpdatesExternal([workspaceId]);
    },
    logger,
  });

  setupAutoArchiveOnMerge({
    lifecycle: pluginRuntime,
    jagentdeskHome: config.jagentdeskHome,
    jagentdeskWorktreesBaseRoot: config.worktreesRoot,
    worktreeManagers: pluginRuntime,
    workspaceArchiveOperations,
    daemonConfigStore,
    workspaceGitService,
    github,
    agentManager,
    agentStorage,
    terminalManager,
    logger,
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    getWorkspace: (workspaceId) => workspaceRegistry.get(workspaceId),
    assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
      assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
    isCheckoutUntrusted: (checkoutPath) => isCheckoutUntrusted(workspaceRegistry, checkoutPath),
    listActiveWorkspaces: listActiveWorkspacesExternal,
    getAutoArchivedChangeRequestUrl: async (workspaceId) =>
      (await workspaceRegistry.get(workspaceId))?.autoArchivedChangeRequestUrl ?? null,
    archiveWorkspaceRecord: archiveWorkspaceRecordExternal,
    markWorkspaceArchiving,
    clearWorkspaceArchiving,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
  });

  const createJAgentDeskWorktreeForTools = async (
    input: Parameters<typeof createJAgentDeskWorktreeWorkflow>[1],
    serviceOptions?: Parameters<typeof createJAgentDeskWorktreeWorkflow>[2],
  ) => {
    return createJAgentDeskWorktreeWorkflow(
      {
        lifecycle: pluginRuntime,
        jagentdeskHome: config.jagentdeskHome,
        worktreesRoot: config.worktreesRoot,
        createJAgentDeskWorktree: async (workflowInput, workflowOptions) => {
          return createRegisteredJAgentDeskWorktree(workflowInput, {
            lifecycle: pluginRuntime,
            worktreeManagers: pluginRuntime,
            github,
            ...(workflowOptions?.resolveDefaultBranch
              ? {
                  resolveDefaultBranch: workflowOptions.resolveDefaultBranch,
                }
              : {}),
            workspaceGitService,
            workspaceProvisioning,
          });
        },
        warmWorkspaceGitData: async (workspace) => {
          await Promise.all(
            wsServer
              ?.listTrustedSessions()
              .map((session) => session.warmWorkspaceGitDataForWorkspace(workspace)) ?? [],
          );
        },
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          workspaceAutoName.scheduleForWorktree(autoNameInput),
        emitWorkspaceUpdateForWorkspaceId: async (workspaceId) => {
          await emitWorkspaceUpdatesExternal([workspaceId]);
        },
        cacheWorkspaceSetupSnapshot: () => {},
        emit: emitExternalSessionMessage,
        sessionLogger: logger,
        terminalManager,
        serviceProxy,
        scriptRuntimeStore,
        getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
        getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
        serviceProxyPublicBaseUrl,
        onScriptsChanged: null,
      },
      input,
      serviceOptions,
    );
  };

  const createAgentCommandDependencies: CreateAgentCommandDependencies = {
    agentManager,
    agentStorage,
    logger,
    jagentdeskHome: config.jagentdeskHome,
    worktreesRoot: config.worktreesRoot,
    terminalManager,
    providerSnapshotManager,
    createJAgentDeskWorktree: createJAgentDeskWorktreeForTools,
    ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
  };
  const createAgent = (input: Parameters<typeof createAgentCommand>[1]) =>
    createAgentCommand(createAgentCommandDependencies, input);
  const archiveWorkspaceByIdExternal = (workspaceId: string, requestId: string) =>
    archiveByScope(
      {
        lifecycle: pluginRuntime,
        jagentdeskHome: config.jagentdeskHome,
        jagentdeskWorktreesBaseRoot: config.worktreesRoot,
        worktreeManagers: pluginRuntime,
        workspaceArchiveOperations,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        getWorkspace: (workspaceIdToRead) => workspaceRegistry.get(workspaceIdToRead),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        isCheckoutUntrusted: (checkoutPath) => isCheckoutUntrusted(workspaceRegistry, checkoutPath),
        listActiveWorkspaces: listActiveWorkspacesExternal,
        archiveWorkspaceRecord: (workspaceIdToArchive, archivedAt) =>
          archiveWorkspaceRecordExternal(workspaceIdToArchive, undefined, archivedAt),
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving,
        clearWorkspaceArchiving,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceIdToKill),
        sessionLogger: logger,
      },
      { scope: { kind: "workspace", workspaceId }, requestId },
    );
  const hubAgentLifecycle = new CreateAgentLifecycleDispatch({
    lifecycle: pluginRuntime,
    jagentdeskHome: config.jagentdeskHome,
    worktreesRoot: config.worktreesRoot,
    worktreeManagers: pluginRuntime,
    workspaceArchiveOperations,
    getWorkspace: (workspaceId) => workspaceRegistry.get(workspaceId),
    assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
      assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
    isCheckoutUntrusted: (checkoutPath) => isCheckoutUntrusted(workspaceRegistry, checkoutPath),
    agentManager,
    agentStorage,
    github,
    workspaceGitService,
    createJAgentDeskWorktreeWorkflow: createJAgentDeskWorktreeForTools,
    archiveAgentForClose: (agentId) =>
      archiveAgentCommand({ agentManager, agentStorage, logger }, agentId),
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: (workspaceId) => archiveWorkspaceRecordExternal(workspaceId),
    emit: emitExternalSessionMessage,
    emitAgentRemove: async () => undefined,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    markWorkspaceArchiving,
    clearWorkspaceArchiving,
    killTerminalsForWorkspace: (workspaceId) =>
      killTerminalsForWorkspace({ terminalManager, sessionLogger: logger }, workspaceId),
    logger,
  });
  const hubRelationships = new HubRelationshipController({
    jagentdeskHome: config.jagentdeskHome,
    serverId,
    daemonPublicKey: daemonKeyPair.publicKeyB64,
    logger,
    remote: dependencies.hubRelationshipRemote ?? new DirectHubRelationshipRemote(),
    clock: dependencies.hubRelationshipClock,
    retryPolicy: dependencies.hubRelationshipRetryPolicy,
    createDaemonId: dependencies.createHubDaemonId,
    attachSocket: async (socket, options) => {
      if (!wsServer) throw new Error("WebSocket server is not running");
      // The fork's hub session gate is scope-based (isSessionRpcAllowed); bridge
      // the v0.7.2 hub permissions to the equivalent scopes at attach time.
      await wsServer.attachHubSocket(socket, {
        daemonId: options.daemonId,
        scopes: hubScopesForPermissions(options.permissions),
        agents: options.agents,
      });
    },
    updateAttachedPermissions: (_principalId, _permissions) => {
      // Fork hub sessions carry static scopes assigned at attach time. JAgentDesk
      // is Tailscale-only (ADR-0001) and does not re-issue hub permissions on a
      // live session; a permission change tears the relationship down and
      // re-attaches. No in-place update is required.
    },
    createExecutionAgents: (daemonId) =>
      new DaemonExecutions({
        daemonId,
        agentManager,
        agentStorage,
        createAgent,
        interruptAgent: (agentId) => cancelAgentRunCommand({ agentManager, logger }, agentId),
        archiveAgent: (agentId) =>
          archiveAgentCommand({ agentManager, agentStorage, logger }, agentId),
        listActiveWorkspaces: listActiveWorkspacesExternal,
        archiveWorkspace: archiveWorkspaceByIdExternal,
        cleanupFailedCreate: (input) =>
          hubAgentLifecycle.cleanupCreatedWorktreeAfterFailedAgentCreate(input),
      }),
  });

  const loopService = new LoopService({
    jagentdeskHome: config.jagentdeskHome,
    logger,
    agentManager,
    createAgent,
    ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
  });
  await loopService.initialize();
  logger.info({ elapsed: elapsed() }, "Loop service initialized");
  const clusterRegistry = new ClusterRegistry({
    jagentdeskHome: config.jagentdeskHome,
    logger,
  });
  await clusterRegistry.initialize();
  logger.info("Cluster registry created");
  const databaseRegistry = new DatabaseRegistry({
    jagentdeskHome: config.jagentdeskHome,
    logger,
  });
  await databaseRegistry.initialize();
  logger.info("Database registry created");
  await sshService.initialize();
  // S3 forwarding, S6–S8 (logs, import, install key, environment, Docker / DB / k8s on the
  // server) and the server-chat agent tools ride on S1's pool. This owns the daemon's one
  // ForwardingService (forwarding.json + local listeners).
  const sshServerModules = new SshServerModules({
    sshService,
    jagentdeskHome: config.jagentdeskHome,
    logger,
  });
  await sshServerModules.initialize();
  sshService.modules = sshServerModules;
  // S2 SFTP, S3 forwarding RPCs (on the one ForwardingService above), S5 snippets, Telnet.
  const sshModules = new SshModules({
    ssh: sshService,
    jagentdeskHome: config.jagentdeskHome,
    logger,
    forwarding: sshServerModules.forwarding,
  });
  await sshModules.initialize();
  sshService.sessionModules = sshModules;
  logger.info("SSH service initialized");
  await removeRetiredFigmaData({ jagentdeskHome: config.jagentdeskHome, logger });
  const createScheduleLocalWorkspaceExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
      input.cwd,
      resolveFirstAgentPromptTitle(input.firstAgentContext),
    );
    workspaceAutoName.scheduleForDirectory({
      workspaceId: workspace.workspaceId,
      cwd: workspace.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
    return workspace;
  };
  const createScheduleJAgentDeskWorktreeExternal = async (input: {
    cwd: string;
    firstAgentContext: FirstAgentContext;
  }) => {
    const result = await createJAgentDeskWorktreeForTools({
      cwd: input.cwd,
      firstAgentContext: input.firstAgentContext,
    });
    await emitWorkspaceUpdatesExternal([result.workspace.workspaceId]);
    return result;
  };
  const archiveScheduleWorkspaceExternal = async (workspaceId: string) => {
    await archiveByScope(
      {
        lifecycle: pluginRuntime,
        jagentdeskHome: config.jagentdeskHome,
        jagentdeskWorktreesBaseRoot: config.worktreesRoot,
        worktreeManagers: pluginRuntime,
        workspaceArchiveOperations,
        github,
        workspaceGitService,
        agentManager,
        agentStorage,
        findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
        getWorkspace: (workspaceIdToRead) => workspaceRegistry.get(workspaceIdToRead),
        assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
          assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
        isCheckoutUntrusted: (checkoutPath) => isCheckoutUntrusted(workspaceRegistry, checkoutPath),
        listActiveWorkspaces: listActiveWorkspacesExternal,
        archiveWorkspaceRecord: (workspaceIdToArchive, archivedAt) =>
          archiveWorkspaceRecordExternal(workspaceIdToArchive, undefined, archivedAt),
        emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
        markWorkspaceArchiving,
        clearWorkspaceArchiving,
        killTerminalsForWorkspace: (workspaceIdToKill) =>
          killTerminalsForWorkspace(
            {
              terminalManager,
              sessionLogger: logger,
            },
            workspaceIdToKill,
          ),
        sessionLogger: logger,
      },
      {
        scope: { kind: "workspace", workspaceId },
        requestId: "schedule-run-finish",
      },
    );
  };
  const scheduleService = new ScheduleService({
    jagentdeskHome: config.jagentdeskHome,
    logger,
    agentManager,
    agentStorage,
    createAgent,
    createDirectoryWorkspace: createScheduleLocalWorkspaceExternal,
    createJAgentDeskWorktreeWorkspace: createScheduleJAgentDeskWorktreeExternal,
    archiveWorkspace: archiveScheduleWorkspaceExternal,
  });
  await scheduleService.start();
  const changeRequestWatches = createChangeRequestWatches({
    router: createChangeRequestRouter({ forgeResolver }),
    backgroundWork: agentManager,
    jagentdeskHome: config.jagentdeskHome,
    logger,
    isActive: async (agentId) => {
      const record = await agentStorage.get(agentId);
      return record ? !record.archivedAt : Boolean(agentManager.getAgent(agentId));
    },
    messages: () => getAgentMessageDelivery({ agentManager, agentStorage, logger }),
  });

  agentManager.setAgentArchivedCallback(async (agentId) => {
    await changeRequestWatches.archive(agentId);
    try {
      await scheduleService.completeForAgent(agentId);
    } catch (error) {
      logger.warn({ err: error, agentId }, "Failed to complete schedules for archived agent");
    }
  });
  logger.info({ elapsed: elapsed() }, "Schedule service initialized");
  // Statically linked features start after the shared libraries they consume and the agent
  // manager exist: they subscribe to agent events and reach clients through the WebSocket server
  // once it is bound.
  const builtinServices = createBuiltinCoreServices(
    config.jagentdeskHome,
    logger,
    daemonConfigStore,
    { clusters: clusterRegistry, databases: databaseRegistry },
    {
      ssh: sshService,
      agents: {
        labels: (agentId) => agentManager.getAgent(agentId)?.labels ?? null,
        cwd: (agentId) => agentManager.getAgent(agentId)?.cwd ?? null,
        requestHostToolPermission: (agentId, request) =>
          agentManager.requestHostToolPermission(agentId, request),
      },
      customProviders: customProviderService,
      closeCustomProviderForwards: () => customProviderService.closeAll(),
      beforeSshStop: () => customProviderService.closeAll(),
      daemonId: serverId,
      broadcastToTrustedSessions: (message) => {
        for (const session of wsServer?.listTrustedSessions() ?? []) {
          session.emitServerMessage(message);
        }
      },
    },
    {
      subscribeAgentEvents: (callback) => agentManager.subscribe(callback, { replayState: false }),
      broadcast: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
      pushNotification: (notice) => wsServer?.sendSideloadPush(notice),
    },
  );
  // Built-in features' daemon services, ports, and background lifecycles (docs/builtin-plugins.md).
  // After storage loads (Insights seeds its lifetime baseline from stored agents) and before the
  // persisted agents load: agents cannot run before the built-ins start.
  const builtinDaemon = await builtinServerRegistry.start(pluginRuntime.builtin, builtinServices, {
    agentManager,
    agentStorage,
    broadcast: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
    hostCapabilities: () => daemonHostCapabilities,
    sendPush: (notice) => wsServer?.sendBuiltinPush(notice),
    sessionShare: {
      tunnelManager: dependencies.sessionShareTunnelManager ?? new TunnelManager(logger),
      appDistDir:
        config.sessionShareAppDistDir ??
        process.env.JAGENTDESK_SHARE_APP_DIST ??
        resolveBundledShareAppDist(),
      // Session-share guests (ADR-0019): the scoped ShareServer /ws hands validated guest
      // sockets to the daemon as agent-confined real sessions.
      attachGuestSocket: (ws, params) => wsServer?.attachGuestSocket(ws, params),
      // A live capability toggle re-scopes already-connected guest sessions (ADR-0019).
      updateGuestScopes: (agentId, scopes) => wsServer?.updateGuestScopesForAgent(agentId, scopes),
    },
    projects: createBuiltinProjectAccess({
      projectRegistry,
      workspaceRegistry,
      workspaceIdOf: async (agentId) =>
        agentManager.getAgent(agentId)?.workspaceId ??
        (await agentStorage.get(agentId))?.workspaceId,
      cwdOf: async (agentId) =>
        agentManager.getAgent(agentId)?.cwd ?? (await agentStorage.get(agentId))?.cwd,
    }),
  });
  pluginRuntime.builtinDaemon = builtinDaemon;
  // Spec 42: durable agent context reads its switches and lessons through the Memory port.
  agentManager.setDurableContextPorts({
    settings: () => builtinDaemon.port("memory")?.durableSettings(),
    memory: () => builtinDaemon.enabledPort("memory"),
  });
  // Spec mode's launch environment (spec 28): the provider process sees the shared checkout env.
  agentManager.setLaunchEnvProvider(
    (agentId) => builtinDaemon.enabledPort("specMode")?.launchEnv(agentId) ?? null,
  );
  logger.info({ elapsed: elapsed() }, "Loading persisted agent registry");
  const persistedRecords = await agentStorage.list();
  logger.info(
    { elapsed: elapsed() },
    `Agent registry loaded (${persistedRecords.length} record${persistedRecords.length === 1 ? "" : "s"}); agents will initialize on demand`,
  );
  logger.info(
    "Voice mode configured for agent-scoped resume flow (no dedicated voice assistant provider)",
  );
  logger.info({ elapsed: elapsed() }, "Preparing voice and MCP runtime");

  const orchestrationRuntime = new OrchestrationRuntime({
    jagentdeskHome: config.jagentdeskHome,
    agentManager,
    agentStorage,
    providerSnapshotManager,
    getConfig: () => daemonConfigStore.get().orchestration,
    logger,
  });

  const botStorage = new BotStorage(config.jagentdeskHome);
  const botRuntime = new DaemonBotRuntime({
    agentManager,
    providerSnapshotManager,
    orchestration: orchestrationRuntime,
    storage: botStorage,
    createWorktree: createJAgentDeskWorktreeForTools,
    logger,
    describeHost: async () => {
      const [projects, workspaces] = await Promise.all([
        projectRegistry.list(),
        workspaceRegistry?.list() ?? Promise.resolve([]),
      ]);
      return {
        projects: projects
          .filter(
            (project) => !project.archivedAt && !project.rootPath.startsWith(botStorage.botsRoot),
          )
          .map((project) => project.customName ?? project.displayName),
        workspaces: workspaces
          .filter((workspace) => !workspace.archivedAt)
          .map((workspace) => ({
            workspaceId: workspace.workspaceId,
            title: workspace.title ?? workspace.displayName,
          })),
      };
    },
    openPullRequests: () => countOwnOpenPullRequests(),
    create: {
      agentManager,
      agentStorage,
      providerSnapshotManager,
      logger,
      jagentdeskHome: config.jagentdeskHome,
      ensureWorkspaceForCreate: ensureWorkspaceForCreateAndBroadcastExternal,
    },
  });
  const botsService = new BotsService(botStorage, botRuntime, {
    logger,
    triggers:
      dependencies.botsTriggerSource ??
      new LocalBotTriggers({
        storage: botStorage,
        sources: () =>
          builtinServerRegistry.botTriggerSources(pluginRuntime.builtin, config.jagentdeskHome),
        logger,
      }),
    push: { send: (payload) => wsServer?.sendBotPush(payload) ?? Promise.resolve() },
    recordNotice: (notice) => wsServer?.recordBotNotification(notice),
  });
  const botsRelay = () => ({
    ...(relayRuntime?.getConfig() ?? {
      enabled: config.relayEnabled ?? true,
      endpoint: config.relayEndpoint ?? DEFAULT_RELAY_ENDPOINT,
      useTls: config.relayUseTls ?? true,
    }),
    serverId,
  });
  // One store for every bots secret: each FileSecretStore serializes its own writes only.
  const botsSecrets = new FileSecretStore(path.join(botStorage.home, "bots"));
  const botsSlack = new BotsSlack(botsService, {
    logger,
    relay: botsRelay,
    secrets: botsSecrets,
    apiBaseUrl: dependencies.slackApiBaseUrl,
  });
  botsService.slack = botsSlack;
  // Shares botsRelay and botsSecrets with Slack: two FileSecretStores on one file lose writes.
  const botsHooks = new BotsHookConnectors(botsService, botsSlack, {
    logger,
    relay: botsRelay,
    secrets: botsSecrets,
    telegramApiBaseUrl: dependencies.telegramApiBaseUrl,
    gh: dependencies.botsGh,
    glab: dependencies.botsGlab,
  });
  botsService.hooks = botsHooks;
  const botsSharing = new BotsSharing(botsService, {
    logger: logger.child({ module: "bots-sharing" }),
    relay: botsRelay,
    secrets: botsSecrets,
  });
  botsService.sharing = botsSharing;
  // A bot's automations are core schedules (spec 37.2.6): the bots service runs them.
  botsService.schedules = scheduleService;
  scheduleService.setBotLauncher(botsService.scheduleLauncher());
  let botsRuntimeReady = false;
  await pluginRuntime.builtin.registerLifecycle("bots", {
    start: () => {
      if (botsRuntimeReady) {
        botsService.start();
        botsSlack.start();
        botsHooks.start();
      }
    },
    stop: () => {
      botsService.stop();
      botsSlack.stop();
      botsHooks.stop();
    },
  });

  const idleRuntimeCleanup = createIdleRuntimeCleanup({
    enabled: daemonConfigStore.get().idleRuntimeCleanup !== false,
    runtimes: () => agentManager.getRuntimeCleanupCandidates(),
    isProtected: (agentId) =>
      hasOutstandingFinishSubscriptions(agentManager, agentId) ||
      getAgentMessageDelivery({ agentManager, agentStorage, logger }).hasPending(agentId),
    logger,
  });

  const unsubscribeIdleRuntimeCleanup = connectIdleRuntimeCleanupConfig(
    daemonConfigStore,
    idleRuntimeCleanup,
  );

  const createAgentToolHostDependencies = (
    runtime: JAgentDeskToolRuntimeContext,
  ): JAgentDeskToolHostDependencies => ({
    changeRequestWatches,
    daemonConfigStore,
    builtinPlugins: pluginRuntime.builtin.forAgent(runtime.callerAgentId),
    builtinDaemon,
    callerAgentLabels: runtime.callerAgentLabels,
    jagentdeskToolPolicy: isBotBackgroundRun(
      runtime.callerAgentId ? agentManager.getAgent(runtime.callerAgentId)?.labels : undefined,
      runtime.callerAgentLabels,
    )
      ? // Look around and Tidy memory get no JAgentDesk tools at all (spec 37.2.6, ADR-0046).
        { enabled: false }
      : (runtime.jagentdeskToolPolicy ??
        (runtime.callerAgentId
          ? agentManager.getJAgentDeskToolPolicy(runtime.callerAgentId)
          : undefined)),
    serverId,
    remoteFinishSubscriptions: () => {
      if (!remoteFinishSubscriptions) throw new Error("Remote finish observation unavailable");
      return remoteFinishSubscriptions;
    },
    hosts: () => {
      if (!wsServer) throw new Error("Daemon is not accepting host operations");
      return wsServer.toolHosts();
    },
    agentManager,
    agentStorage,
    terminalManager,
    getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
    scheduleService,
    providerSnapshotManager,
    github,
    workspaceGitService,
    worktreeManagers: pluginRuntime,
    workspaceArchiveOperations,
    assertWorkspaceAutomationAllowed: (guardedWorkspaceId) =>
      assertWorkspaceAutomationAllowedForWorkspace(workspaceRegistry, guardedWorkspaceId),
    isCheckoutUntrusted: (checkoutPath) => isCheckoutUntrusted(workspaceRegistry, checkoutPath),
    findWorkspaceIdForCwd: findWorkspaceIdForCwdExternal,
    listActiveWorkspaces: listActiveWorkspacesExternal,
    archiveWorkspaceRecord: (workspaceId, archivedAt) =>
      archiveWorkspaceRecordExternal(workspaceId, undefined, archivedAt),
    lifecycle: pluginRuntime,
    emitWorkspaceUpdatesForWorkspaceIds: emitWorkspaceUpdatesExternal,
    workspaceRegistry,
    projectRegistry,
    createDirectoryWorkspace: async (cwd, title, projectId, context) => {
      const workspace = await workspaceProvisioning.createWorkspaceForDirectory(
        cwd,
        title,
        projectId,
        context,
      );
      await emitWorkspaceUpdatesExternal([workspace.workspaceId]);
      return workspace;
    },
    workspaceScripts: createWorkspaceScriptsService({
      serviceProxy,
      scriptRuntimeStore,
      terminalManager,
      workspaceRegistry,
      projectRegistry,
      workspaceRuntimeStore,
      getDaemonTcpPort: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
      getDaemonTcpHost: () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
      serviceProxyPublicBaseUrl,
      resolveScriptHealth: (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
      logger,
      emit: (message) => wsServer?.broadcast(wrapSessionMessage(message)),
      publishStatusUpdate: (message) => wsServer?.publishScriptStatusUpdate(message),
      spawnWorkspaceScript,
      globalServicePorts: loadPersistedConfig(config.jagentdeskHome).worktrees?.servicePorts,
    }),
    markWorkspaceArchiving,
    clearWorkspaceArchiving,
    ensureWorkspaceForCreate: createAgentCommandDependencies.ensureWorkspaceForCreate,
    createJAgentDeskWorktree: createAgentCommandDependencies.createJAgentDeskWorktree,
    browserToolsEnabled: pluginRuntime.builtin.forAgent(runtime.callerAgentId).has("browser-tools"),
    browserToolsBroker,
    jagentdeskHome: config.jagentdeskHome,
    worktreesRoot: config.worktreesRoot,
    callerAgentId: runtime.callerAgentId,
    enableVoiceTools: runtime.enableVoiceTools,
    voiceOnly: runtime.voiceOnly,
    resolveSpeakHandler: (agentId) => wsServer?.resolveVoiceSpeakHandler(agentId) ?? null,
    resolveCallerContext: (agentId) => wsServer?.resolveVoiceCallerContext(agentId) ?? null,
    orchestrationRuntime,
    clusterRegistry,
    databaseRegistry,
    builtinServices,
    botAgentTools: (callerAgentId) =>
      createBotAgentTools({
        service: botsService,
        agentManager,
        callerAgentId,
        callerLabels: runtime.callerAgentLabels,
      }),
    browserFingerprintProfiles: {
      list: () => daemonConfigStore.get().browserTools.profiles ?? [],
      activeId: () => daemonConfigStore.get().browserTools.activeProfileId ?? null,
      save: (profile) => {
        const existing = daemonConfigStore.get().browserTools.profiles ?? [];
        const others = existing.filter((candidate) => candidate.id !== profile.id);
        daemonConfigStore.patch({ browserTools: { profiles: [...others, profile] } });
      },
      select: (id) => {
        daemonConfigStore.patch({ browserTools: { activeProfileId: id } });
      },
      remove: (id) => {
        const existing = daemonConfigStore.get().browserTools.profiles ?? [];
        const activeProfileId = daemonConfigStore.get().browserTools.activeProfileId ?? null;
        daemonConfigStore.patch({
          browserTools: {
            profiles: existing.filter((candidate) => candidate.id !== id),
            activeProfileId: activeProfileId === id ? null : activeProfileId,
          },
        });
      },
    },
    requestHostToolPermission: (agentId, req) =>
      agentManager.requestHostToolPermission(agentId, req),
    hostToolGroups: builtinHostToolSet.groups,
    logger,
  });
  const createAgentToolCatalog = (runtime: JAgentDeskToolRuntimeContext) =>
    createJAgentDeskToolCatalog(createAgentToolHostDependencies(runtime));
  const setAgentProviderToolsEnabled = (enabled: boolean) => {
    agentProviderRuntime.setJAgentDeskToolCatalog(
      enabled ? createJAgentDeskAgentToolManifest(createAgentToolHostDependencies({})) : null,
    );
  };
  agentManager.setJAgentDeskToolCatalogFactory(createAgentToolCatalog);
  agentManager.setJAgentDeskToolsEnabled(config.mcpInjectIntoAgents !== false);
  setAgentProviderToolsEnabled(config.mcpEnabled !== false && config.mcpInjectIntoAgents !== false);

  const mcpEnabled = config.mcpEnabled ?? true;
  let agentMcpBaseUrl: string | null = null;
  if (mcpEnabled) {
    const agentMcpRoute = "/mcp/agents";
    const normalizeAgentMcpProtocol = createAgentMcpProtocolNormalizer(logger);

    // Stateless serving: createMcpHandler builds a fresh server per request and
    // serves both protocol eras — modern 2026-07-28 (per-request envelope) and
    // 2025-era clients through its stateless legacy fallback. No per-session
    // state is retained between requests, matching the previous
    // `sessionIdGenerator: undefined` transport.
    const createAgentMcpSession = async (callerAgentId?: string) => {
      if (callerAgentId) await agentManager.refreshPluginTools(callerAgentId);
      const agentMcpServer = await createAgentMcpServer(
        createAgentToolHostDependencies({ callerAgentId }),
      );

      const handler = createMcpHandler(() => agentMcpServer, {
        legacy: "stateless",
        onerror: (err: Error) => {
          logger.error({ err }, "Agent MCP transport error");
        },
      });
      return { handler };
    };

    const runAgentMcpRequest = async (
      req: express.Request,
      res: express.Response,
    ): Promise<void> => {
      // This route is exempt from the global daemon-password middleware, so it
      // authenticates here using the injected capability token (or a valid
      // daemon password). Without this, a password-protected daemon would be
      // wide open on its agent control plane.
      if (
        !(await isAgentMcpRequestAuthorized({
          password: config.auth?.password,
          capabilityToken: agentMcpAuthToken,
          authorizationHeader: req.header("authorization"),
        }))
      ) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      if (config.mcpDebug) {
        logger.debug(
          {
            method: req.method,
            url: req.originalUrl,
            sessionId: req.header("mcp-session-id"),
            authorization: req.header("authorization") ? REDACTED_LOG_VALUE : undefined,
            body: summarizeAgentMcpDebugBody(req.body),
          },
          "Agent MCP request",
        );
      }
      try {
        // Stateless: GET (standalone SSE) and DELETE (session termination) have no
        // meaning without sessions. The MCP client tolerates 405 on the GET stream
        // and never issues a DELETE because it is never handed a session id.
        if (req.method !== "POST") {
          res.status(405).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed",
            },
            id: null,
          });
          return;
        }
        const callerAgentIdRaw = req.query.callerAgentId;
        let callerAgentId: string | undefined;
        if (typeof callerAgentIdRaw === "string") {
          callerAgentId = callerAgentIdRaw;
        } else if (Array.isArray(callerAgentIdRaw) && typeof callerAgentIdRaw[0] === "string") {
          callerAgentId = callerAgentIdRaw[0];
        }
        normalizeAgentMcpProtocol({ request: req, callerAgentId });
        const { handler } = await createAgentMcpSession(callerAgentId);
        try {
          // express.json() already consumed the stream, so hand the parsed body over.
          await toNodeHandler(handler)(
            req as unknown as IncomingMessage,
            res as unknown as ServerResponse,
            req.body,
          );
        } finally {
          await handler.close();
        }
      } catch (err) {
        logger.error({ err }, "Failed to handle Agent MCP request");
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: "Internal MCP server error",
            },
            id: null,
          });
        }
      }
    };

    const handleAgentMcpRequest: express.RequestHandler = (req, res) => {
      void runAgentMcpRequest(req, res);
    };

    app.post(agentMcpRoute, handleAgentMcpRequest);
    app.get(agentMcpRoute, handleAgentMcpRequest);
    app.delete(agentMcpRoute, handleAgentMcpRequest);
    logger.info({ route: agentMcpRoute }, "Agent MCP server mounted on main app");
  } else {
    logger.info("Agent MCP HTTP endpoint disabled");
  }

  logger.info({ elapsed: elapsed() }, "Bootstrap complete, ready to start listening");

  const start = async () => {
    let mainStarted = false;
    try {
      // Give hardware detection a brief head start so the first server_info carries machineKind.
      let machineKindTimeout: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        hostMachineKindReady,
        new Promise<void>((resolve) => {
          machineKindTimeout = setTimeout(resolve, 150);
          machineKindTimeout.unref();
        }),
      ]).finally(() => {
        if (machineKindTimeout) clearTimeout(machineKindTimeout);
      });
      if (serviceProxyListenTarget) {
        const boundServiceProxyTarget = await serviceProxy.startStandalone({
          listenTarget: serviceProxyListenTarget,
        });
        serviceProxyListenTarget = boundServiceProxyTarget;
        logger.info(
          {
            listen: formatListenTarget(serviceProxyListenTarget),
            publicBaseUrl: serviceProxyPublicBaseUrl,
            elapsed: elapsed(),
          },
          "Service proxy listening",
        );
      }

      // Start main HTTP server
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          httpServer.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          httpServer.off("error", onError);
          mainStarted = true;
          // Host capabilities, physical devices, Spec mode and Jira attach to the
          // WebSocket server right after it exists (kept out of logAndResolve for its size).
          const attachHostServices = async (server: VoiceAssistantWebSocketServer) => {
            // Spec 24.2: what this host can run, probed in the background after start.
            // Tools the platform-aware installer added live in $JAGENTDESK_HOME/tools/bin.
            ensureToolDirsOnPath(config.jagentdeskHome);
            const hostCapabilities =
              dependencies.hostCapabilities ??
              new HostCapabilityService({
                jagentdeskHome: config.jagentdeskHome,
                logger,
              });
            const hostToolInstaller = new HostToolInstaller({
              jagentdeskHome: config.jagentdeskHome,
              logger,
              capabilities: hostCapabilities,
              fetch: globalThis.fetch as unknown as HttpFetch,
              githubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null,
            });
            setSharedHostToolInstaller(hostToolInstaller);
            server.setHostCapabilities(hostCapabilities, hostToolInstaller);
            void hostCapabilities.refresh().catch((error: unknown) => {
              logger.warn({ err: error }, "Host capability probe failed");
            });
            daemonHostCapabilities = hostCapabilities;
            server.setBotsService(botsService);
            server.setCustomProvidersService(customProviderService);
          };
          const logAndResolve = async () => {
            boundListenTarget = resolveBoundListenTarget(listenTarget, httpServer);
            const loopbackBaseUrl = createLoopbackBaseUrl(boundListenTarget);
            void writeAgentShimEndpoint({
              dir: agentShimDirectory,
              url: loopbackBaseUrl ? `${loopbackBaseUrl}${AGENT_BROWSER_OPEN_ROUTE}` : null,
              token: agentMcpAuthToken,
            }).catch((error: unknown) => {
              logger.warn({ err: error }, "Could not write the agent shim endpoint");
            });
            const mcpBaseUrl = mcpEnabled ? createAgentMcpBaseUrl(boundListenTarget) : null;
            agentMcpBaseUrl = config.mcpInjectIntoAgents === false ? null : mcpBaseUrl;
            agentManager.setMcpBaseUrl(agentMcpBaseUrl);
            agentManager.setJAgentDeskToolsEnabled(config.mcpInjectIntoAgents !== false);
            daemonConfigStore.onFieldChange("mcp.injectIntoAgents", (value) => {
              agentManager.setMcpBaseUrl(value ? mcpBaseUrl : null);
              agentManager.setJAgentDeskToolsEnabled(value !== false);
              setAgentProviderToolsEnabled(mcpEnabled && value !== false);
            });
            daemonConfigStore.onFieldChange("appendSystemPrompt", (value) => {
              agentManager.setAppendSystemPrompt(typeof value === "string" ? value : "");
            });
            daemonConfigStore.onFieldChange("operatorContext", (value) => {
              agentManager.setOperatorContext(typeof value === "string" ? value : "");
            });
            if (boundListenTarget.type === "tcp") {
              logger.info(
                {
                  host: boundListenTarget.host,
                  port: boundListenTarget.port,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on http://${boundListenTarget.host}:${boundListenTarget.port}`,
              );
            } else {
              logger.info(
                {
                  path: boundListenTarget.path,
                  authRequired: !!config.auth?.password,
                  elapsed: elapsed(),
                },
                `Server listening on ${boundListenTarget.path}`,
              );
            }
            if (config.auth?.password) {
              logger.info("Daemon password authentication enabled");
            }

            wsServer = new VoiceAssistantWebSocketServer(
              httpServer,
              logger,
              serverId,
              agentManager,
              agentStorage,
              downloadTokenStore,
              config.jagentdeskHome,
              daemonConfigStore,
              mcpBaseUrl,
              {
                allowedOrigins,
                hostnames: configuredHostnames,
                daemonStatusRpc: dependencies.serverFeatureOverrides?.daemonStatusRpc,
              },
              workspaceAutoName,
              workspaceRuntimeStore,
              config.auth,
              speechService,
              terminalManager,
              {
                finalTimeoutMs: config.dictationFinalTimeoutMs,
              },
              daemonVersion,
              (intent) => {
                try {
                  config.onLifecycleIntent?.(intent);
                } catch (error) {
                  logger.error({ err: error, intent }, "Failed to handle daemon lifecycle intent");
                }
              },
              projectRegistry,
              workspaceRegistry,
              chatService,
              loopService,
              clusterRegistry,
              scheduleService,
              checkoutDiffManager,
              serviceProxy,
              scriptRuntimeStore,
              handleBranchChange,
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.port : null),
              () => (boundListenTarget?.type === "tcp" ? boundListenTarget.host : null),
              (hostname) => scriptHealthMonitor.getHealthForHostname(hostname),
              workspaceGitService,
              github,
              config.pushNotificationSender,
              providerSnapshotManager,
              {
                listen: formatListenTarget(boundListenTarget ?? listenTarget),
                worktreesRoot: config.worktreesRoot,
                appBaseUrl: config.appBaseUrl,
                desktopManaged: config.desktopManaged === true,
                getTailnetAddress: () => tsnetListener?.getDirectAddress() ?? null,
                getRelayConfig: () =>
                  relayRuntime?.getConfig() ?? {
                    enabled: config.relayEnabled ?? true,
                    endpoint: config.relayEndpoint ?? DEFAULT_RELAY_ENDPOINT,
                    useTls: config.relayUseTls ?? true,
                  },
              },
              serviceProxyPublicBaseUrl,
              browserToolsBroker,
              hubRelationships,
              {
                devices: pairedDevices,
                challenges: nonceChallenges,
                daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
                pairingCodeManager,
                requireSignedHelloForDirect,
              },
              pluginRuntime,
              databaseRegistry,
              sshService,
              workspaceArchiveOperations,
              config.pushNotifications,
            );
            wsServer.setHostDial(async (target) => {
              const proxy = tsnetListener?.getTailnetSocks();
              if (!proxy) throw new Error("tailnet_unavailable");
              const url = new URL(target.url);
              return connectThroughProxy(
                { type: "socks5", ...proxy },
                { host: url.hostname.replace(/^\[|\]$/g, ""), port: target.pairing.port },
              );
            });
            const remoteObservation = createRemoteFinishObservation({
              agentManager,
              agentStorage,
              messages: () => getAgentMessageDelivery({ agentManager, agentStorage, logger }),
              hosts: () => wsServer!.toolHosts(),
              serverId,
              logger,
            });
            remoteFinishSubscriptions = createRemoteFinishSubscriptions({
              ...remoteObservation,
              hostLabel: async (id) =>
                (await wsServer!.toolHosts().directory()).hosts.find((host) => host.serverId === id)
                  ?.label ?? undefined,
              store: createRemoteFinishStore(config.jagentdeskHome),
              messages: () => getAgentMessageDelivery({ agentManager, agentStorage, logger }),
              callerIsActive: async (agentId) => !(await agentStorage.get(agentId))?.archivedAt,
              serverId,
              logger,
            });
            await remoteFinishSubscriptions.start();
            // A local child waiting on an agent on another host is still working (Paseo #10864).
            const remoteSubscriptions = remoteFinishSubscriptions;
            setRemoteDelegationProbe(agentManager, (agentId) =>
              remoteSubscriptions.hasPendingForCaller(agentId),
            );
            await attachHostServices(wsServer);
            botsRuntimeReady = true;
            if (pluginRuntime.builtin.isEnabled("bots")) {
              botsService.start();
              botsSlack.start();
              botsHooks.start();
            }
            // Bind the plugin session host and start configured plugins before any
            // external ingress attaches, mirroring upstream's pre-accept ordering.
            pluginRuntime.bindJAgentDeskSessionHost(wsServer);
            await pluginRuntime.start();
            providerSnapshotManager.settlePluginProviders();
            restartRecovery.resumePending();
            await changeRequestWatches.start();
            tsnetListener = createTsnetListener({
              logger,
              port: boundListenTarget.type === "tcp" ? boundListenTarget.port : 0,
              tailnetHost: config.tailnetHost ?? process.env.JAGENTDESK_TAILNET_HOST,
              allowExternalServe: process.env.JAGENTDESK_ALLOW_EXTERNAL_TAILSCALE === "1",
              // Keep the tsnet node identity in the JAgentDesk home so an
              // interactive browser login survives bridge restarts and the
              // health/status IPC observes the same node that was logged in.
              stateDir: config.tailnetStateDir ?? path.join(config.jagentdeskHome, "tailscale"),
              statusFile: path.join(config.jagentdeskHome, "tailscale-status.json"),
              daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
              authKey: process.env.JAGENTDESK_TAILSCALE_AUTH_KEY,
              hostname: config.tailnetHostname,
              attachSocket: async (ws, metadata) => {
                if (!wsServer) throw new Error("WebSocket server is not ready");
                await wsServer.attachExternalSocket(ws, metadata);
              },
            });
            await tsnetListener.start();
            // Relay second path (spec 35 / ADR-0048): dials the Worker alongside
            // the tailnet and feeds the same auth path. Data sockets run the
            // Noise E2EE handshake before session admission.
            const relaySecurityLogger = logger.child({ module: "relay-security" });
            relayRuntime = createRelayRuntime({
              // Slack, GitHub, GitLab and Telegram, then bot sharing.
              controlHandler: relayControlMux([botsHooks.controlHandler(), botsSharing]),
              config: {
                enabled: config.relayEnabled ?? true,
                endpoint: config.relayEndpoint ?? DEFAULT_RELAY_ENDPOINT,
                useTls: config.relayUseTls ?? true,
              },
              logger,
              serverId,
              getRelayOwnership: () => daemonKeyPair.ensureRelayIdentity(),
              attachSocket: (ws, metadata) =>
                admitSecuredRelaySocket(
                  ws,
                  {
                    daemonKeyPair: daemonKeyPair.keyPair,
                    logger: relaySecurityLogger,
                    requireProtectedMode: () => false,
                  },
                  async (secured) => {
                    if (!wsServer) throw new Error("WebSocket server is not ready");
                    await wsServer.attachExternalSocket(secured.socket, {
                      ...metadata,
                      transport: "relay",
                      securityMode: secured.securityMode,
                    });
                  },
                ),
            });
            daemonConfigStore.onFieldChange("relay.enabled", (value) => {
              if (config.relayEnabledMutable === false && value !== config.relayEnabled) {
                throw new Error("Relay enabled state is pinned by the daemon launch configuration");
              }
              relayRuntime?.setEnabled(value === true);
            });
            await hubRelationships.start();
          };

          logAndResolve().then(resolve, reject);
        };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);

        if (listenTarget.type === "tcp") {
          httpServer.listen(listenTarget.port, listenTarget.host);
        } else {
          if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
            unlinkSync(listenTarget.path);
          }
          httpServer.listen(listenTarget.path);
        }
      });

      // Start speech service after listening so synchronous Sherpa native
      // model loading doesn't block the server from accepting connections.
      speechService.start();
      scriptHealthMonitor.start();
    } catch (error) {
      unsubscribePluginProviders();
      await pluginRuntime.stopAllPlugins().catch(() => undefined);
      await serviceProxy.stopStandalone().catch(() => undefined);
      await agentProviderRuntime.shutdown().catch(() => undefined);
      if (mainStarted) {
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
      throw error;
    }
  };

  const stop = async (options?: { keepTerminals?: boolean }) => {
    const keepTerminals = options?.keepTerminals === true;
    let terminalShutdownError: unknown = null;
    unsubscribePluginProviders();
    await hubRelationships.stop();
    workspaceReconciliation.dispose();
    scriptHealthMonitor.stop();
    unsubscribeIdleRuntimeCleanup();
    await idleRuntimeCleanup.close();
    // Graceful shutdown delivers agent messages still waiting in a 2 s window
    // (ADR-0029 decision 3); a crash loses them.
    wsServer?.prepareForShutdown();
    suspendFinishNotifications(agentManager);
    await changeRequestWatches.close();
    await closeAgentMessageDelivery(agentManager).catch(() => undefined);
    // Freeze registration before taking the agent closure snapshot.
    botsService.suspendForShutdown();
    agentManager.prepareForShutdown();
    await restartRecovery.captureRunningAgents();
    await closeAllAgents(logger, agentManager);
    timelineSnapshots.dispose();
    await withTimeout({
      promise: pluginRuntime.drainEvents(),
      timeoutMs: 5_000,
      label: "drain plugin lifecycle events",
    }).catch((error) => logger.warn({ err: error }, "Plugin lifecycle events did not finish"));
    let shutdownFlushTimedOut = false;
    await withTimeout({
      promise: agentManager.flushForShutdown(),
      timeoutMs: 5_000,
      label: "flush agent shutdown tasks",
    }).catch((error) => {
      shutdownFlushTimedOut = true;
      logger.warn({ err: error }, "Agent shutdown tasks did not finish before provider shutdown");
    });
    detachAgentStoragePersistence();
    await agentStorage.flush().catch(() => undefined);
    // Spec 34: loopback forwards of api providers die with the daemon.
    customProviderService.closeAll();
    // Stops the provider snapshot manager, then the OpenCode tool bridge.
    await agentProviderRuntime.shutdown();
    if (shutdownFlushTimedOut) {
      await withTimeout({
        promise: agentManager.flushForShutdown(),
        timeoutMs: 5_000,
        label: "flush agent shutdown tasks after provider shutdown",
      }).catch((error) =>
        logger.warn({ err: error }, "Agent shutdown tasks did not finish after provider shutdown"),
      );
      await agentStorage.flush().catch(() => undefined);
    }
    await pluginRuntime.stopAllPlugins().catch(() => undefined);
    try {
      if (keepTerminals) {
        await localTerminalManager.detach();
        logger.info("Terminals left running for the next daemon");
      } else {
        await localTerminalManager.closeTerminals();
      }
    } catch (error) {
      // Finish the rest of the shutdown, then report it: the supervisor and `daemon stop`
      // retry the cleanup from the record the reaper kept.
      terminalShutdownError = error;
      logger.error({ err: error }, "Terminal shutdown failed");
    }
    unsubscribeBuiltinAgentSnapshots();
    // Built-in features stop before the shared libraries they consume (remote tasks before SSH).
    await builtinDaemon.stop();
    await sshModules.dispose().catch(() => undefined);
    await sshServerModules.dispose().catch(() => undefined);
    sshService.dispose();
    await botsSlack.dispose();
    await botsHooks.dispose();
    await botsService.dispose();
    await speechService.stop();
    await scheduleService.stop().catch(() => undefined);
    await relayRuntime?.stop().catch(() => undefined);
    await remoteFinishSubscriptions?.close();
    await tsnetListener?.stop().catch(() => undefined);
    if (wsServer) {
      await wsServer.close();
    }
    forgeResolver.dispose();
    await serviceProxy.stopStandalone();
    // Force-drop remaining sockets so httpServer.close() resolves promptly.
    // We've already closed wsServer (which sent ws-layer close frames) and
    // stopped every other service, so anything still attached is a TCP
    // socket whose higher-level shutdown hasn't fully released it (e.g.
    // upgraded WS sockets in the closing handshake, or HTTP keep-alive
    // sockets in CLOSE_WAIT). closeIdleConnections() does not catch
    // upgraded sockets, so we use closeAllConnections() here.
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    // Clean up socket files
    if (listenTarget.type === "socket" && existsSync(listenTarget.path)) {
      unlinkSync(listenTarget.path);
    }
    if (terminalShutdownError) {
      throw terminalShutdownError;
    }
  };

  return {
    config,
    agentManager,
    agentStorage,
    terminalManager,
    serviceProxy,
    scriptRuntimeStore,
    browserToolsBroker,
    start,
    stop,
    getListenTarget: () => boundListenTarget,
  };
}

// The app web build bundled next to the server dist (dist/server/share-app-dist), copied there by
// the build (scripts/build-share-app-dist.mjs) so the ShareServer can serve the real app to guests
// (ADR-0019). bootstrap.js lives at dist/server/server/bootstrap.js, so the sibling is "../share-app-dist".
function resolveBundledShareAppDist(): string | undefined {
  try {
    let dir = fileURLToPath(new URL("../share-app-dist", import.meta.url));
    // In a packaged Electron app the daemon may resolve inside app.asar, but static assets live in
    // app.asar.unpacked (real files readFileSync can read). Prefer the unpacked copy when present.
    if (dir.includes(`app.asar${path.sep}`)) {
      const unpacked = dir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      if (existsSync(path.join(unpacked, "index.html"))) return unpacked;
    }
    return existsSync(path.join(dir, "index.html")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

async function closeAllAgents(logger: Logger, agentManager: AgentManager): Promise<void> {
  const agents = agentManager.listAgents();
  await Promise.all(
    agents.map(async (agent) => {
      try {
        await withTimeout({
          promise: agentManager.closeAgent(agent.id),
          timeoutMs: 5_000,
          label: `close agent ${agent.id}`,
        });
      } catch (err) {
        logger.error({ err, agentId: agent.id }, "Failed to close agent");
      }
    }),
  );
}

/**
 * Spec mode (spec 28 / ADR-0030): phase commands sent on Approve/Revise go through the same
 * send path as a user's message; per-agent spec-kit env reaches provider launches; Spec mode
 * and autonomous mode refuse to start while the other is on.
 */
export function connectIdleRuntimeCleanupConfig(
  store: DaemonConfigStore,
  cleanup: Pick<ReturnType<typeof createIdleRuntimeCleanup>, "setEnabled">,
): () => void {
  cleanup.setEnabled(store.get().idleRuntimeCleanup !== false);
  return store.onFieldChange("idleRuntimeCleanup", (value) => cleanup.setEnabled(value !== false));
}

function resolveSnapshotContextWindow(
  entries: ReturnType<ProviderSnapshotManager["getSnapshot"]>,
  provider: string,
  model: string | null,
): number | null {
  const models = entries.find((entry) => entry.provider === provider)?.models ?? [];
  const match =
    (model ? models.find((entry) => entry.id === model || entry.aliases?.includes(model)) : null) ??
    models.find((entry) => entry.isDefault);
  return match?.contextWindowMaxTokens ?? null;
}

function continuityConfigFromStartup(config: {
  agentFailover?: FailoverConfig;
  crossProviderChildren?: CrossProviderChildrenConfig;
}): Pick<MutableDaemonConfig, "agentFailover" | "crossProviderChildren"> {
  const result: Pick<MutableDaemonConfig, "agentFailover" | "crossProviderChildren"> = {};
  if (config.agentFailover) result.agentFailover = config.agentFailover;
  if (config.crossProviderChildren) result.crossProviderChildren = config.crossProviderChildren;
  return result;
}
