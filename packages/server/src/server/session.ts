import { BotsSession } from "./bots/session.js";
import type { BotsService } from "./bots/service.js";
import { AgentDirectory, type BackgroundVisibility } from "./agent/directory.js";
import { inheritAgentBackground, inheritWorkspaceBackground } from "./agent/create-agent/intent.js";
import {
  SpeechModelsSession,
  type SpeechModelsSessionOptions,
} from "./session/speech/speech-models-session.js";
import { UsageSession, type UsageSessionOptions } from "./session/usage/usage-session.js";
import { builtinPluginWireState } from "@jagentdesk/protocol/builtin-plugins";
import { CreationService } from "./creation/index.js";
import { builtinPluginForRpc } from "./plugins/builtin/gates.js";
import { BuiltinPluginError, type BuiltinPluginState } from "./plugins/builtin/state.js";
import { SessionDelivery, type OwnedSubscription } from "./session/owned-subscriptions/index.js";
import {
  SessionEventSubscriptionSchema,
  type SessionEventSubscription,
} from "@jagentdesk/protocol/messages";
import {
  assertPluginTimelineDataSize,
  assertPluginTimelineKind,
} from "./agent/agent-timeline-content.js";
import { parsePluginClientId } from "./plugins/plugin-session-identity.js";
import { type WorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import {
  createWorkspaceBaseBranchService,
  type WorkspaceBaseBranchService,
} from "./session/workspace-base-branch/service.js";
import type { WorkspaceBaseBranchSetRequest } from "@jagentdesk/protocol/messages";
import {
  isDaemonBackgroundWorkItem,
  type AgentBackgroundWorkItem,
} from "./agent/background-work/index.js";
import equal from "fast-deep-equal";
import { v4 as uuidv4 } from "uuid";
import { lstat, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "path";
import { homedir } from "node:os";
import { CLIENT_CAPS, type ClientCapability } from "@jagentdesk/protocol/client-capabilities";
import { formatPluginSourceReference } from "@jagentdesk/protocol/plugin-source-reference";
import type { PairingCodeManager } from "./pairing/pairing-code.js";
import {
  serializeAgentStreamEvent,
  type AgentSnapshotPayload,
  type AgentAttachment,
  type FirstAgentContext,
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type ScriptStatusUpdateMessage,
  type GitSetupOptions,
  type StartWorkspaceScriptRequest,
  type WorkspaceScriptListRequest,
  type WorkspaceScriptStartRequest,
  type WorkspaceScriptStopRequest,
  type CloseItemsRequest,
  type DirectorySuggestionsRequest,
  type ProjectPlacementPayload,
  type WorkspaceSetupSnapshot,
  type WorkspaceDescriptorPayload,
} from "./messages.js";
import type {
  TerminalManager,
  TerminalWorkspaceContributionChangedEvent,
} from "../terminal/terminal-manager.js";
import type { RemoteJob } from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import { handleRemoteExecMessage, remoteExecJobUpdated } from "./remote-exec/rpc.js";
import type { RemoteExecService } from "./remote-exec/types.js";
import { handleCustomProvidersMessage } from "./custom-providers/rpc.js";
import type { CustomProviderService } from "./custom-providers/types.js";
import { TerminalSessionController } from "../terminal/terminal-session-controller.js";
import type { TerminalActivity } from "@jagentdesk/protocol/terminal-activity";
import type { BinaryFrame } from "@jagentdesk/protocol/binary-frames/index";
import {
  encodePluginEventFrame,
  encodePluginOutputFrame,
  PluginFrameOpcode,
} from "@jagentdesk/protocol/binary-frames/index";
import { CursorError } from "./pagination/cursor.js";
import { SortablePager, type SortSpec } from "./pagination/sortable-pager.js";
import type { SpeechToTextProvider, TextToSpeechProvider } from "./speech/speech-provider.js";
import type { TurnDetectionProvider } from "./speech/turn-detection-provider.js";
import {
  buildConfigOverrides,
  isStoredAgentProviderAvailable,
  toAgentPersistenceHandle,
} from "./persistence-hooks.js";
import { ensureAgentLoaded, ensureUnarchivedAgentLoaded } from "./agent/agent-loading.js";
import { searchTimeline } from "./agent/chat-search/index.js";
import {
  formatSystemNotificationPrompt,
  type PromptDispatchResult,
  enqueueAgentMessage,
  sendPreparedPromptToAgent,
  sendPromptToAgent,
  waitForAgentMessageDispatch,
  waitForAgentRunStartWithTimeout,
  unarchiveAgentState,
} from "./agent/agent-prompt.js";
import {
  resolveCreateAgentTitles,
  resolveFirstAgentPromptTitle,
} from "./agent/create-agent-title.js";
import { respondToAgentPermission } from "./agent/permission-response.js";
import type { VoiceCallerContext, VoiceSpeakHandler } from "./voice-types.js";
import type { ScriptHealthState } from "./script-health-monitor.js";
import { spawnWorkspaceScript } from "./worktree-bootstrap.js";
import type { WorkspaceScriptRuntimeStore } from "./workspace-script-runtime-store.js";
import {
  createWorkspaceScriptsService,
  type WorkspaceScriptsService,
} from "./session/workspace-scripts/workspace-scripts-service.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import { loadPersistedConfig } from "./persisted-config.js";
import { releaseWorkspaceServicePortPlan } from "./workspace-service-port-registry.js";
import { getErrorMessage, getErrorMessageOr } from "@jagentdesk/protocol/error-utils";
import { getAgentStatusPriority } from "@jagentdesk/protocol/agent-state-bucket";
import { getParentAgentIdFromLabels } from "@jagentdesk/protocol/agent-labels";
import type { WorkspaceGitRuntimeSnapshot, WorkspaceGitService } from "./workspace-git-service.js";
import type { ProjectUpdate } from "./workspace-reconciliation-service.js";
import {
  CLIENT_SHUTDOWN_RPC_REASON,
  normalizeClientRestartRpcReason,
} from "./lifecycle-reasons.js";

import { AgentManager, AgentRunCancellationError } from "./agent/agent-manager.js";
import { buildTimelinePromptIndex } from "./agent/timeline-prompt-index.js";
import { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";
import type {
  AgentManagerEvent,
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  AgentTimelineFetchResult,
  ManagedAgent,
} from "./agent/agent-manager.js";
import { createAgentCommand } from "./agent/create-agent/create.js";
import {
  resolveCreateAgentIntent,
  type CreateAgentIntent,
  type CreateAgentCaller,
} from "./agent/create-agent/intent.js";
import {
  archiveAgentCommand,
  cancelAgentRunCommand,
  closeAgentCommand,
  detachAgentCommand,
  setAgentModeCommand,
  updateAgentCommand,
} from "./agent/lifecycle-command.js";
import {
  buildStoredAgentPayload,
  resolveStoredAgentPayloadUpdatedAt,
  toAgentPayload,
} from "./agent/agent-projections.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "./agent/timeline-append.js";
import { buildAgentForkContextAttachment } from "./agent/activity-curator.js";
import { buildAgentPrompt } from "./agent/prompt-attachments.js";
import type { StructuredGenerationDaemonConfig } from "./agent/structured-generation-providers.js";
import {
  getAgentStreamEventTurnId,
  type AgentPersistenceHandle,
  type AgentPermissionResponse,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentSessionConfig,
} from "./agent/agent-sdk-types.js";
import type { StoredAgentRecord } from "./agent/agent-storage.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import {
  ImportSessionsRequestError,
  importProviderSession,
  listImportableProviderSessions,
  normalizeImportAgentRequest,
} from "./agent/import-sessions.js";
import { exportHostData } from "./migration/export-host-data.js";
import { importHostData } from "./migration/import-host-data.js";
import { listProjectSuggestions, ProjectSuggestionsRequestError } from "./project-suggestions.js";
import {
  checkoutLiteFromGitSnapshot,
  checkoutFromPersistedWorkspacePlacement,
  deriveWorkspaceDisplayName,
} from "./workspace-registry-model.js";
import { resolveWorkspaceIdForPath } from "./resolve-workspace-id-for-path.js";
import {
  resolveProjectDisplayName,
  resolveWorkspaceDisplayName,
  resolveWorkspaceName,
  type PersistedProjectRecord,
  type PersistedWorkspaceRecord,
  type ProjectMutation,
  type ProjectRegistry,
  type WorkspaceMutation,
  type WorkspaceRegistry,
} from "./workspace-registry.js";
import { wrapSpokenInput } from "./voice-config.js";
import { isVoicePermissionAllowed } from "./voice-permission-policy.js";
import {
  readProjectIcon,
  removeProjectCustomIcon,
  setProjectCustomIcon,
} from "../utils/project-custom-icon.js";
import { VoiceSession } from "./session/voice/voice-session.js";
import { CheckoutSession } from "./session/checkout/checkout-session.js";
import { ForgeHubSession } from "./session/forge/forge-hub-session.js";
import { FileSecretStore } from "./database/secret-store.js";
import {
  createWorkspaceGitObserverService,
  type WorkspaceGitObserverService,
} from "./session/workspace-git-observer/workspace-git-observer-service.js";
import {
  createAgentStructuredTextGeneration,
  createGitMetadataGenerator,
} from "./session/checkout/git-metadata-generator.js";
import { ChatScheduleLoopSession } from "./session/chat/chat-schedule-loop-session.js";
import { AutorunSession } from "./session/autorun/autorun-session.js";
import { SpecModeSession } from "./session/spec-mode/spec-mode-session.js";
import type { SpecModeService } from "./spec-mode/service.js";
import type { AutorunService } from "./autorun/service.js";
import { SessionShareSession } from "./session/session-share/session-share-session.js";
import type { ActivityGraphService } from "./agent/activity-graph/service.js";
import { ActivityGraphSession } from "./session/activity-graph/activity-graph-session.js";
import type { SessionShareService } from "./session-share/service.js";
import { ClusterSession } from "./session/cluster/cluster-session.js";
import { ClusterRegistry } from "./cluster/cluster-registry.js";
import { DatabaseSession } from "./session/database/database-session.js";
import { SshSession } from "./session/ssh/ssh-session.js";
import { ArgoCdSession } from "./session/argocd/argocd-session.js";
import type { ArgoCdService } from "./argocd/service.js";
import { randomUUID } from "node:crypto";
import { JiraSession } from "./session/jira/jira-session.js";
import { FigmaSession, isFigmaRequest } from "./session/figma/figma-session.js";
import type { FigmaService } from "./figma/service.js";
import type { JiraService } from "./jira/service.js";
import { SshService } from "./ssh/ssh-service.js";
import { SideloadSession } from "./session/sideload/sideload-session.js";
import type { SideloadService } from "./sideload/sideload-service.js";
import { DockerService } from "./docker/docker-service.js";
import { DockerStreams } from "./docker/docker-streams.js";
import { RemoteDockerError, type RemoteDockerHosts } from "./ssh/remote-docker/hosts.js";
import { localPortOfTarget } from "./ssh/remote-db/service.js";
import {
  disposeRemoteDocker,
  routeDockerMessage,
  type RoutedDocker,
} from "./ssh/remote-docker/route.js";
import { SimulatorService } from "./simulator/simulator-service.js";
import { SimulatorStreams, fleetSnapshot } from "./simulator/simulator-streams.js";
import type { PhysicalDeviceHub } from "./devices/hub.js";
import {
  PhysicalDeviceSession,
  deviceErrorText,
} from "./session/devices/physical-device-session.js";
import { getSharedProxyService } from "./proxy/proxy-service.js";
import { fridaAvailability, installFrida } from "./proxy/frida-control.js";
import { DatabaseRegistry } from "./database/database-registry.js";
import { ProviderCatalogSession } from "./session/provider/provider-catalog-session.js";
import { WorkspaceFilesSession } from "./session/files/workspace-files-session.js";
import { AgentConfigSession } from "./session/agent-config/agent-config-session.js";
import { ProjectConfigSession } from "./session/project-config/project-config-session.js";
import { DaemonSession, type DaemonRuntimeConfig } from "./session/daemon/daemon-session.js";
import type { PairedDeviceStore } from "./pairing/paired-devices.js";
import type { DaemonWebSocketRuntimeDiagnosticSnapshot } from "./session/daemon/diagnostics.js";
import type { HubRelationshipManagement } from "./hub/relationship-controller.js";
import { HubExecutionController } from "./hub/execution-controller.js";
import type { HubExecutionAgents } from "./hub/daemon-executions.js";
import { DownloadTokenStore } from "./file-download/token-store.js";
import { PushTokenStore } from "./push/token-store.js";
import {
  archivePersistedWorkspaceRecord,
  archiveWorkspaceContents,
  unarchiveWorkspaceAgents,
} from "./workspace-archive-service.js";
import type { ServiceProxySubsystem } from "./service-proxy.js";
import { prepareTaskBrief } from "./orchestration/task-brief.js";
import { renameCurrentBranch as renameCurrentBranchDefault } from "../utils/checkout-git.js";
import {
  createGitMutationService,
  type GitMutationService,
} from "./session/git-mutation/git-mutation-service.js";
import {
  createWorkspaceProvisioningService,
  type WorkspaceProvisioningService,
} from "./session/workspace-provisioning/workspace-provisioning-service.js";
import {
  createWorkspaceRecoveryService,
  type WorkspaceRecoveryService,
} from "./session/workspace-recovery/workspace-recovery-service.js";
import {
  createAgentUpdatesService,
  matchesAgentUpdatesFilter,
  type AgentUpdatesService,
} from "./session/agent-updates/agent-updates-service.js";
import { expandTilde } from "../utils/path.js";
import {
  searchDirectoryEntries,
  WORKSPACE_SEARCH_HIDDEN_DIRECTORIES,
} from "../utils/directory-suggestions.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { Resolvable } from "./speech/provider-resolver.js";
import type { SpeechReadinessSnapshot } from "./speech/speech-runtime.js";
import type pino from "pino";
import { FileBackedChatService } from "./chat/chat-service.js";
import { LoopService } from "./loop-service.js";
import type { NativeSkillsService } from "./skills-native/index.js";
import {
  handleNativeSkillsRequest,
  isNativeSkillsRequest,
} from "./skills-native/session-handler.js";
import type { UsageHistoryStorage } from "./usage/usage-history-storage.js";
import type { HostCapabilityService } from "./host-capabilities/service.js";
import type { HostToolInstaller } from "./host-tools/installer.js";
import { ToolInstallError } from "./host-tools/release.js";

function toolInstallErrorPayload(error: unknown): { code: string; message: string } {
  if (error instanceof ToolInstallError) return { code: error.code, message: error.message };
  return {
    code: "install_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}
import type { LifetimeUsage } from "@jagentdesk/protocol/usage-history";
import { ScheduleService } from "./schedule/service.js";

// Zeroed lifetime total, emitted when no usage-history store is wired (and as the
// post-reset shape). Kept module-scoped so the get + reset handlers share one.
const EMPTY_LIFETIME_USAGE: LifetimeUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalCostUsd: 0,
  turns: 0,
  byModel: {},
};
import {
  createGitHubService,
  GitHubAuthenticationError,
  GitHubCliMissingError,
  GitHubCommandError,
  type GitHubService,
} from "../services/github-service.js";
import type { ForgeService } from "../services/forge-service.js";
import type { ProviderUsageService } from "../services/quota-fetcher/service.js";
import {
  summarizeFetchWorkspacesEntries,
  workspaceIdsOnCheckout,
  WorkspaceDirectory,
  type WorkspaceUpdatesFilter,
} from "./workspace-directory.js";
import { shouldEmitPendingBootstrapUpdate } from "./workspace-bootstrap-dedupe.js";
import {
  createJAgentDeskWorktree,
  type CreateJAgentDeskWorktreeInput,
  type CreateJAgentDeskWorktreeResult,
} from "./jagentdesk-worktree-service.js";
import { WorkspaceAutoName } from "./workspace-auto-name.js";
import {
  buildAgentSessionConfig as buildWorktreeAgentSessionConfig,
  createJAgentDeskWorktreeWorkflow as createWorktreeWorkflow,
  type CreateJAgentDeskWorktreeSetupContinuationInput,
  type CreateJAgentDeskWorktreeWorkflowResult,
  handleCreateJAgentDeskWorktreeRequest as handleCreateWorktreeRequest,
  handleJAgentDeskWorktreeArchiveRequest as handleWorktreeArchiveRequest,
  handleJAgentDeskWorktreeListRequest as handleWorktreeListRequest,
  handleWorkspaceSetupStatusRequest as handleWorkspaceSetupStatusRequestMessage,
} from "./worktree-session.js";
import { archiveByScope, type ActiveWorkspaceRef } from "./workspace-archive-service.js";
import {
  WorkspaceArchiveOperations,
  type WorkspaceArchiveUndoInput,
} from "./workspace-archive-operations.js";
function resolveWorkspaceArchiveOperations(
  operations: WorkspaceArchiveOperations | undefined,
): WorkspaceArchiveOperations {
  return operations ?? new WorkspaceArchiveOperations();
}
import { WorktreeRequestError, toWorktreeWireError } from "./worktree-errors.js";
import { parseGitRemoteLocation } from "@jagentdesk/protocol/git-remote";
import {
  createProjectDirectory,
  ProjectDirectoryRequestError,
} from "./project-directory-service.js";
import { runGitCommand } from "../utils/run-git-command.js";
import { CreateAgentLifecycleDispatch } from "./agent/create-agent-lifecycle-dispatch.js";
import { resolveWorktreeSourceCwd } from "./workspace-source.js";

type ProviderSubagentManagerEvent = Extract<
  AgentManagerEvent,
  { type: "provider_subagent" }
>["event"];

// TODO: Remove once all app store clients are on >=0.1.45 and understand arbitrary provider strings.
// Clients before 0.1.45 validate providers with z.enum(["claude", "codex", "opencode"]) and reject
// the entire session message if they encounter an unknown provider.
const LEGACY_PROVIDER_IDS = new Set(["claude", "codex", "opencode"]);
const FULL_AGENT_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MIN_VERSION_ALL_PROVIDERS = "0.1.45";
const MIN_VERSION_EXPLICIT_WORKSPACE_RECOVERY = "0.1.105";
function errorToFriendlyMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function resolveSubscriptionId(
  subscribe: unknown,
  requestedSubscriptionId: string | undefined,
): string | null {
  if (!subscribe) return null;
  if (requestedSubscriptionId && requestedSubscriptionId.length > 0) {
    return requestedSubscriptionId;
  }
  return uuidv4();
}

function isAppVersionAtLeast(appVersion: string | null, minVersion: string): boolean {
  if (!appVersion) return false;
  // Strip prerelease suffix: "0.1.45-beta.4" -> "0.1.45"
  const base = appVersion.replace(/-.*$/, "");
  const parts = base.split(".").map(Number);
  const minParts = minVersion.split(".").map(Number);
  for (let i = 0; i < minParts.length; i++) {
    const a = parts[i] ?? 0;
    const b = minParts[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function clientSupportsAllProviders(appVersion: string | null): boolean {
  return isAppVersionAtLeast(appVersion, MIN_VERSION_ALL_PROVIDERS);
}

function clientUsesLegacyWorkspaceRestore(appVersion: string | null): boolean {
  return (
    appVersion !== null && !isAppVersionAtLeast(appVersion, MIN_VERSION_EXPLICIT_WORKSPACE_RECOVERY)
  );
}

type DeleteFencedAgentStorage = AgentStorage & {
  beginDelete(agentId: string): void;
};

function beginAgentDeleteIfSupported(agentStorage: AgentStorage, agentId: string): void {
  if ("beginDelete" in agentStorage && typeof agentStorage.beginDelete === "function") {
    (agentStorage as DeleteFencedAgentStorage).beginDelete(agentId);
  }
}

const FETCH_AGENTS_SORT_KEYS = ["status_priority", "created_at", "updated_at", "title"] as const;

export function resolveWaitForFinishError(options: {
  status: "permission" | "error" | "idle";
  final: AgentSnapshotPayload | null;
}): string | null {
  if (options.status !== "error") {
    return null;
  }
  const message = options.final?.lastError;
  return typeof message === "string" && message.trim().length > 0 ? message : "Agent failed";
}

export interface SessionRuntimeMetrics {
  terminalDirectorySubscriptionCount: number;
  terminalSubscriptionCount: number;
  workspaceGitWatchedDirectoryCount: number;
  workspaceGitWorkspaceRecordCount: number;
  workspaceGitSubscriptionCount: number;
  inflightRequests: number;
  peakInflightRequests: number;
}

type FetchAgentsRequestMessage = Extract<SessionInboundMessage, { type: "fetch_agents_request" }>;
type FetchAgentHistoryRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_agent_history_request" }
>;
type AgentDirectoryRequestMessage = FetchAgentsRequestMessage | FetchAgentHistoryRequestMessage;
type FetchAgentsRequestFilter = NonNullable<FetchAgentsRequestMessage["filter"]>;
type FetchAgentsRequestSort = NonNullable<FetchAgentsRequestMessage["sort"]>[number];
type FetchAgentsResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agents_response" }
>["payload"];
type FetchAgentsResponseEntry = FetchAgentsResponsePayload["entries"][number];
type FetchAgentsResponsePageInfo = FetchAgentsResponsePayload["pageInfo"];
type AgentUpdatesFilter = FetchAgentsRequestFilter;
type CreateAgentRequestMessage = Extract<SessionInboundMessage, { type: "create_agent_request" }>;

interface ResolvedSessionCreateAgentIntent {
  config: AgentSessionConfig;
  intent: CreateAgentIntent;
  createdDirectoryWorkspace: boolean;
}

type FetchWorkspacesRequestMessage = Extract<
  SessionInboundMessage,
  { type: "fetch_workspaces_request" }
>;
type FetchWorkspacesRequestFilter = NonNullable<FetchWorkspacesRequestMessage["filter"]>;
type FetchWorkspacesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_workspaces_response" }
>["payload"];
type FetchWorkspacesResponseEntry = FetchWorkspacesResponsePayload["entries"][number];
type FetchWorkspacesResponsePageInfo = FetchWorkspacesResponsePayload["pageInfo"];
type WorkspaceProjectDescriptorPayload = FetchWorkspacesResponsePayload["emptyProjects"][number];
type WorkspaceGithubSearchRepositoriesResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace.github.search_repositories.response" }
>["payload"];
type WorkspaceUpdatePayload = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];
interface WorkspaceUpdatesSubscriptionState {
  subscriptionId: string;
  filter?: WorkspaceUpdatesFilter;
  isBootstrapping: boolean;
  pendingUpdatesByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
  lastEmittedByWorkspaceId: Map<string, WorkspaceUpdatePayload>;
  visibleEmptyProjectIds?: Set<string>;
}

class SessionRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SessionRequestError";
  }
}

export interface SessionFileSystem {
  isDirectory(path: string): Promise<boolean>;
}

const nodeSessionFileSystem: SessionFileSystem = {
  async isDirectory(path) {
    const stats = await stat(path).catch(() => null);
    return stats?.isDirectory() ?? false;
  },
};

// Stub types for features under development (modules not yet available)
type AgentMcpTransportFactory = () => Promise<unknown>;

export interface SessionOptions {
  creationService?: Pick<CreationService, "create">;
  clientId: string;
  scopes: readonly string[];
  // Session-share guest sessions (spec §21 / ADR-0019): when set, this session may only touch this
  // one agent. Enforced centrally in handleMessage — any inbound message carrying a different
  // agentId is rejected, on top of the (already narrow) scope allowlist. Null/undefined = trusted
  // host session (full access, subject to scopes).
  guestAgentId?: string | null;
  // Session-share guest file/diff confinement (ADR-0019): the shared agent's workspace root. Guest
  // file/diff RPCs (keyed by a raw `cwd`) are rejected unless their resolved path stays within this
  // root — defense-in-depth on top of the capability scope. null → the guest has no file access.
  guestWorkspaceCwd?: string | null;
  // Session-share guest activity sink (ADR-0019): called with the text of each message a guest
  // sends, so the host sees who·device·what. No-op for trusted (non-guest) sessions.
  onGuestActivity?: (text: string) => void;
  appVersion?: string | null;
  clientCapabilities?: Record<string, unknown> | null;
  onMessage: (msg: SessionOutboundMessage) => void;
  onMessageToSource?: (source: object, msg: SessionOutboundMessage) => void;
  onBinaryMessage?: (frame: Uint8Array) => void;
  onBinaryMessageToSource?: (source: object, frame: Uint8Array) => Promise<void>;
  getTransportBufferedAmount?: (source?: object) => number | null;
  onLifecycleIntent?: (intent: SessionLifecycleIntent) => void;
  publishWorkspaceArchiveUpdates?: (workspaceIds: Iterable<string>) => Promise<void>;
  onWorkspaceRecovered?: (workspace: PersistedWorkspaceRecord) => Promise<void>;
  publishScriptStatusUpdate?: (message: ScriptStatusUpdateMessage) => void;
  logger: pino.Logger;
  downloadTokenStore: DownloadTokenStore;
  pushTokenStore: PushTokenStore;
  jagentdeskHome: string;
  worktreesRoot?: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  projectRegistry: ProjectRegistry;
  workspaceRegistry: WorkspaceRegistry;
  workspaceBaseBranch?: WorkspaceBaseBranchService;
  filesystem?: SessionFileSystem;
  chatService: FileBackedChatService;
  scheduleService: ScheduleService;
  autorunService?: AutorunService | null;
  specModeService?: SpecModeService | null;
  sessionShareService?: SessionShareService | null;
  // Agent activity graph (spec 31, ADR-0031); shared daemon-wide service.
  activityGraphService?: ActivityGraphService | null;
  loopService: LoopService;
  skillsStorage?: NativeSkillsService | null;
  usageHistory?: UsageHistoryStorage | null;
  hostCapabilities?: HostCapabilityService | null;
  hostToolInstaller?: HostToolInstaller | null;
  // Spec 27: the daemon-wide physical device hub (null in tests and hosts without it).
  physicalDevices?: PhysicalDeviceHub | null;
  clusterRegistry?: ClusterRegistry;
  databaseRegistry?: DatabaseRegistry;
  sshService?: SshService;
  // Remote execution (spec 33 / ADR-0044): daemon-wide service; null while the engine is
  // unavailable — its requests then get an error response instead of timing out silently.
  remoteExecService?: RemoteExecService | null;
  // Custom API providers (spec 34 / ADR-0047): daemon-wide service; null while it is
  // unavailable — its requests then get an error response instead of timing out silently.
  customProvidersService?: CustomProviderService | null;
  // Argo CD (spec 30): daemon-wide service; null when the host runs without it.
  argocdService?: ArgoCdService | null;
  /** Sideload (spec 26); null in tests and hosts that do not run it. */
  sideloadService?: SideloadService | null;
  // Daemon-wide Jira service (spec 29); absent in tests that do not exercise Jira.
  jiraService?: JiraService | null;
  botsService?: BotsService | null;
  // Daemon-wide Figma service (spec 32); absent in tests that do not exercise Figma.
  figmaService?: FigmaService | null;
  checkoutDiffManager: CheckoutDiffManager;
  github?: ForgeService;
  createAgentMcpTransport?: AgentMcpTransportFactory;
  // Injected so tests can substitute the git branch rename without module mocks;
  // defaults to the real checkout-git implementation.
  renameCurrentBranch?: typeof renameCurrentBranchDefault;
  workspaceGitService: WorkspaceGitService;
  workspaceRuntimeStore: WorkspaceRuntimeStore;
  workspaceAutoName: WorkspaceAutoName;
  daemonConfigStore: DaemonConfigStore;
  mcpBaseUrl?: string | null;
  stt: Resolvable<SpeechToTextProvider | null>;
  sttLanguage?: string;
  tts: Resolvable<TextToSpeechProvider | null>;
  speechModels?: SpeechModelsSessionOptions["runtime"];
  terminalManager: TerminalManager | null;
  providerSnapshotManager: ProviderSnapshotManager;
  providerUsageService: ProviderUsageService;
  hubExecutionAgents?: HubExecutionAgents;
  hubRelationships?: HubRelationshipManagement;
  serviceProxy?: ServiceProxySubsystem;
  scriptRuntimeStore?: WorkspaceScriptRuntimeStore;
  workspaceSetupSnapshots?: Map<string, WorkspaceSetupSnapshot>;
  workspaceArchiveOperations?: WorkspaceArchiveOperations;
  onBranchChanged?: (
    workspaceId: string,
    oldBranch: string | null,
    newBranch: string | null,
  ) => void;
  getDaemonTcpPort?: () => number | null;
  getDaemonTcpHost?: () => string | null;
  serviceProxyPublicBaseUrl?: string | null;
  resolveScriptHealth?: (hostname: string) => ScriptHealthState | null;
  voice?: {
    turnDetection?: Resolvable<TurnDetectionProvider | null>;
  };
  voiceBridge?: {
    registerVoiceSpeakHandler?: (agentId: string, handler: VoiceSpeakHandler) => void;
    unregisterVoiceSpeakHandler?: (agentId: string) => void;
    registerVoiceCallerContext?: (agentId: string, context: VoiceCallerContext) => void;
    unregisterVoiceCallerContext?: (agentId: string) => void;
  };
  dictation?: {
    finalTimeoutMs?: number;
    stt?: Resolvable<SpeechToTextProvider | null>;
    sttLanguage?: string;
    getSpeechReadiness?: () => SpeechReadinessSnapshot;
  };
  serverId?: string;
  daemonVersion?: string;
  daemonRuntimeConfig?: DaemonRuntimeConfig;
  getWebSocketRuntimeMetrics?: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  pluginRuntime?: {
    builtin?: BuiltinPluginState;
    refreshBuiltinAvailability?(): Promise<void>;
    listUsageReports?: NonNullable<UsageSessionOptions["runtime"]>["listUsageReports"];
    listLegacyUsage?: NonNullable<UsageSessionOptions["runtime"]>["listLegacyUsage"];
    wait: import("./plugins/lifecycle/index.js").PluginLifecycle["wait"];
    before: import("./plugins/lifecycle/index.js").PluginLifecycle["before"];
    emit?: import("./plugins/lifecycle/index.js").PluginLifecycle["emit"];
    listPlugins(): Promise<import("@jagentdesk/protocol/messages").PluginListItem[]>;
    getLogs(pluginId: string): import("@jagentdesk/protocol/messages").PluginLogEntry[];
    installDirectory(input: {
      path: string;
      id?: string;
    }): Promise<import("@jagentdesk/protocol/messages").PluginListItem>;
    inspectDirectory(path: string): Promise<{ id: string }>;
    installSource(input: {
      source: string;
      id?: string;
      ref?: string;
    }): Promise<import("@jagentdesk/protocol/messages").PluginListItem>;
    statusSources(
      pluginId?: string,
    ): Promise<import("@jagentdesk/protocol/messages").PluginSourceStatusItem[]>;
    previewUpdates(input: {
      pluginId?: string;
      target?: import("@jagentdesk/protocol/messages").PluginUpdateSelection;
    }): Promise<import("@jagentdesk/protocol/messages").PluginUpdatePreview[]>;
    applyUpdates(
      proposals: import("@jagentdesk/protocol/messages").PluginUpdateProposal[],
    ): Promise<import("@jagentdesk/protocol/messages").PluginUpdateResult[]>;
    updateSources(
      pluginId?: string,
    ): Promise<import("@jagentdesk/protocol/messages").PluginSourceUpdateItem[]>;
    reloadPlugin(pluginId: string): Promise<import("@jagentdesk/protocol/messages").PluginListItem>;
    enablePlugin(pluginId: string): Promise<import("@jagentdesk/protocol/messages").PluginListItem>;
    disablePlugin(
      pluginId: string,
    ): Promise<import("@jagentdesk/protocol/messages").PluginListItem>;
    removePlugin(pluginId: string): Promise<void>;
    subscribe(listener: (pluginId: string) => void): () => void;
    subscribeSettings?(listener: (pluginId: string, settingsId: string) => void): () => void;
    catalog: import("./plugins/index.js").PluginService["catalog"];
    invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
    subscribePluginRpc(
      pluginId: string,
      method: string,
      input: unknown,
    ): import("./plugins/runtime-subscription.js").PluginRuntimeSubscription;
  };
  /** Paired-device store for the `pairing.device.*` RPC surface. */
  pairedDevices?: PairedDeviceStore;
  /** The daemon's own public key, used to verify pairing registrations. */
  daemonPublicKeyB64?: string;
  pairingCodeManager?: PairingCodeManager;
  /** Declines a pending unauthenticated tailnet pairing request. */
  cancelPendingPairingRequest?: (input: {
    requestId: string;
    reason: string;
  }) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  /** Spec 05.5: closes every live socket of a revoked device on all transports. */
  closeConnectionsForDevice?: (deviceId: string) => number;
}

export type SessionLifecycleIntent =
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

interface SpecModeWiring {
  service: SpecModeService;
  session: SpecModeSession;
}

function createSpecModeWiring(
  service: SpecModeService | null | undefined,
  host: { emit: (msg: SessionOutboundMessage) => void; logger: pino.Logger },
): SpecModeWiring | null {
  if (!service) return null;
  return {
    service,
    session: new SpecModeSession({
      emit: host.emit,
      specModeService: service,
      logger: host.logger,
    }),
  };
}

function parseClientCapabilities(
  capabilities: Record<string, unknown> | null | undefined,
): ReadonlySet<ClientCapability> {
  if (!capabilities) {
    return new Set();
  }
  const known = new Set<ClientCapability>(Object.values(CLIENT_CAPS));
  const result: ClientCapability[] = [];
  for (const [key, value] of Object.entries(capabilities)) {
    if (value === true && known.has(key as ClientCapability)) {
      result.push(key as ClientCapability);
    }
  }
  return new Set(result);
}

export function isSessionRpcAllowed(scopes: readonly string[], rpcName: string): boolean {
  return scopes.some((scope) => {
    if (scope === "*" || scope === rpcName) {
      return true;
    }
    if (!scope.endsWith(".*")) {
      return false;
    }
    return rpcName.startsWith(scope.slice(0, -1));
  });
}

function sessionRequestId(message: SessionInboundMessage): string | null {
  if ("requestId" in message && typeof message.requestId === "string") {
    return message.requestId;
  }
  if (
    "payload" in message &&
    typeof message.payload === "object" &&
    message.payload !== null &&
    "requestId" in message.payload &&
    typeof message.payload.requestId === "string"
  ) {
    return message.payload.requestId;
  }
  return null;
}

type RegistryTransition = "created" | "unarchived" | "existing";

interface ArchivedRecordSnapshot {
  archivedAt?: string | null;
}

interface WorkspaceUpdateOptions {
  dedupeGitState?: boolean;
  removedProjectId?: string;
  optimisticStatus?: WorkspaceDescriptorPayload["status"];
}

function describeRegistryTransition(record: ArchivedRecordSnapshot | null): RegistryTransition {
  if (!record) {
    return "created";
  }
  return record.archivedAt ? "unarchived" : "existing";
}

// Inbound RPC types that are keyed by a raw `cwd` (filesystem path) rather than an agentId. For a
// session-share guest these are confined to the shared agent's workspace root by
// isGuestFileMessageWithinWorkspace (ADR-0019). Only READ-only file/diff types are ever placed in a
// guest's scope; write types (fs.file.write, checkout_commit, …) are never scoped in, so they are
// already unreachable — this set is the containment layer for the read types that ARE reachable.
const GUEST_FILE_CWD_RPC_TYPES: ReadonlySet<string> = new Set([
  "file_explorer_request",
  "file_download_token_request",
  "fs.file.subscribe.request",
  "subscribe_checkout_diff_request",
  // Terminal RPCs keyed by a raw `cwd` (read-only viewing). Same containment as file cwd types.
  "list_terminals_request",
  "subscribe_terminals_request",
  "unsubscribe_terminals_request",
]);

// Read-only terminal RPCs keyed by a `terminalId` rather than a cwd. For a guest these are confined
// by resolving the terminal's own cwd (via the terminal manager) and checking it against the shared
// workspace root — a guest must not subscribe to a terminal living in another workspace (ADR-0019).
const GUEST_TERMINAL_ID_RPC_TYPES: ReadonlySet<string> = new Set([
  "subscribe_terminal_request",
  "unsubscribe_terminal_request",
  "capture_terminal_request",
]);

// Resolve the session-share guest grant off SessionOptions (ADR-0019). Extracted to keep the
// Session constructor's cyclomatic complexity in check.
function resolveGuestGrant(options: SessionOptions): {
  agentId: string | null;
  workspaceCwd: string | null;
  onActivity: ((text: string) => void) | null;
} {
  return {
    agentId: options.guestAgentId ?? null,
    workspaceCwd: options.guestWorkspaceCwd ?? null,
    onActivity: options.onGuestActivity ?? null,
  };
}

/**
 * Session represents a single connected client session.
 * It owns all state management, orchestration logic, and message processing.
 * Session has no knowledge of WebSockets - it only emits and receives messages.
 */
function workspacePluginLifecycle(runtime: SessionOptions["pluginRuntime"]) {
  return runtime?.emit ? { emit: runtime.emit } : undefined;
}

function resolveWorkspaceCreationService(options: SessionOptions): Pick<CreationService, "create"> {
  return (
    options.creationService ??
    new CreationService(resolve(options.jagentdeskHome, "creations"), options.logger)
  );
}

export class Session {
  private readonly agentDirectory: AgentDirectory;
  private readonly creationService: Pick<CreationService, "create">;
  private readonly eventSubscriptions = new Map<
    string,
    { owner: OwnedSubscription; events: Set<SessionEventSubscription> }
  >();
  readonly delivery = new SessionDelivery(
    (source, message) => {
      if (isSessionRpcAllowed(this.scopes, message.type)) this.emitForSource(message, source);
    },
    (source, frame) => this.emitBinaryReply(frame, source),
  );

  private readonly clientId: string;
  private scopes: readonly string[];
  private readonly guestAgentId: string | null;
  private readonly guestWorkspaceCwd: string | null;
  private readonly onGuestActivity: ((text: string) => void) | null;
  private appVersion: string | null;
  private clientCapabilities: ReadonlySet<ClientCapability>;
  private readonly sessionId: string;
  private readonly onMessage: (msg: SessionOutboundMessage) => void;
  private readonly onMessageToSource:
    | ((source: object, msg: SessionOutboundMessage) => void)
    | null;
  private readonly onBinaryMessage: ((frame: Uint8Array) => void) | null;
  private readonly onBinaryMessageToSource:
    | ((source: object, frame: Uint8Array) => Promise<void>)
    | null;
  private readonly getTransportBufferedAmount: (source?: object) => number | null;
  private readonly onLifecycleIntent: ((intent: SessionLifecycleIntent) => void) | null;
  private readonly onWorkspaceArchiveUpdate: SessionOptions["publishWorkspaceArchiveUpdates"];
  private readonly onWorkspaceRecovered:
    | ((workspace: PersistedWorkspaceRecord) => Promise<void>)
    | null;
  private readonly speechModelsSession: SpeechModelsSession;
  private readonly sessionLogger: pino.Logger;
  private readonly jagentdeskHome: string;
  private readonly worktreesRoot: string | undefined;
  private readonly serverId: string;

  private agentManager: AgentManager;
  private readonly agentStorage: AgentStorage;
  private readonly projectRegistry: ProjectRegistry;
  private readonly workspaceRegistry: WorkspaceRegistry;
  private readonly filesystem: SessionFileSystem;
  private readonly github: ForgeService;
  private readonly renameCurrentBranch: typeof renameCurrentBranchDefault;
  private readonly workspaceGitService: WorkspaceGitService;
  private readonly workspaceRuntimeStore: WorkspaceRuntimeStore;
  private readonly workspaceAutoName: WorkspaceAutoName;
  private readonly gitMutation: GitMutationService;
  private readonly workspaceProvisioning: WorkspaceProvisioningService;
  private readonly workspaceRecovery: WorkspaceRecoveryService;
  private workspaceBaseBranch: WorkspaceBaseBranchService | undefined;
  private readonly daemonConfigStore: DaemonConfigStore;
  private readonly skillsStorage: NativeSkillsService | null;
  private readonly usageHistory: UsageHistoryStorage | null;
  private readonly hostCapabilities: HostCapabilityService | null | undefined;
  private readonly hostToolInstaller: HostToolInstaller | null | undefined;
  private readonly pushTokenStore: PushTokenStore;
  private unsubscribeAgentEvents: (() => void) | null = null;
  private unsubscribeProjectMutations: (() => void) | null = null;
  private unsubscribeWorkspaceMutations: (() => void) | null = null;
  private readonly pluginRuntime: SessionOptions["pluginRuntime"];
  private unsubscribePluginChanges: (() => void) | null = null;
  private registryMutationQueue: Promise<void> = Promise.resolve();
  private isCleanedUp = false;
  private viewedTimelineAgentIds = new Set<string>();
  private readonly viewedTimelineAgentIdsBySource = new Map<object, Set<string>>();
  private readonly clientCapabilitiesBySource = new Map<object, ReadonlySet<ClientCapability>>();
  // Tracks the client source that initiated an in-flight rewind so its own
  // timeline-replacement echo can be skipped when the replacement is delivered.
  private readonly rewindInitiators = new Map<string, object | undefined>();
  private readonly defaultTimelineSubscriptionSource = {};
  private unsubscribeTerminalWorkspaceContributionEvents: (() => void) | null = null;
  private readonly agentUpdates: AgentUpdatesService;
  private workspaceUpdatesSubscription: WorkspaceUpdatesSubscriptionState | null = null;
  private readonly workspaceUpdateTails = new Map<string, Promise<void>>();
  private clientActivity: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    focusedTerminalId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt: Date;
  } | null = null;
  private readonly terminalManager: TerminalManager | null;
  private readonly providerSnapshotManager: ProviderSnapshotManager;
  private readonly serviceProxy: ServiceProxySubsystem | null;
  private readonly scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
  private readonly getDaemonTcpPort: (() => number | null) | null;
  private readonly getDaemonTcpHost: (() => string | null) | null;
  private readonly serviceProxyPublicBaseUrl: string | null;
  private readonly resolveScriptHealth: ((hostname: string) => ScriptHealthState | null) | null;
  private readonly terminalController: TerminalSessionController;
  // A physical viewer owns its slot, replay cut, capability and buffered live tail.
  private readonly terminalStreamControllers = new Map<object, TerminalSessionController>();
  private inflightRequests = 0;
  private peakInflightRequests = 0;
  private readonly workspaceSetupSnapshots: Map<string, WorkspaceSetupSnapshot>;
  private readonly workspaceArchiveOperations: WorkspaceArchiveOperations;
  private readonly workspaceGitObserver: WorkspaceGitObserverService;
  private readonly workspaceDirectory: WorkspaceDirectory;
  private readonly voiceSession: VoiceSession;
  private readonly checkoutSession: CheckoutSession;
  private readonly forgeHubSession: ForgeHubSession;
  private readonly chatScheduleLoopSession: ChatScheduleLoopSession;
  private readonly autorunSession: AutorunSession | null;
  private readonly specMode: SpecModeWiring | null;
  private readonly sessionShareSession: SessionShareSession | null;
  private readonly activityGraphSession: ActivityGraphSession | null;
  private clusterSession!: ClusterSession;
  private databaseSession!: DatabaseSession;
  private sshSession!: SshSession;
  private argocdSession!: ArgoCdSession;
  private jiraSession: JiraSession | null = null;
  private botsSession: BotsSession | null = null;
  private figmaSession: FigmaSession | null = null;
  private sshService!: SshService;
  private remoteExecService: RemoteExecService | null = null;
  private customProvidersService: CustomProviderService | null = null;
  private sideloadSession: SideloadSession | null = null;
  private clusterRegistry!: ClusterRegistry;
  private databaseRegistry!: DatabaseRegistry;
  private readonly dockerService = new DockerService();
  private readonly dockerStreams = new DockerStreams(this.dockerService);
  private readonly remoteDockerSubscriptions = new Map<string, RoutedDocker>();
  private readonly simulatorService = new SimulatorService();
  private readonly physicalDevices: PhysicalDeviceHub | null;
  private readonly simulatorStreams: SimulatorStreams;
  private readonly physicalDeviceSession: PhysicalDeviceSession | null;
  private readonly proxyService = getSharedProxyService();
  private readonly proxySubscriptionIds = new Set<string>();
  private readonly usageSession: UsageSession;
  private readonly providerCatalogSession: ProviderCatalogSession;
  private readonly workspaceFilesSession: WorkspaceFilesSession;
  private readonly agentConfigSession: AgentConfigSession;
  private readonly projectConfigSession: ProjectConfigSession;
  private readonly daemonSession: DaemonSession;
  private readonly hubExecutionController: HubExecutionController | null;
  private readonly workspaceScripts: WorkspaceScriptsService;
  private readonly createAgentLifecycleDispatch: CreateAgentLifecycleDispatch;

  constructor(options: SessionOptions) {
    const {
      clientId,
      scopes,
      appVersion,
      clientCapabilities,
      onMessage,
      onMessageToSource,
      onBinaryMessage,
      onBinaryMessageToSource,
      getTransportBufferedAmount,
      onLifecycleIntent,
      onWorkspaceRecovered,
      publishScriptStatusUpdate,
      logger,
      downloadTokenStore,
      pushTokenStore,
      jagentdeskHome,
      worktreesRoot,
      agentManager,
      agentStorage,
      projectRegistry,
      workspaceRegistry,
      filesystem,
      chatService,
      scheduleService,
      specModeService,
      loopService,
      checkoutDiffManager,
      github,
      renameCurrentBranch,
      workspaceGitService,
      workspaceRuntimeStore,
      workspaceAutoName,
      daemonConfigStore,
      stt,
      sttLanguage,
      tts,
      speechModels,
      terminalManager,
      providerSnapshotManager,
      providerUsageService,
      workspaceArchiveOperations,
      onBranchChanged,
      voice,
      voiceBridge,
      dictation,
      serverId,
      daemonVersion,
      daemonRuntimeConfig,
      getWebSocketRuntimeMetrics,
      pluginRuntime,
      pairedDevices,
      daemonPublicKeyB64,
      pairingCodeManager,
      cancelPendingPairingRequest,
      closeConnectionsForDevice,
    } = options;
    this.clientId = clientId;
    this.scopes = [...scopes];
    const guestGrant = resolveGuestGrant(options);
    this.guestAgentId = guestGrant.agentId;
    this.guestWorkspaceCwd = guestGrant.workspaceCwd;
    this.onGuestActivity = guestGrant.onActivity;
    this.appVersion = appVersion ?? null;
    this.clientCapabilities = parseClientCapabilities(clientCapabilities);
    this.sessionId = uuidv4();
    this.onMessage = onMessage;
    this.onMessageToSource = onMessageToSource ?? null;
    this.onBinaryMessage = onBinaryMessage ?? null;
    this.onBinaryMessageToSource = onBinaryMessageToSource ?? null;
    this.getTransportBufferedAmount = getTransportBufferedAmount ?? (() => 0);
    this.onLifecycleIntent = onLifecycleIntent ?? null;
    this.onWorkspaceArchiveUpdate = options.publishWorkspaceArchiveUpdates;
    this.onWorkspaceRecovered = onWorkspaceRecovered ?? null;
    this.pushTokenStore = pushTokenStore;
    this.jagentdeskHome = jagentdeskHome;
    this.creationService = resolveWorkspaceCreationService(options);
    this.worktreesRoot = worktreesRoot;
    this.serverId = serverId ?? "";
    this.speechModelsSession = new SpeechModelsSession({
      emit: (msg) => this.emit(msg),
      runtime: speechModels,
    });
    this.sessionLogger = logger.child({
      module: "session",
      clientId: this.clientId,
      sessionId: this.sessionId,
    });
    this.workspaceFilesSession = new WorkspaceFilesSession({
      host: {
        emit: (msg, source) => this.emitForSource(msg, source),
        emitBinary: (frame, source) => this.emitBinaryReply(frame, source),
        hasBinaryChannel: () => this.onBinaryMessage !== null,
      },
      downloadTokenStore,
      jagentdeskHome,
      logger: this.sessionLogger,
    });
    this.agentManager = agentManager;
    this.agentStorage = agentStorage;
    this.projectRegistry = projectRegistry;
    this.workspaceRegistry = workspaceRegistry;
    this.filesystem = filesystem ?? nodeSessionFileSystem;
    this.github = github ?? createGitHubService();
    this.renameCurrentBranch = renameCurrentBranch ?? renameCurrentBranchDefault;
    this.workspaceGitService = workspaceGitService;
    this.workspaceRuntimeStore = workspaceRuntimeStore;
    this.workspaceBaseBranch =
      options.workspaceBaseBranch ??
      createWorkspaceBaseBranchService({
        jagentdeskHome: this.jagentdeskHome,
        worktreesRoot: this.worktreesRoot,
        workspaceRegistry: this.workspaceRegistry,
        workspaceGitService: this.workspaceGitService,
      });

    this.gitMutation = createGitMutationService({
      workspaceGitService: this.workspaceGitService,
      logger: this.sessionLogger,
    });
    this.workspaceAutoName = workspaceAutoName;
    this.workspaceProvisioning = createWorkspaceProvisioningService({
      lifecycle: workspacePluginLifecycle(pluginRuntime),
      unarchiveWorkspaceAgents: (request) =>
        unarchiveWorkspaceAgents({
          ...request,
          agentStorage: this.agentStorage,
          unarchiveAgent: (id) => unarchiveAgentState(this.agentStorage, this.agentManager, id),
          sessionLogger: this.sessionLogger,
        }),
      withCheckoutLock: this.workspaceBaseBranch.withCheckoutLock,
      serverId,
      workspaceRegistry: this.workspaceRegistry,
      projectRegistry: this.projectRegistry,
      workspaceGitService: this.workspaceGitService,
      logger: this.sessionLogger,
    });
    this.workspaceRecovery = createWorkspaceRecoveryService({
      jagentdeskHome: this.jagentdeskHome,
      worktreesRoot: this.worktreesRoot,
      getWorkspace: (workspaceId) => this.workspaceRegistry.get(workspaceId),
      getProject: (projectId) => this.projectRegistry.get(projectId),
      isDirectory: (path) => this.filesystem.isDirectory(path),
      unarchiveWorkspace: async (workspace) => {
        await this.workspaceProvisioning.ensureWorkspaceRecordUnarchived(workspace);
      },
    });
    this.checkoutSession = new CheckoutSession({
      host: {
        emit: (msg) => this.emit(msg),
        emitWorkspaceUpdateForCwd: (cwd) => this.emitWorkspaceUpdateForCwd(cwd),
        handleWorkspaceGitBranchSnapshot: (cwd, branchName) =>
          this.workspaceGitObserver.handleBranchSnapshot(cwd, branchName),
        renameCurrentBranch: (cwd, branch) => this.renameCurrentBranch(cwd, branch),
      },
      gitMutation: this.gitMutation,
      workspaceGitService: this.workspaceGitService,
      github: this.github,
      checkoutDiffManager,
      gitMetadataGenerator: createGitMetadataGenerator({
        workspaceGitService: this.workspaceGitService,
        generation: createAgentStructuredTextGeneration({
          agentManager: this.agentManager,
          providerSnapshotManager,
          readDaemonConfig: () => this.readStructuredGenerationDaemonConfig(),
          getFocusedSelection: (cwd) => this.getFocusedAgentSelectionForCwd(cwd),
        }),
      }),
      jagentdeskHome: this.jagentdeskHome,
      worktreesRoot: this.worktreesRoot,
      logger: this.sessionLogger,
    });
    // Forge Hub (spec 19 / ADR-0015): repo-scoped remote-forge reads. Token secrets
    // for method:"token" connections live in a dedicated encrypted store under home.
    const forgeSecretDir = resolve(this.jagentdeskHome, "forge");
    this.forgeHubSession = new ForgeHubSession({
      host: { emit: (msg) => this.emit(msg) },
      secretStore: new FileSecretStore(forgeSecretDir),
      // Token-connection index (connections.json) is persisted alongside the secrets.
      secretStoreDir: forgeSecretDir,
      logger: this.sessionLogger,
    });
    this.workspaceGitObserver = createWorkspaceGitObserverService({
      workspaceGitService: this.workspaceGitService,
      describeWorkspaceRecordWithGitData: (workspace) =>
        this.describeWorkspaceRecordWithGitData(workspace),
      emitWorkspaceUpdateForCwd: (cwd) => this.emitWorkspaceUpdateForCwd(cwd),
      emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
        this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
      emitStatusUpdate: (cwd, snapshot) => this.checkoutSession.emitStatusUpdate(cwd, snapshot),
      onBranchChanged,
      logger: this.sessionLogger,
    });
    this.initializeBotsSession(options.botsService);
    this.chatScheduleLoopSession = new ChatScheduleLoopSession({
      host: {
        emit: (msg) => this.emit(msg),
        listStoredAgents: () => this.agentStorage.list(),
        listLiveAgents: () => this.agentManager.listAgents(),
        resolveAgentIdentifier: (identifier) => this.resolveAgentIdentifier(identifier),
        sendAgentMessage: async (agentId, text, sourceAgentId) => {
          // A mention written by an agent is an agent message from that author; any
          // other author keeps the legacy hidden envelope (ADR-0029 decision 1).
          const authorIsAgent =
            sourceAgentId !== undefined &&
            (this.agentManager.getAgent(sourceAgentId) !== null ||
              Boolean(await this.agentStorage.get(sourceAgentId).catch(() => null)));
          if (authorIsAgent) {
            const receipt = enqueueAgentMessage(
              {
                agentManager: this.agentManager,
                agentStorage: this.agentStorage,
                logger: this.sessionLogger,
              },
              {
                recipientId: agentId,
                prompt: text,
                source: { kind: "agent-message", agentId: sourceAgentId },
                activeTurnBehavior: "steer",
                unarchive: false,
              },
            );
            await receipt.dispatched;
            return;
          }
          await sendPreparedPromptToAgent({
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            agentId,
            prompt: formatSystemNotificationPrompt(text),
            activeTurnBehavior: "steer",
            unarchive: false,
            logger: this.sessionLogger,
          });
        },
      },
      chatService,
      scheduleService,
      loopService,
      clientId: this.clientId,
      logger: this.sessionLogger,
    });
    this.specMode = createSpecModeWiring(specModeService, {
      emit: (msg) => this.emit(msg),
      logger: this.sessionLogger,
    });
    ({
      autorunSession: this.autorunSession,
      sessionShareSession: this.sessionShareSession,
      activityGraphSession: this.activityGraphSession,
      jiraSession: this.jiraSession,
    } = this.createOptionalSessions(options));
    this.initClusterSession(options);
    this.initDatabaseSession(options);
    this.initSshSession(options);
    this.argocdSession = new ArgoCdSession({
      host: { emit: (msg) => this.emit(msg) },
      service: options.argocdService ?? null,
      logger: this.sessionLogger,
      sessionKey: randomUUID(),
      canRunSsoLoopback: () => this.supports(CLIENT_CAPS.argocdSsoLoopback),
    });
    this.sideloadSession = options.sideloadService
      ? new SideloadSession({
          emit: (msg) => this.emit(msg),
          service: options.sideloadService,
          logger: this.sessionLogger,
        })
      : null;
    this.figmaSession = this.createFigmaSession(options.figmaService);
    this.usageSession = new UsageSession({
      emit: (message) => this.emit(message),
      runtime: createPluginUsageRuntime(options.pluginRuntime),
      logger: this.sessionLogger,
    });
    this.providerCatalogSession = new ProviderCatalogSession({
      host: {
        emit: (msg) => this.emit(msg),
        isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
        supportsCustomModeIcons: () => this.supports(CLIENT_CAPS.customModeIcons),
        listProviderAvailability: () => this.agentManager.listProviderAvailability(),
        listDraftFeatures: (config) => this.agentManager.listDraftFeatures(config),
      },
      providerSnapshotManager,
      providerUsageService,
      logger: this.sessionLogger,
    });
    this.agentConfigSession = new AgentConfigSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      operations: {
        ensureLoaded: async (agentId) => {
          await ensureUnarchivedAgentLoaded(agentId, {
            agentManager,
            agentStorage,
            logger: this.sessionLogger,
          });
        },
        setMode: async (agentId, modeId) =>
          (await setAgentModeCommand({ agentManager }, { agentId, modeId })).notice,
        setModel: (agentId, modelId) => agentManager.setAgentModel(agentId, modelId),
        switchProvider: (agentId, provider, modelId) =>
          agentManager.switchAgentProvider(agentId, provider, modelId),
        setFeature: (agentId, featureId, value) =>
          agentManager.setAgentFeature(agentId, featureId, value),
        setThinking: (agentId, thinkingOptionId) =>
          agentManager.setAgentThinkingOption(agentId, thinkingOptionId),
      },
      logger: this.sessionLogger,
    });
    this.projectConfigSession = new ProjectConfigSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      projectRegistry: this.projectRegistry,
      logger: this.sessionLogger,
    });
    this.daemonSession = new DaemonSession({
      host: {
        emit: (msg) => this.emit(msg),
        emitLifecycleIntent: (intent) => this.emitLifecycleIntent(intent),
      },
      clientId: this.clientId,
      jagentdeskHome: this.jagentdeskHome,
      serverId,
      daemonVersion,
      daemonRuntimeConfig,
      getWebSocketRuntimeMetrics,
      listProviderAvailability: () => this.agentManager.listProviderAvailability(),
      getTerminalsUnavailable: () => terminalManager?.getUnavailableError?.()?.message ?? null,
      listAgents: () => this.agentManager.listAgents(),
      listProjects: () => this.projectRegistry.list(),
      listWorkspaces: () => this.workspaceRegistry.list(),
      logger: this.sessionLogger,
      hubRelationships: options.hubRelationships,
      pairedDevices,
      daemonPublicKeyB64,
      pairingCodeManager,
      cancelPendingPairingRequest,
      closeConnectionsForDevice,
    });
    this.hubExecutionController = options.hubExecutionAgents
      ? new HubExecutionController({
          agents: options.hubExecutionAgents,
          send: (message) => this.emit(message),
        })
      : null;
    this.daemonConfigStore = daemonConfigStore;
    this.skillsStorage = options.skillsStorage ?? null;
    this.usageHistory = options.usageHistory ?? null;
    this.hostCapabilities = options.hostCapabilities;
    this.hostToolInstaller = options.hostToolInstaller;
    this.physicalDevices = options.physicalDevices ?? null;
    this.simulatorStreams = new SimulatorStreams(this.simulatorService, this.physicalDevices);
    this.physicalDeviceSession = this.createPhysicalDeviceSession();
    this.terminalManager = terminalManager;
    this.terminalController = new TerminalSessionController({
      terminalManager,
      emit: (msg) => this.emit(msg),
      emitBinary: (frame) => this.emitBinary(frame),
      hasBinaryChannel: () => this.onBinaryMessage !== null,
      isPathWithinRoot: (rootPath, candidatePath) => this.isPathWithinRoot(rootPath, candidatePath),
      sessionLogger: this.sessionLogger,
      listTerminalWorkspaceRefs: () => this.listActiveWorkspaceRefs(),
      supportsChunkedReplay: () => this.supports(CLIENT_CAPS.terminalChunkedReplay),
      getClientBufferedAmount: () => this.getTransportBufferedAmount(),
    });
    this.agentDirectory = new AgentDirectory({
      manager: this.agentManager,
      storage: this.agentStorage,
      workspaces: this.workspaceRegistry,
      projectLive: (agent) => this.buildAgentPayload(agent),
      projectStored: (record) => this.buildStoredAgentPayload(record),
      isProviderVisible: (provider) => this.isProviderVisibleToClient(provider),
      isStoredProviderAvailable: (record) =>
        isStoredAgentProviderAvailable(
          record,
          new Set(this.providerSnapshotManager.listRegisteredProviderIds()),
        ),
    });
    this.agentUpdates = createAgentUpdatesService({
      emit: (message) => this.emit(message),
      includesWorkspace: (agent, visibility) => this.agentDirectory.includes(agent, visibility),
      enrichAgentPayload: (payload) => this.enrichAgentPayload(payload),
      buildStoredAgentPayload: (record) => this.buildStoredAgentPayload(record),
      isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
      buildProjectPlacementForWorkspaceId: (workspaceId) =>
        this.buildProjectPlacementForWorkspaceId(workspaceId),
      emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
        this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
      logger: this.sessionLogger,
    });
    this.createAgentLifecycleDispatch = new CreateAgentLifecycleDispatch({
      jagentdeskHome: this.jagentdeskHome,
      worktreesRoot: this.worktreesRoot,
      agentManager: this.agentManager,
      agentStorage: this.agentStorage,
      github: this.github,
      workspaceGitService: this.workspaceGitService,
      createJAgentDeskWorktreeWorkflow: (input, workflowOptions) =>
        this.createJAgentDeskWorktreeWorkflow(input, workflowOptions),
      archiveAgentForClose: (agentId) => this.archiveAgentForClose(agentId),
      findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
      listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
      archiveWorkspaceRecord: (workspaceId) => this.archiveWorkspaceRecord(workspaceId),
      emit: (message) => this.emit(message),
      emitAgentRemove: (agentId) => this.agentUpdates.removeAgent(agentId),
      emitWorkspaceUpdatesForWorkspaceIds: this.publishWorkspaceArchiveUpdates,
      markWorkspaceArchiving: (workspaceIds, archivingAt) =>
        this.markWorkspaceArchiving(workspaceIds, archivingAt),
      clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
      killTerminalsForWorkspace: (workspaceId) =>
        this.terminalController.killTerminalsForWorkspace(workspaceId),
      logger: this.sessionLogger,
    });
    this.providerSnapshotManager = providerSnapshotManager;
    const optionalServiceRefs = Session.resolveOptionalServiceRefs(options);
    this.serviceProxy = optionalServiceRefs.serviceProxy;
    this.scriptRuntimeStore = optionalServiceRefs.scriptRuntimeStore;
    this.workspaceSetupSnapshots = optionalServiceRefs.workspaceSetupSnapshots;
    this.getDaemonTcpPort = optionalServiceRefs.getDaemonTcpPort;
    this.getDaemonTcpHost = optionalServiceRefs.getDaemonTcpHost;
    this.serviceProxyPublicBaseUrl = optionalServiceRefs.serviceProxyPublicBaseUrl;
    this.resolveScriptHealth = optionalServiceRefs.resolveScriptHealth;
    this.workspaceArchiveOperations = resolveWorkspaceArchiveOperations(workspaceArchiveOperations);
    this.workspaceScripts = createWorkspaceScriptsService({
      serviceProxy: this.serviceProxy,
      scriptRuntimeStore: this.scriptRuntimeStore,
      terminalManager: this.terminalManager,
      workspaceRegistry: this.workspaceRegistry,
      projectRegistry: this.projectRegistry,
      workspaceRuntimeStore: this.workspaceRuntimeStore,
      getDaemonTcpPort: this.getDaemonTcpPort,
      getDaemonTcpHost: this.getDaemonTcpHost,
      serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
      resolveScriptHealth: this.resolveScriptHealth,
      logger: this.sessionLogger,
      emit: (message) => this.emit(message),
      publishStatusUpdate: (message) => {
        if (publishScriptStatusUpdate) publishScriptStatusUpdate(message);
        else this.emit(message);
      },
      spawnWorkspaceScript,
      globalServicePorts: loadPersistedConfig(this.jagentdeskHome).worktrees?.servicePorts,
    });
    this.subscribeToOptionalManagers();
    this.workspaceDirectory = new WorkspaceDirectory({
      getArchivingAt: (workspaceId) => this.workspaceArchiveOperations.getArchivingAt(workspaceId),
      logger: this.sessionLogger,
      projectRegistry: this.projectRegistry,
      workspaceRegistry: this.workspaceRegistry,
      listAgentPayloads: () => this.listAgentPayloads(),
      listProviderSubagentActivity: async () => this.agentManager.listProviderSubagentActivity(),
      listTerminalActivityContributions: () => this.listTerminalActivityContributions(),
      isProviderVisibleToClient: (provider) => this.isProviderVisibleToClient(provider),
      buildWorkspaceDescriptor: (input) => this.buildWorkspaceDescriptor(input),
    });

    this.voiceSession = new VoiceSession({
      host: {
        emit: (msg) => this.emit(msg),
        loadAgent: (agentId) =>
          ensureAgentLoaded(agentId, {
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            logger: this.sessionLogger,
          }),
        reloadAgentSession: (agentId, overrides) =>
          this.agentManager.reloadAgentSession(agentId, overrides),
        sendSpokenInput: async (agentId, text) => {
          await this.handleSendAgentMessage(
            agentId,
            text,
            undefined,
            undefined,
            undefined,
            undefined,
            { spokenInput: true },
          );
        },
        interruptAgentIfRunning: (agentId) => this.interruptAgentIfRunning(agentId),
        hasActiveAgentRun: (agentId) => this.hasActiveAgentRun(agentId),
      },
      logger: this.sessionLogger,
      sessionId: this.sessionId,
      sttLanguage,
      tts,
      stt,
      voice,
      voiceBridge,
      dictation,
    });

    this.subscribeToAgentEvents();
    this.subscribeToRegistryMutations();

    this.pluginRuntime = pluginRuntime;
    this.unsubscribePluginChanges = this.subscribeToPluginChanges(pluginRuntime);

    this.sessionLogger.trace({}, "agent.session.lifecycle.created");
  }

  private initializeBotsSession(service: BotsService | null | undefined): void {
    this.botsSession = service ? new BotsSession(service, (msg) => this.emit(msg)) : null;
  }

  private static resolveOptionalServiceRefs(options: SessionOptions): {
    serviceProxy: ServiceProxySubsystem | null;
    scriptRuntimeStore: WorkspaceScriptRuntimeStore | null;
    workspaceSetupSnapshots: Map<string, WorkspaceSetupSnapshot>;
    getDaemonTcpPort: (() => number | null) | null;
    getDaemonTcpHost: (() => string | null) | null;
    serviceProxyPublicBaseUrl: string | null;
    resolveScriptHealth: ((hostname: string) => ScriptHealthState | null) | null;
  } {
    return {
      serviceProxy: options.serviceProxy ?? null,
      scriptRuntimeStore: options.scriptRuntimeStore ?? null,
      workspaceSetupSnapshots: options.workspaceSetupSnapshots ?? new Map(),
      getDaemonTcpPort: options.getDaemonTcpPort ?? null,
      getDaemonTcpHost: options.getDaemonTcpHost ?? null,
      serviceProxyPublicBaseUrl: options.serviceProxyPublicBaseUrl ?? null,
      resolveScriptHealth: options.resolveScriptHealth ?? null,
    };
  }

  // The sessions that exist only when their daemon-wide service is enabled. Extracted from the
  // constructor to keep its cyclomatic complexity under the lint limit.
  private createOptionalSessions(options: SessionOptions): {
    autorunSession: AutorunSession | null;
    sessionShareSession: SessionShareSession | null;
    activityGraphSession: ActivityGraphSession | null;
    jiraSession: JiraSession | null;
  } {
    return {
      autorunSession: options.autorunService
        ? new AutorunSession({
            host: { emit: (msg) => this.emit(msg) },
            autorunService: options.autorunService,
            logger: this.sessionLogger,
          })
        : null,
      sessionShareSession: options.sessionShareService
        ? new SessionShareSession({
            host: { emit: (msg) => this.emit(msg) },
            sessionShareService: options.sessionShareService,
            logger: this.sessionLogger,
          })
        : null,
      activityGraphSession: options.activityGraphService
        ? new ActivityGraphSession({
            host: {
              emit: (msg) => this.emit(msg),
              supportsActivityGraph: () => this.supports(CLIENT_CAPS.activityGraph),
              ensureAgentLoaded: async (agentId) => {
                await ensureUnarchivedAgentLoaded(agentId, {
                  agentManager: this.agentManager,
                  agentStorage: this.agentStorage,
                  logger: this.sessionLogger,
                });
              },
            },
            service: options.activityGraphService,
            logger: this.sessionLogger,
          })
        : null,
      jiraSession: options.jiraService
        ? new JiraSession({
            service: options.jiraService,
            emit: (msg) => this.emit(msg),
            logger: this.sessionLogger,
          })
        : null,
    };
  }

  private initClusterSession(options: SessionOptions): void {
    this.clusterRegistry = options.clusterRegistry ?? new ClusterRegistry();
    this.clusterSession = new ClusterSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      clusterRegistry: this.clusterRegistry,
      logger: this.sessionLogger,
    });
  }

  private initDatabaseSession(options: SessionOptions): void {
    this.databaseRegistry = options.databaseRegistry ?? new DatabaseRegistry();
    this.databaseSession = new DatabaseSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      databaseRegistry: this.databaseRegistry,
      logger: this.sessionLogger,
    });
  }

  private initSshSession(options: SessionOptions): void {
    this.sshService = options.sshService ?? new SshService();
    this.sshSession = new SshSession({
      host: {
        emit: (msg) => this.emit(msg),
      },
      sshService: this.sshService,
      logger: this.sessionLogger,
    });
    this.remoteExecService = options.remoteExecService ?? null;
    this.customProvidersService = options.customProvidersService ?? null;
  }

  // Remote execution (spec 33.8): the allowlist is the `remote_exec.` prefix, the handler map in
  // remote-exec/rpc.ts is type-checked against the six request schemas. A request missing here
  // would time out without a response.
  private dispatchRemoteExecMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!msg.type.startsWith("remote_exec.")) return undefined;
    return handleRemoteExecMessage(this.remoteExecService, msg, (out) => this.emit(out)).then(
      () => undefined,
    );
  }

  // Custom API providers (spec 34.7): the allowlist is the `providers.custom.` prefix, the handler
  // map in custom-providers/rpc.ts is type-checked against the four request schemas. A request
  // missing here would time out without a response.
  private dispatchCustomProvidersMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!msg.type.startsWith("providers.custom.")) return undefined;
    return handleCustomProvidersMessage(this.customProvidersService, msg, (out) =>
      this.emit(out),
    ).then(() => undefined);
  }

  updateAppVersion(appVersion: string | null): void {
    if (appVersion && appVersion !== this.appVersion) {
      this.appVersion = appVersion;
    }
  }

  updateClientCapabilities(capabilities: Record<string, unknown> | null, source?: object): void {
    this.clientCapabilities = parseClientCapabilities(capabilities);
    this.argocdSession?.syncDelegateRegistration();
    if (source) {
      this.delivery.attach(source, true);
      this.clientCapabilitiesBySource.set(source, this.clientCapabilities);
    }
    if (!source && !this.supports(CLIENT_CAPS.selectiveAgentTimeline)) {
      this.viewedTimelineAgentIdsBySource.clear();
      this.viewedTimelineAgentIds.clear();
    }
  }

  clearAgentTimelineSubscription(source: object): void {
    void this.delivery
      .detach(source)
      .catch((error) =>
        this.sessionLogger.warn({ err: error }, "Failed to release source subscriptions"),
      );
    this.terminalStreamControllers.get(source)?.dispose();
    this.terminalStreamControllers.delete(source);
    this.clientCapabilitiesBySource.delete(source);
    if (this.viewedTimelineAgentIdsBySource.delete(source)) {
      this.rebuildViewedTimelineAgentIds();
    }
  }

  private async handleAgentTimelineSubscription(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.set_subscription.request" }>,
    source?: object,
  ): Promise<void> {
    // Guests may only subscribe to the one shared agent. The per-agent guard inspects singular
    // `agentId`, not this plural `agentIds` array, and agent_stream/attention frames reach the
    // subscriber via onMessageToSource (which bypasses the outbound emit guard) — so clamp here
    // or a guest could subscribe to, and receive the live stream of, another agent (ADR-0019).
    const requestedAgentIds = [...new Set(msg.agentIds)].sort();
    const agentIds =
      this.guestAgentId !== null
        ? requestedAgentIds.filter((id) => id === this.guestAgentId)
        : requestedAgentIds;
    if (
      source
        ? this.supportsForSource(CLIENT_CAPS.selectiveAgentTimeline, source)
        : this.supports(CLIENT_CAPS.selectiveAgentTimeline)
    ) {
      this.replaceAgentTimelineSubscription(source, agentIds);
    }
    const freshness = msg.cursors ? await this.answerTimelineFreshness(agentIds, msg.cursors) : {};
    const response: SessionOutboundMessage = {
      type: "agent.timeline.set_subscription.response",
      payload: { agentIds, requestId: msg.requestId, ...freshness },
    };
    if (source && this.onMessageToSource) this.onMessageToSource(source, response);
    else this.emit(response);
    return;
  }

  private compareTimelineCursors(
    agentIds: string[],
    cursors: Record<string, AgentTimelineCursor>,
  ): Record<string, "current" | "behind"> {
    const timelines: Record<string, "current" | "behind"> = {};
    for (const agentId of agentIds) {
      const cursor = cursors[agentId];
      if (!cursor) continue;
      const head = this.agentManager.getLoadedTimelineHead(agentId);
      timelines[agentId] =
        head?.epoch === cursor.epoch && head.seq === cursor.seq ? "current" : "behind";
    }
    return timelines;
  }

  private async answerTimelineFreshness(
    agentIds: string[],
    cursors: Record<string, AgentTimelineCursor>,
  ): Promise<{
    timelines: Record<string, "current" | "behind">;
    agents: Record<string, AgentSnapshotPayload>;
  }> {
    const snapshots = await Promise.all(
      agentIds.flatMap((agentId) => {
        const agent = cursors[agentId] ? this.agentManager.getAgent(agentId) : null;
        return agent ? [this.buildAgentPayload(agent)] : [];
      }),
    );
    // Compared after the await, so a row appended while reading the snapshots answers behind.
    const timelines = this.compareTimelineCursors(agentIds, cursors);
    const agents: Record<string, AgentSnapshotPayload> = {};
    for (const snapshot of snapshots) {
      if (timelines[snapshot.id] === "current") agents[snapshot.id] = snapshot;
    }
    return { timelines, agents };
  }

  private replaceAgentTimelineSubscription(source: object | undefined, agentIds: string[]): void {
    const subscriptionSource = source ?? this.defaultTimelineSubscriptionSource;
    if (agentIds.length === 0) this.viewedTimelineAgentIdsBySource.delete(subscriptionSource);
    else this.viewedTimelineAgentIdsBySource.set(subscriptionSource, new Set(agentIds));
    this.rebuildViewedTimelineAgentIds();
  }

  private rebuildViewedTimelineAgentIds(): void {
    const viewedAgentIds = new Set<string>();
    for (const agentIds of this.viewedTimelineAgentIdsBySource.values()) {
      for (const agentId of agentIds) viewedAgentIds.add(agentId);
    }
    this.viewedTimelineAgentIds = viewedAgentIds;
  }

  private usesSelectiveTimelineDelivery(): boolean {
    if (this.clientCapabilitiesBySource.size === 0) {
      return this.supports(CLIENT_CAPS.selectiveAgentTimeline);
    }
    for (const capabilities of this.clientCapabilitiesBySource.values()) {
      if (!capabilities.has(CLIENT_CAPS.selectiveAgentTimeline)) return false;
    }
    return true;
  }

  // COMPAT(timelineItemCapabilities): added in v0.9.59; remove after 2027-05-23 once the client floor accepts these kinds.
  private supportsTimelineItem(item: { type: string }, source?: object): boolean {
    let capability: ClientCapability;
    if (item.type === "plugin") capability = CLIENT_CAPS.pluginTimelineItems;
    else if (item.type === "notification") capability = CLIENT_CAPS.timelineNotifications;
    else return true;
    return source ? this.supportsForSource(capability, source) : this.supports(capability);
  }

  private isQuietAgentStreamSource(source: object, agentId: string): boolean {
    return (
      this.supportsForSource(CLIENT_CAPS.explicitEventSubscriptions, source) &&
      !this.wantsEvent("agent_stream", source) &&
      !this.viewedTimelineAgentIdsBySource.get(source)?.has(agentId)
    );
  }

  private shouldFilterAgentStream(
    source: object,
    agentId: string,
    event: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"],
  ): boolean {
    return (
      this.isQuietAgentStreamSource(source, agentId) ||
      (event.type === "timeline" && !this.supportsTimelineItem(event.item, source))
    );
  }

  private hasAgentStreamDemand(source: object): boolean {
    return (
      this.supportsForSource(CLIENT_CAPS.explicitEventSubscriptions, source) &&
      this.wantsEvent("agent_stream", source)
    );
  }

  private forwardAgentStream(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
    serializedEvent: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"],
  ): void {
    if (this.clientCapabilitiesBySource.size === 0 || !this.onMessageToSource) {
      if (serializedEvent.type === "timeline" && !this.supportsTimelineItem(serializedEvent.item))
        return;
      if (this.usesSelectiveTimelineDelivery() && serializedEvent.type === "attention_required") {
        this.emit({
          type: "agent_attention_required",
          payload: {
            agentId: event.agentId,
            reason: serializedEvent.reason,
            timestamp: serializedEvent.timestamp,
            shouldNotify: serializedEvent.shouldNotify,
            ...(serializedEvent.notification ? { notification: serializedEvent.notification } : {}),
          },
        });
      } else if (
        !this.usesSelectiveTimelineDelivery() ||
        this.viewedTimelineAgentIds.has(event.agentId)
      ) {
        this.emit({
          type: "agent_stream",
          payload: this.buildAgentStreamPayload(event, serializedEvent),
        });
      }
      return;
    }

    for (const [source, capabilities] of this.clientCapabilitiesBySource) {
      if (this.shouldFilterAgentStream(source, event.agentId, serializedEvent)) continue;
      const supportsSelectiveDelivery = capabilities.has(CLIENT_CAPS.selectiveAgentTimeline);
      if (supportsSelectiveDelivery && serializedEvent.type === "attention_required") {
        this.onMessageToSource(source, {
          type: "agent_attention_required",
          payload: {
            agentId: event.agentId,
            reason: serializedEvent.reason,
            timestamp: serializedEvent.timestamp,
            shouldNotify: serializedEvent.shouldNotify,
            ...(serializedEvent.notification ? { notification: serializedEvent.notification } : {}),
          },
        });
        continue;
      }
      if (
        supportsSelectiveDelivery &&
        !this.viewedTimelineAgentIdsBySource.get(source)?.has(event.agentId) &&
        !this.hasAgentStreamDemand(source)
      ) {
        continue;
      }
      this.onMessageToSource(source, {
        type: "agent_stream",
        payload: this.buildAgentStreamPayload(event, serializedEvent),
      });
    }
  }

  supports(capability: ClientCapability): boolean {
    return this.clientCapabilities.has(capability);
  }

  supportsForSource(capability: ClientCapability, source: object): boolean {
    return (
      this.clientCapabilitiesBySource.get(source)?.has(capability) ?? this.supports(capability)
    );
  }

  emitProjectUpdate(update: ProjectUpdate): void {
    const message: SessionOutboundMessage = {
      type: "project.update",
      payload:
        update.kind === "upsert"
          ? { kind: "upsert", project: this.buildProjectDescriptor(update.project) }
          : update,
    };
    if (this.clientCapabilitiesBySource.size === 0 || !this.onMessageToSource) {
      if (this.supports(CLIENT_CAPS.projectUpdates) && this.wantsEvent("project.update"))
        this.emit(message);
      return;
    }
    for (const [source, capabilities] of this.clientCapabilitiesBySource) {
      if (
        capabilities.has(CLIENT_CAPS.projectUpdates) &&
        this.wantsEvent("project.update", source)
      ) {
        this.onMessageToSource(source, message);
      }
    }
  }

  async syncWorkspaceGitObserverForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    await this.workspaceGitObserver.syncObserverForWorkspace(workspace);
  }

  async emitWorkspaceUpdateForWorkspaceId(workspaceId: string): Promise<void> {
    await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
  }

  private async emitCreatedWorkspaceUpdate(
    workspace: WorkspaceDescriptorPayload,
    optimisticStatus?: WorkspaceDescriptorPayload["status"],
  ): Promise<void> {
    if (this.workspaceUpdatesSubscription) {
      await this.emitWorkspaceUpdatesForWorkspaceIds(
        [workspace.id],
        optimisticStatus ? { optimisticStatus } : undefined,
      );
      return;
    }
    // COMPAT(workspaceCreateCausalUpdate): added in v0.1.106, remove after 2027-01-12.
    // Older clients create before subscribing and require the causal update beside the response.
    this.emit({
      type: "workspace_update",
      payload: {
        kind: "upsert",
        workspace: optimisticStatus ? { ...workspace, status: optimisticStatus } : workspace,
      },
    });
  }

  private readonly publishWorkspaceArchiveUpdates = (
    workspaceIds: Iterable<string>,
  ): Promise<void> =>
    this.onWorkspaceArchiveUpdate?.(workspaceIds) ??
    this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds);

  async emitWorkspaceUpdatesForExternalWorkspaceIds(workspaceIds: Iterable<string>): Promise<void> {
    await this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds);
  }

  async syncWorkspaceGitObserversForExternalWorkspaceIds(
    workspaceIds: Iterable<string>,
  ): Promise<void> {
    await Promise.all(
      Array.from(new Set(workspaceIds)).map(async (workspaceId) => {
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (workspace && !workspace.archivedAt) {
          await this.workspaceGitObserver.syncObserverForWorkspace(workspace);
        }
      }),
    );
  }

  async warmWorkspaceGitDataForWorkspace(workspace: PersistedWorkspaceRecord): Promise<void> {
    await this.workspaceGitObserver.warmGitData(workspace);
  }

  async refreshRecoveredWorkspaceForExternalMutation(
    workspace: PersistedWorkspaceRecord,
  ): Promise<void> {
    try {
      await this.workspaceGitObserver.syncObserverForWorkspace(workspace);
      if (workspace.kind !== "directory") {
        // Recovery can refresh Git before this session starts observing again.
        // Publish the current status to replace any read made while archived.
        const snapshot = await this.workspaceGitService.getSnapshot(workspace.cwd, {
          includeForge: false,
        });
        this.checkoutSession.emitStatusUpdate(workspace.cwd, snapshot);
      }
      await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId },
        "Failed to warm git observer after workspace recovery",
      );
      try {
        await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
      } catch (emitError) {
        this.sessionLogger.warn(
          { err: emitError, workspaceId: workspace.workspaceId },
          "Failed to emit workspace update after recovery",
        );
      }
    }
  }

  /**
   * Get the client's current activity state
   */
  public getClientActivity(): {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    focusedTerminalId: string | null;
    lastActivityAt: Date;
    appVisible: boolean;
    appVisibilityChangedAt: Date;
  } | null {
    return this.clientActivity;
  }

  private getFocusedAgentSelectionForCwd(cwd: string):
    | {
        provider?: string | null;
        model?: string | null;
        thinkingOptionId?: string | null;
      }
    | undefined {
    const focusedAgentId = this.clientActivity?.focusedAgentId;
    if (!focusedAgentId) {
      return undefined;
    }

    const agent = this.agentManager.getAgent(focusedAgentId);
    if (!agent || agent.cwd !== cwd) {
      return undefined;
    }

    return {
      provider: agent.provider,
      model: agent.runtimeInfo?.model ?? agent.config.model ?? null,
      thinkingOptionId:
        agent.runtimeInfo?.thinkingOptionId ?? agent.config.thinkingOptionId ?? null,
    };
  }

  private readStructuredGenerationDaemonConfig(): StructuredGenerationDaemonConfig {
    return {
      metadataGeneration: this.daemonConfigStore.get().metadataGeneration,
    };
  }

  public getRuntimeMetrics(): SessionRuntimeMetrics {
    const terminalMetrics = this.terminalController.getMetrics();
    for (const controller of this.terminalStreamControllers.values()) {
      terminalMetrics.streamSubscriptionCount += controller.getMetrics().streamSubscriptionCount;
    }
    const workspaceGitMetrics = this.workspaceGitObserver.getMetrics();
    return {
      terminalDirectorySubscriptionCount: terminalMetrics.directorySubscriptionCount,
      terminalSubscriptionCount: terminalMetrics.streamSubscriptionCount,
      workspaceGitWatchedDirectoryCount: workspaceGitMetrics.watchedDirectoryCount,
      workspaceGitWorkspaceRecordCount: workspaceGitMetrics.workspaceRecordCount,
      workspaceGitSubscriptionCount: workspaceGitMetrics.subscriptionCount,
      inflightRequests: this.inflightRequests,
      peakInflightRequests: this.peakInflightRequests,
    };
  }

  public emitServerMessage(message: SessionOutboundMessage): void {
    this.emit(message);
  }

  /**
   * remote_exec.job_updated (spec 33.8): bootstrap pushes every job change here; the emit gate
   * drops sessions whose scopes cannot read it (workspace.read on the permission table).
   */
  public emitRemoteExecJobUpdated(job: RemoteJob): void {
    this.emit(remoteExecJobUpdated(job));
  }

  /**
   * Send initial state to client after connection
   */
  public async sendInitialState(): Promise<void> {
    // No unsolicited agent list hydration. Callers must use fetch_agents_request.
  }

  /**
   * Interrupt the agent's active run so the next prompt starts a fresh turn.
   * Returns once the manager confirms the stream has been cancelled.
   */
  private async interruptAgentIfRunning(agentId: string): Promise<void> {
    const snapshot = this.agentManager.getAgent(agentId);
    if (!snapshot) {
      this.sessionLogger.trace({ agentId }, "agent.session.interrupt.not_found");
      throw new Error(`Agent ${agentId} not found`);
    }

    const hasInFlightRun = this.agentManager.hasInFlightRun(agentId);
    if (!hasInFlightRun) {
      this.sessionLogger.trace(
        {
          agentId,
          provider: snapshot.provider,
          lifecycle: snapshot.lifecycle,
          hasInFlightRun,
        },
        "agent.session.interrupt.skip_not_running",
      );
      return;
    }

    this.sessionLogger.debug(
      { agentId, lifecycle: snapshot.lifecycle, hasInFlightRun },
      "interruptAgentIfRunning: interrupting",
    );

    const t0 = Date.now();
    const cancellation = await this.agentManager.cancelAgentRun(agentId);
    this.sessionLogger.debug(
      { agentId, cancellation: cancellation.status, durationMs: Date.now() - t0 },
      "interruptAgentIfRunning: cancelAgentRun completed",
    );
    if (cancellation.status === "refused") {
      this.sessionLogger.warn(
        { agentId },
        "interruptAgentIfRunning: reported running but no active run was cancelled",
      );
      throw new AgentRunCancellationError(agentId, "stop");
    }
  }

  private hasActiveAgentRun(agentId: string | null): boolean {
    if (!agentId) {
      return false;
    }
    return this.agentManager.hasInFlightRun(agentId);
  }

  private handleAgentRunError(agentId: string, error: unknown, context: string): void {
    const message = errorToFriendlyMessage(error);
    this.sessionLogger.error({ err: error, agentId, context }, `${context} for agent ${agentId}`);
    this.emit({
      type: "activity_log",
      payload: {
        id: uuidv4(),
        timestamp: new Date(),
        type: "error",
        content: `${context}: ${message}`,
      },
    });
  }

  /**
   * Subscribe to AgentManager events and forward them to the client
   */
  private subscribeToOptionalManagers(): void {
    this.terminalController.start();
    if (this.terminalManager) {
      this.unsubscribeTerminalWorkspaceContributionEvents =
        this.terminalManager.subscribeTerminalWorkspaceContributionChanged((event) => {
          void this.emitWorkspaceUpdateForTerminalContribution(event).catch((error) => {
            this.sessionLogger.warn(
              { err: error, terminalId: event.terminalId },
              "Failed to emit workspace update after terminal contribution changed",
            );
          });
        });
    }
    this.providerCatalogSession.start();
  }

  private subscribeToRegistryMutations(): void {
    this.unsubscribeProjectMutations?.();
    this.unsubscribeProjectMutations =
      this.projectRegistry.subscribeToMutations?.((mutation) =>
        this.enqueueRegistryMutation(() => this.handleProjectMutation(mutation)),
      ) ?? null;
    this.unsubscribeWorkspaceMutations?.();
    this.unsubscribeWorkspaceMutations =
      this.workspaceRegistry.subscribeToMutations?.((mutation) =>
        this.enqueueRegistryMutation(() => this.handleWorkspaceMutation(mutation)),
      ) ?? null;
  }

  private enqueueRegistryMutation(handleMutation: () => Promise<void>): Promise<void> {
    const next = this.registryMutationQueue.then(handleMutation);
    this.registryMutationQueue = next.catch(() => {});
    return next;
  }

  private async handleWorkspaceMutation(mutation: WorkspaceMutation): Promise<void> {
    try {
      if (this.isCleanedUp) {
        return;
      }
      if (
        mutation.kind === "archive" ||
        mutation.kind === "remove" ||
        mutation.workspace?.archivedAt
      ) {
        this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
      } else {
        await this.syncWorkspaceMutationObserver(mutation);
      }
      if (this.isCleanedUp) {
        return;
      }
      await this.emitWorkspaceUpdatesForWorkspaceIds(
        [mutation.workspaceId],
        mutation.expectsInitialAgent ? { optimisticStatus: "running" } : undefined,
      );
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, workspaceId: mutation.workspaceId, mutationKind: mutation.kind },
        "Failed to apply workspace mutation to session",
      );
    }
  }

  private async syncWorkspaceMutationObserver(mutation: WorkspaceMutation): Promise<void> {
    const subscription = this.workspaceUpdatesSubscription;
    if (!mutation.workspace || !subscription) {
      return;
    }
    const descriptorsByWorkspaceId = await this.buildWorkspaceDescriptorMap({
      workspaceIds: [mutation.workspaceId],
      includeGitData: false,
    });
    const descriptor = descriptorsByWorkspaceId.get(mutation.workspaceId);
    if (
      !descriptor ||
      !this.matchesWorkspaceFilter({ workspace: descriptor, filter: subscription.filter })
    ) {
      this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
      return;
    }
    const currentWorkspace = await this.workspaceRegistry.get(mutation.workspaceId);
    if (!currentWorkspace || currentWorkspace.archivedAt) {
      this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
      return;
    }
    await this.workspaceGitObserver.syncObserverForWorkspace(currentWorkspace);
    if (this.isCleanedUp) {
      this.workspaceGitObserver.removeForWorkspaceId(mutation.workspaceId);
    }
  }

  private async handleProjectMutation(mutation: ProjectMutation): Promise<void> {
    try {
      const subscription = this.workspaceUpdatesSubscription;
      if (this.isCleanedUp || !subscription) {
        return;
      }
      const projectWorkspaceIds = (await this.workspaceRegistry.list())
        .filter((workspace) => workspace.projectId === mutation.projectId)
        .map((workspace) => workspace.workspaceId);

      if (mutation.kind === "remove") {
        const visibleWorkspaceIds = projectWorkspaceIds.filter((workspaceId) => {
          const lastEmitted = subscription.lastEmittedByWorkspaceId.get(workspaceId);
          return (
            lastEmitted?.kind === "upsert" ||
            (lastEmitted?.kind === "remove" &&
              lastEmitted.emptyProject?.projectId === mutation.projectId)
          );
        });
        let updateIds = visibleWorkspaceIds;
        if (
          updateIds.length === 0 &&
          subscription.visibleEmptyProjectIds?.has(mutation.projectId)
        ) {
          updateIds = [mutation.projectId];
        }
        if (updateIds.length === 0) {
          return;
        }
        for (const workspaceId of projectWorkspaceIds) {
          this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
        }
        await this.emitWorkspaceUpdatesForWorkspaceIds(updateIds, {
          removedProjectId: mutation.projectId,
        });
        return;
      }

      if (mutation.kind === "archive" || mutation.project?.archivedAt) {
        for (const workspaceId of projectWorkspaceIds) {
          this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
        }
      }
      await this.emitWorkspaceUpdatesForWorkspaceIds(projectWorkspaceIds);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, projectId: mutation.projectId, mutationKind: mutation.kind },
        "Failed to apply project mutation to session",
      );
    }
  }

  private subscribeToAgentEvents(): void {
    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
    }

    this.unsubscribeAgentEvents = this.agentManager.subscribe(
      (event) => {
        if (event.type === "timeline_replacement") {
          this.deliverTimelineReplacement(event.agentId, this.rewindInitiators.get(event.agentId));
          return;
        }

        if (event.type === "agent_state") {
          this.sessionLogger.trace(
            {
              agentId: event.agent.id,
              provider: event.agent.provider,
              providerSessionId: event.agent.persistence?.sessionId ?? undefined,
              turnId: event.agent.activeForegroundTurnId ?? undefined,
              lifecycle: event.agent.lifecycle,
            },
            "agent.session.forward_update",
          );
          void this.agentUpdates.forwardLiveAgent(event.agent);
          return;
        }

        if (event.type === "provider_subagent") {
          this.emitProviderSubagentWorkspaceUpdate(event.event);
          if (!this.supports(CLIENT_CAPS.providerSubagents)) {
            return;
          }
          const update = event.event;
          if (update.type === "upsert") {
            this.emit({
              type: "agent.provider_subagents.update",
              payload: { kind: "upsert", subagent: update.subagent },
            });
          } else if (update.type === "timeline") {
            // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove gate after 2027-03-14.
            // Older clients keep child names/status; the child transcript needs the projected
            // fetch contract, so they get an upgrade notice when opening it instead of live rows.
            if (
              !this.supports(CLIENT_CAPS.projectedSubagentTimeline) ||
              !this.supportsTimelineItem(update.row.item)
            ) {
              return;
            }
            this.emit({
              type: "agent.provider_subagents.update",
              payload: {
                kind: "timeline",
                parentAgentId: update.parentAgentId,
                subagentId: update.subagentId,
                provider: update.provider,
                item: update.row.item,
                timestamp: update.row.timestamp,
                seq: update.row.seq,
                epoch: update.epoch,
              },
            });
          } else {
            this.emit({
              type: "agent.provider_subagents.update",
              payload: {
                kind: "remove",
                parentAgentId: update.parentAgentId,
                subagentId: update.subagentId,
              },
            });
          }
          return;
        }

        if (event.type === "background_work") {
          void this.forwardBackgroundWork(event.agentId).catch((error) =>
            this.sessionLogger.error(
              { err: error, agentId: event.agentId },
              "Failed to emit background work update",
            ),
          );
          return;
        }

        if (
          this.voiceSession.isActiveForAgent(event.agentId) &&
          event.event.type === "permission_requested" &&
          isVoicePermissionAllowed(event.event.request)
        ) {
          const requestId = event.event.request.id;
          void this.agentManager
            .respondToPermission(event.agentId, requestId, {
              behavior: "allow",
            })
            .catch((error) => {
              this.sessionLogger.warn(
                {
                  err: error,
                  agentId: event.agentId,
                  requestId,
                },
                "Failed to auto-allow speak tool permission in voice mode",
              );
            });
        }

        const serializedEvent = serializeAgentStreamEvent(event.event);
        if (!serializedEvent) {
          return;
        }
        this.sessionLogger.trace(
          {
            agentId: event.agentId,
            provider: event.event.provider,
            turnId: getAgentStreamEventTurnId(event.event),
            seq: event.seq,
            epoch: event.epoch,
            event: event.event,
          },
          "agent.session.forward_stream",
        );

        this.forwardAgentStream(event, serializedEvent);

        if (event.event.type === "permission_requested") {
          this.emit({
            type: "agent_permission_request",
            payload: {
              agentId: event.agentId,
              request: event.event.request,
            },
          });
        } else if (event.event.type === "permission_resolved") {
          this.emit({
            type: "agent_permission_resolved",
            payload: {
              agentId: event.agentId,
              requestId: event.event.requestId,
              resolution: event.event.resolution,
            },
          });
        }

        // Title updates may be applied asynchronously after agent creation.
      },
      { replayState: false },
    );
  }

  private async forwardBackgroundWork(agentId: string): Promise<void> {
    const target = await this.resolveBackgroundWorkAgent(agentId);
    if ("error" in target) return;
    const { agent, record } = target;
    // The inventory may have changed while resolving a dormant agent.
    const items = this.agentManager.getAgentBackgroundWorkSummary(agentId)
      ? this.agentManager.listAgentBackgroundWork(agentId)
      : [];
    this.emit({
      type: "agent.background_work.update",
      payload: { agentId, items: this.projectBackgroundWorkItems(items) },
    });
    if (agent) await this.agentUpdates.forwardLiveAgent(agent);
    else if (record) await this.agentUpdates.forwardStoredAgent(record);
  }

  private projectBackgroundWorkItems(items: AgentBackgroundWorkItem[]): AgentBackgroundWorkItem[] {
    if (
      isSessionRpcAllowed(this.scopes, "schedule/delete") &&
      isSessionRpcAllowed(this.scopes, "agent.background_work.stop.request")
    ) {
      return items;
    }
    return items.map((item) => {
      if (!isDaemonBackgroundWorkItem(item)) return item;
      const { canStop: _canStop, stopToken: _stopToken, ...visible } = item;
      return visible;
    });
  }

  private emitProviderSubagentWorkspaceUpdate(event: ProviderSubagentManagerEvent): void {
    if (event.type === "timeline") {
      return;
    }
    const parentAgentId =
      event.type === "upsert" ? event.subagent.parentAgentId : event.parentAgentId;
    const parent = this.agentManager.getAgent(parentAgentId);
    if (!parent?.workspaceId) {
      return;
    }
    void this.emitWorkspaceUpdateForWorkspaceId(parent.workspaceId).catch((error) => {
      this.sessionLogger.error(
        { err: error, parentAgentId, workspaceId: parent.workspaceId },
        "Failed to emit provider subagent workspace update",
      );
    });
  }

  private buildAgentStreamPayload(
    event: Extract<AgentManagerEvent, { type: "agent_stream" }>,
    serializedEvent: Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"]["event"],
  ): Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"] {
    return {
      agentId: event.agentId,
      event: serializedEvent,
      timestamp: event.timestamp ?? new Date().toISOString(),
      ...(typeof event.seq === "number" ? { seq: event.seq } : {}),
      ...(typeof event.epoch === "string" ? { epoch: event.epoch } : {}),
    };
  }

  private async enrichAgentPayload(payload: AgentSnapshotPayload): Promise<AgentSnapshotPayload> {
    const storedRecord = await this.agentStorage.get(payload.id);
    payload.title = storedRecord?.title ?? null;
    payload.archivedAt = storedRecord?.archivedAt ?? null;
    if (!payload.internal && !storedRecord?.internal && !payload.archivedAt) {
      payload.backgroundWork = this.agentManager.getAgentBackgroundWorkSummary(payload.id);
    }
    return payload;
  }

  private buildAgentPayload(agent: ManagedAgent): Promise<AgentSnapshotPayload> {
    return this.enrichAgentPayload(toAgentPayload(agent));
  }

  private buildStoredAgentPayload(
    record: StoredAgentRecord,
    registeredProviderIds = new Set(this.providerSnapshotManager.listRegisteredProviderIds()),
  ): AgentSnapshotPayload {
    return buildStoredAgentPayload(
      record,
      registeredProviderIds,
      this.agentManager.getAgentBackgroundWorkSummary(record.id),
    );
  }

  private isProviderVisibleToClient(provider: string): boolean {
    if (clientSupportsAllProviders(this.appVersion)) {
      return true;
    }
    return LEGACY_PROVIDER_IDS.has(provider);
  }

  private async buildProjectPlacementForWorkspace(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<ProjectPlacementPayload> {
    const project = projectRecord ?? (await this.projectRegistry.get(workspace.projectId));
    if (!project) {
      throw new Error(`Project not found for workspace ${workspace.workspaceId}`);
    }
    const snapshot = this.workspaceRuntimeStore.get(workspace.cwd);
    const checkout = checkoutFromPersistedWorkspacePlacement({
      workspace,
      // COMPAT(workspacePlacementBackfill): added in v0.1.107, remove after 2027-01-15.
      // Legacy records can lack branch and worktreeRoot because persisted registries
      // are not migrated in place.
      fallbackBranch: snapshot?.git.currentBranch ?? null,
      fallbackWorktreeRoot: snapshot?.git.repoRoot,
    });
    return {
      projectKey: project.projectId,
      projectName: resolveProjectDisplayName(project),
      workspaceName: resolveWorkspaceDisplayName(workspace),
      checkout,
    };
  }

  private async buildProjectPlacementForWorkspaceId(
    workspaceId: string,
  ): Promise<ProjectPlacementPayload | null> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) return null;

    const project = await this.projectRegistry.get(workspace.projectId);
    if (!project) return null;
    return this.buildProjectPlacementForWorkspace(workspace, project);
  }

  /**
   * Main entry point for processing session messages
   */
  public async handleMessage(msg: SessionInboundMessage, source?: object): Promise<void> {
    return this.delivery.request(source, msg, () => this.handleRequest(msg, source));
  }

  private async handleRequest(msg: SessionInboundMessage, source?: object): Promise<void> {
    this.inflightRequests++;
    if (this.inflightRequests > this.peakInflightRequests) {
      this.peakInflightRequests = this.inflightRequests;
    }
    try {
      // Stringifying a binary plugin input costs its size; test logger stubs lack isLevelEnabled.
      if (this.sessionLogger.isLevelEnabled?.("trace"))
        this.sessionLogger.trace(
          {
            messageType: msg.type,
            payloadBytes: JSON.stringify(msg).length,
          },
          "agent.session.inbound",
        );
      if (!isSessionRpcAllowed(this.scopes, msg.type)) {
        const requestId = sessionRequestId(msg);
        if (requestId) {
          this.emit({
            type: "rpc_error",
            payload: {
              requestId,
              requestType: msg.type,
              error: `Session is not authorized for ${msg.type}`,
              code: "access_denied",
            },
          });
        }
        return;
      }
      // Guest session (session-share, ADR-0019): confined to one agent + its workspace. All the
      // per-agent / file / terminal containment checks + activity attribution live in one helper so
      // this dispatch stays simple. A non-null return is the denial reason.
      if (this.guestAgentId !== null) {
        const denyReason = this.guestDenyReason(msg);
        if (denyReason) {
          const requestId = sessionRequestId(msg);
          if (requestId) {
            this.emit({
              type: "rpc_error",
              payload: {
                requestId,
                requestType: msg.type,
                error: denyReason,
                code: "access_denied",
              },
            });
          }
          return;
        }
        this.trackGuestActivity(msg);
      }
      try {
        const plugin = builtinPluginForRpc(msg.type);
        if (
          plugin &&
          this.pluginRuntime?.builtin &&
          !this.pluginRuntime.builtin.isEnabled(plugin)
        ) {
          throw new BuiltinPluginError("plugin_disabled", `Plugin turned off: ${plugin}`);
        }
        await this.dispatchInboundMessage(msg, source);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logRequestError(err);

        const requestId =
          "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : undefined;
        if (typeof requestId === "string") {
          try {
            this.emit({
              type: "rpc_error",
              payload: {
                requestId,
                requestType: msg.type,
                error: `Request failed: ${err.message}`,
                code: error instanceof BuiltinPluginError ? error.code : "handler_error",
              },
            });
          } catch (emitError) {
            this.sessionLogger.error({ err: emitError }, "Failed to emit rpc_error");
          }
        }

        this.emit({
          type: "activity_log",
          payload: {
            id: uuidv4(),
            timestamp: new Date(),
            type: "error",
            content: `Error: ${err.message}`,
          },
        });
      }
    } finally {
      this.inflightRequests--;
    }
  }

  public setScopes(scopes: readonly string[]): void {
    if (!isSessionRpcAllowed(scopes, "plugin.rpc.invoke.request"))
      void this.delivery
        .releaseFamily("plugin-rpc")
        .catch((error) =>
          this.sessionLogger.warn({ err: error }, "Failed to release plugin subscriptions"),
        );
    this.scopes = [...scopes];
  }

  // Re-scope a LIVE guest session when the host toggles share capabilities (ADR-0019). Without this
  // an already-connected guest keeps its connect-time scope, so a newly-granted tab's request is
  // denied ("Session is not authorized") until the guest reloads. Only affects the guest confined to
  // `agentId`; returns true if this session was re-scoped.
  public updateGuestScopesIfForAgent(agentId: string, scopes: readonly string[]): boolean {
    if (this.guestAgentId === null || this.guestAgentId !== agentId) return false;
    this.setScopes(scopes);
    return true;
  }

  // For a guest session, any message that names an agent must name THE shared agent — applied to
  // BOTH inbound RPCs and outbound pushes/responses (defense in depth: even if a broadcast type
  // were ever in scope, another agent's data can never reach the guest). Messages with no
  // detectable agentId are governed solely by the tight scope allowlist.
  private guestMessageTouchesOtherAgent(
    msg: SessionInboundMessage | SessionOutboundMessage,
  ): boolean {
    if (this.guestAgentId === null) return false;
    const direct = (msg as { agentId?: unknown }).agentId;
    if (typeof direct === "string" && direct !== this.guestAgentId) return true;
    const payload = (msg as { payload?: unknown }).payload as
      | { agentId?: unknown; agent?: { id?: unknown } }
      | undefined;
    if (payload && typeof payload === "object") {
      if (typeof payload.agentId === "string" && payload.agentId !== this.guestAgentId) return true;
      const nested = payload.agent?.id;
      if (typeof nested === "string" && nested !== this.guestAgentId) return true;
    }
    return false;
  }

  private isGuestMessageAllowed(msg: SessionInboundMessage): boolean {
    return !this.guestMessageTouchesOtherAgent(msg);
  }

  // Single entry point for guest containment (ADR-0019): per-agent + file/terminal workspace scope.
  // Returns a human-readable denial reason, or null when the message is allowed.
  private guestDenyReason(msg: SessionInboundMessage): string | null {
    if (!this.isGuestMessageAllowed(msg)) return "Guest session is limited to the shared agent";
    if (
      !this.isGuestFileMessageWithinWorkspace(msg) ||
      !this.isGuestTerminalMessageWithinWorkspace(msg)
    ) {
      return "Guest session is limited to the shared workspace";
    }
    return null;
  }

  // Attribute a guest's outgoing chat message onto the share (host presence/activity, ADR-0019).
  private trackGuestActivity(msg: SessionInboundMessage): void {
    if (!this.onGuestActivity || msg.type !== "send_agent_message_request") return;
    const text = (msg as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) this.onGuestActivity(text);
  }

  // Guest file/diff RPCs (ADR-0019) are keyed by a raw `cwd` (+ optional `path`) rather than an
  // agentId, so the per-agent guard cannot confine them. Reject any such RPC whose resolved target
  // escapes the shared agent's workspace root — defense-in-depth on top of the capability scope.
  // Non-file messages and trusted (non-guest) sessions are unaffected.
  // True iff `target` (already-resolved or to-be-resolved absolute path) stays within the guest's
  // shared workspace root. Returns false when there is no root (no file/terminal access).
  private isPathWithinGuestWorkspace(target: string): boolean {
    const root = this.guestWorkspaceCwd;
    if (!root) return false;
    const resolvedRoot = resolve(root);
    const resolved = resolve(target);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + sep);
  }

  private isGuestFileMessageWithinWorkspace(msg: SessionInboundMessage): boolean {
    if (this.guestAgentId === null) return true;
    if (!GUEST_FILE_CWD_RPC_TYPES.has(msg.type)) return true;
    const cwd = (msg as { cwd?: unknown }).cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return false;
    if (!this.isPathWithinGuestWorkspace(cwd)) return false;
    // file_explorer/file_download carry a `path` relative to cwd — it must also stay contained
    // (blocks `..`/absolute-path traversal out of the workspace).
    const rel = (msg as { path?: unknown }).path;
    if (
      typeof rel === "string" &&
      rel.length > 0 &&
      !this.isPathWithinGuestWorkspace(resolve(cwd, rel))
    )
      return false;
    return true;
  }

  // Terminal RPCs keyed by `terminalId` (read-only). Resolve the terminal's own cwd via the terminal
  // manager and require it to be within the shared workspace root — so a guest cannot subscribe to,
  // or capture, a terminal that lives in another workspace (ADR-0019). Unknown terminal → deny.
  private isGuestTerminalMessageWithinWorkspace(msg: SessionInboundMessage): boolean {
    if (this.guestAgentId === null) return true;
    if (!GUEST_TERMINAL_ID_RPC_TYPES.has(msg.type)) return true;
    const terminalId = (msg as { terminalId?: unknown }).terminalId;
    if (typeof terminalId !== "string" || terminalId.length === 0) return false;
    const terminalCwd = this.terminalManager?.getTerminal(terminalId)?.cwd;
    if (typeof terminalCwd !== "string" || terminalCwd.length === 0) return false;
    return this.isPathWithinGuestWorkspace(terminalCwd);
  }

  private async subscribeProviderUpdates(
    request: Extract<
      SessionInboundMessage,
      { type: "provider.installation.update.subscribe.request" }
    >,
  ): Promise<void> {
    if (!this.delivery.isModern(this.delivery.currentSource))
      throw new Error("Provider update observation requires owned subscriptions");
    const installations = this.providerSnapshotManager.installations;
    let stop: (() => void) | undefined;
    const owner = this.delivery.begin("provider-update", undefined, () => stop?.());
    // Register and read in one synchronous turn so no progress falls between them.
    stop = installations.observeUpdates(request.provider, (event) => owner.emit(event));
    this.emit({
      type: "provider.installation.update.subscribe.response",
      payload: {
        requestId: request.requestId,
        subscriptionId: owner.responseId,
        provider: request.provider,
        update: installations.getUpdate(request.provider),
        error: null,
      },
    });
  }

  private async dispatchInboundMessage(msg: SessionInboundMessage, source?: object): Promise<void> {
    // Ordered dispatchers: the first one that recognizes the message returns a
    // (possibly async) result and the rest are skipped — matching the previous
    // left-to-right `??` short-circuit chain exactly.
    const dispatchers: Array<() => Promise<void> | undefined> = [
      () =>
        msg.type === "provider.installation.update.subscribe.request"
          ? this.subscribeProviderUpdates(msg)
          : undefined,
      () => this.speechModelsSession.dispatch(msg),
      () => this.dispatchVoiceAndControlMessage(msg),
      () => this.dispatchAgentRewindMessage(msg),
      () => this.dispatchAgentRelationshipMessage(msg),
      () => this.dispatchAgentTimelineMessage(msg, source),
      () => this.dispatchHubExecutionMessage(msg),
      () => this.dispatchAgentLifecycleMessage(msg),
      () => this.dispatchOrchestrationMessage(msg),
      () => this.dispatchSkillsMessage(msg),
      () => this.dispatchUsageMessage(msg),
      () => this.dispatchAgentConfigMessage(msg),
      () => this.dispatchCheckoutMessage(msg),
      () => this.dispatchWorkspaceRecoveryMessage(msg),
      () => this.dispatchWorkspaceAndProjectMessage(msg),
      () => this.dispatchWorkspaceFileMessage(msg, source),
      () => this.dispatchProviderMessage(msg),
      () => this.dispatchTerminalMessage(msg, source),
      () => this.dispatchChatScheduleLoopMessage(msg),
      () => this.dispatchAutorunMessage(msg),
      () => this.dispatchSpecModeMessage(msg, source),
      () => this.dispatchSessionShareMessage(msg),
      () => this.activityGraphSession?.dispatch(msg),
      () => this.dispatchClusterMessage(msg),
      () => this.dispatchDatabaseMessage(msg),
      () => this.dispatchSshMessage(msg),
      () => this.dispatchRemoteExecMessage(msg),
      () => this.dispatchCustomProvidersMessage(msg),
      () => this.dispatchArgoCdMessage(msg),
      () => this.dispatchSideloadMessage(msg),
      () => this.botsSession?.dispatch(msg),
      () => this.dispatchJiraMessage(msg),
      () => this.dispatchFigmaMessage(msg),
      () => this.dispatchDockerMessage(msg),
      () => this.dispatchSimulatorMessage(msg),
      () => this.dispatchProxyMessage(msg),
      () => this.dispatchMigrationMessage(msg),
      () => this.dispatchBuiltinPluginMessage(msg),
      () => this.dispatchPluginMessage(msg),
      () => this.dispatchPluginRpcMessage(msg),
      () => this.dispatchPluginDirectoryMessage(msg),
      () => this.dispatchMiscMessage(msg),
    ];
    let promise: Promise<void> | undefined;
    for (const dispatch of dispatchers) {
      promise = dispatch();
      if (promise) break;
    }
    if (promise) await promise;
  }

  private dispatchBuiltinPluginMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "plugins.builtin.list.request") {
      return Promise.resolve().then(async () => {
        if (!this.pluginRuntime?.builtin)
          throw new Error("Built-in plugin registry is unavailable");
        await this.pluginRuntime.refreshBuiltinAvailability?.();
        return this.emit({
          type: "plugins.builtin.list.response",
          payload: {
            requestId: msg.requestId,
            ...builtinPluginWireState(this.pluginRuntime.builtin.list()),
            canManage: isSessionRpcAllowed(this.scopes, "plugins.builtin.set.request"),
          },
        });
      });
    }
    if (msg.type === "plugins.builtin.set.request") {
      if (!this.pluginRuntime?.builtin) throw new Error("Built-in plugin registry is unavailable");
      return this.pluginRuntime.builtin.set(msg.id, msg.enabled, msg.cascade).then((plugins) => {
        return this.emit({
          type: "plugins.builtin.set.response",
          payload: { requestId: msg.requestId, ...builtinPluginWireState(plugins) },
        });
      });
    }
    return undefined;
  }

  private dispatchPluginMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "plugin.list.request") {
      return (this.pluginRuntime?.listPlugins() ?? Promise.resolve([])).then((plugins) => {
        this.emit({
          type: "plugin.list.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.logs.get.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      this.emit({
        type: "plugin.logs.get.response",
        payload: {
          requestId: msg.requestId,
          pluginId: msg.pluginId,
          entries: this.pluginRuntime.getLogs(msg.pluginId),
        },
      });
      return undefined;
    }
    if (msg.type === "plugin.reload.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.reloadPlugin(msg.pluginId).then((plugin) => {
        this.emit({
          type: "plugin.reload.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.enable.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.enablePlugin(msg.pluginId).then((plugin) => {
        this.emit({
          type: "plugin.enable.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.disable.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.disablePlugin(msg.pluginId).then((plugin) => {
        this.emit({
          type: "plugin.disable.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.remove.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.removePlugin(msg.pluginId).then(() => {
        this.emit({ type: "plugin.remove.response", payload: { requestId: msg.requestId } });
        return undefined;
      });
    }
    if (msg.type === "plugin.catalog.get.request") {
      this.emit({
        type: "plugin.catalog.get.response",
        payload: {
          requestId: msg.requestId,
          plugins: this.pluginRuntime?.catalog(msg.cachedClientBundles) ?? [],
        },
      });
      return undefined;
    }
    return undefined;
  }

  private dispatchPluginRpcMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "subscription.release.request")
      return this.delivery.release(msg.subscriptionId).then(() => {
        this.emitForSource(
          {
            type: "subscription.release.response",
            payload: { requestId: msg.requestId, subscriptionId: msg.subscriptionId },
          },
          this.delivery.currentSource,
        );
        return undefined;
      });
    if (msg.type === "session.events.set_subscription.request") {
      const owner = this.delivery.begin(
        "events",
        undefined,
        (id) => {
          this.eventSubscriptions.delete(id);
        },
        msg.requestId,
      );
      this.eventSubscriptions.set(owner.id, { owner, events: new Set(msg.events) });
      this.emitForSource(
        {
          type: "session.events.set_subscription.response",
          payload: { requestId: msg.requestId, subscriptionId: owner.responseId },
        },
        owner.source,
      );
      return Promise.resolve();
    }
    if (msg.type === "plugin.rpc.invoke.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime
        .invokePluginRpc(msg.pluginId, msg.method, msg.input)
        .then((output) => this.replyPluginRpc(msg, output));
    }
    if (msg.type === "plugin.rpc.subscribe.request") return this.subscribePluginRpc(msg);
    return undefined;
  }

  /** A `Uint8Array` output is the binary form of `plugin.rpc.invoke.response`. */
  private async replyPluginRpc(
    request: Extract<SessionInboundMessage, { type: "plugin.rpc.invoke.request" }>,
    output: unknown,
  ): Promise<void> {
    const response: SessionOutboundMessage = {
      type: "plugin.rpc.invoke.response",
      payload: { requestId: request.requestId, output },
    };
    if (!(output instanceof Uint8Array)) {
      this.emitForSource(response, this.delivery.currentSource);
      return;
    }
    // The frame is the binary form of the response, so it needs the response's permission.
    if (!isSessionRpcAllowed(this.scopes, response.type)) return;
    if (!this.supports(CLIENT_CAPS.pluginBinaryPayloads) || this.onBinaryMessage === null)
      throw new Error(
        `Update JAgentDesk to receive the binary output of plugin RPC ${request.pluginId}.${request.method}`,
      );
    await this.emitBinaryReply(
      encodePluginOutputFrame(request.requestId, output),
      this.delivery.currentSource,
    );
  }

  private async subscribePluginRpc(
    request: Extract<SessionInboundMessage, { type: "plugin.rpc.subscribe.request" }>,
  ): Promise<void> {
    if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
    const subscription = this.pluginRuntime.subscribePluginRpc(
      request.pluginId,
      request.method,
      request.input,
    );
    const owner = this.delivery.begin("plugin-rpc", undefined, () => subscription.release());
    try {
      await subscription.ready;
    } catch (error) {
      await owner.release();
      throw error;
    }
    if (owner.signal.aborted) return;
    this.emitForSource(
      {
        type: "plugin.rpc.subscribe.response",
        payload: { requestId: request.requestId, subscriptionId: owner.responseId },
      },
      owner.source,
    );
    const close = (reason?: string) => {
      owner.emit({
        type: "plugin.rpc.closed",
        payload: {
          subscriptionId: owner.responseId,
          ...(reason === undefined ? {} : { error: reason }),
        },
      });
      void owner.release().catch(() => undefined);
    };
    subscription.attach({
      event: (event) => {
        const message: SessionOutboundMessage = {
          type: "plugin.rpc.event",
          payload: { subscriptionId: owner.responseId, event },
        };
        if (!(event instanceof Uint8Array)) {
          owner.emit(message);
          return;
        }
        if (!isSessionRpcAllowed(this.scopes, message.type)) return;
        if (this.onBinaryMessage === null) {
          subscription.release();
          close("This connection cannot carry binary plugin events");
          return;
        }
        owner.emitBinary(encodePluginEventFrame(owner.responseId, event));
      },
      closed: close,
    });
  }

  private dispatchPluginDirectoryMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "plugin.source.install.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime
        .installSource({
          // COMPAT(plugin-source-path): accepted for v0.7 clients; remove after 2027-09-01.
          source: formatPluginSourceReference(msg.source, msg.pluginPath),
          ...(msg.id ? { id: msg.id } : {}),
          ...(msg.ref ? { ref: msg.ref } : {}),
        })
        .then((plugin) => {
          this.emit({
            type: "plugin.source.install.response",
            payload: { requestId: msg.requestId, plugin },
          });
          return undefined;
        });
    }
    if (msg.type === "plugin.source.status.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.statusSources(msg.pluginId).then((plugins) => {
        this.emit({
          type: "plugin.source.status.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.source.update.preview.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime
        .previewUpdates({ pluginId: msg.pluginId, target: msg.target })
        .then((plugins) => {
          this.emit({
            type: "plugin.source.update.preview.response",
            payload: { requestId: msg.requestId, plugins },
          });
          return undefined;
        });
    }
    if (msg.type === "plugin.source.update.apply.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.applyUpdates(msg.proposals).then((plugins) => {
        this.emit({
          type: "plugin.source.update.apply.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.source.update.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.updateSources(msg.pluginId).then((plugins) => {
        this.emit({
          type: "plugin.source.update.response",
          payload: { requestId: msg.requestId, plugins },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.directory.install.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.installDirectory({ path: msg.path, id: msg.id }).then((plugin) => {
        this.emit({
          type: "plugin.directory.install.response",
          payload: { requestId: msg.requestId, plugin },
        });
        return undefined;
      });
    }
    if (msg.type === "plugin.directory.inspect.request") {
      if (!this.pluginRuntime) throw new Error("Plugin service is unavailable");
      return this.pluginRuntime.inspectDirectory(msg.path).then(({ id }) => {
        this.emit({
          type: "plugin.directory.inspect.response",
          payload: { requestId: msg.requestId, id },
        });
        return undefined;
      });
    }
    return undefined;
  }

  private stopDisabledBuiltinStreams(): void {
    const builtin = this.pluginRuntime?.builtin;
    if (!builtin) return;
    if (!builtin.isEnabled("docker")) {
      this.dockerStreams.disposeAll();
      disposeRemoteDocker({ service: this.dockerService, streams: this.dockerStreams });
      for (const routed of this.remoteDockerSubscriptions.values()) routed.release();
      this.remoteDockerSubscriptions.clear();
    }
    if (!builtin.isEnabled("devices")) {
      this.simulatorStreams.disposeAll();
      this.physicalDeviceSession?.dispose();
    }
    if (!builtin.isEnabled("clusters")) this.clusterSession.dispose();
    if (!builtin.isEnabled("argocd")) this.argocdSession.suspend();
    else this.argocdSession.syncDelegateRegistration();
    if (!builtin.isEnabled("jira")) this.jiraSession?.suspend();
    if (!builtin.isEnabled("activity-graph")) this.activityGraphSession?.dispose();
    if (!builtin.isEnabled("workbench")) {
      for (const id of this.proxySubscriptionIds) this.proxyService.unsubscribe(id);
      this.proxySubscriptionIds.clear();
    }
  }

  private subscribeToPluginChanges(
    pluginRuntime: SessionOptions["pluginRuntime"],
  ): (() => void) | null {
    if (!pluginRuntime) return null;
    const builtin = pluginRuntime.builtin?.subscribe(() => this.stopDisabledBuiltinStreams());
    const catalog = pluginRuntime.subscribe((pluginId) => {
      this.emit({ type: "status", payload: { status: "plugin_catalog_changed", pluginId } });
    });
    const settings = pluginRuntime.subscribeSettings?.((pluginId, settingsId) => {
      this.emit({
        type: "status",
        payload: { status: "plugin_settings_changed", pluginId, settingsId },
      });
    });
    return () => {
      catalog();
      builtin?.();
      settings?.();
    };
  }

  private dispatchVoiceAndControlMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "voice_audio_chunk":
        return this.voiceSession.handleAudioChunk(msg);
      case "abort_request":
        return this.voiceSession.handleAbort();
      case "audio_played":
        this.voiceSession.handleAudioPlayed(msg.id);
        return undefined;
      case "set_voice_mode":
        return this.voiceSession.handleSetVoiceMode(msg.enabled, msg.agentId, msg.requestId);
      case "dictation_stream_start":
        return this.voiceSession.handleDictationStreamStart(msg);
      case "dictation_stream_chunk":
        return this.voiceSession.handleDictationChunk({
          dictationId: msg.dictationId,
          seq: msg.seq,
          audioBase64: msg.audio,
          format: msg.format,
        });
      case "dictation_stream_finish":
        return this.voiceSession.handleDictationFinish(msg.dictationId, msg.finalSeq);
      case "dictation_stream_cancel":
        this.voiceSession.handleDictationCancel(msg.dictationId);
        return undefined;
      case "restart_server_request":
        return this.handleRestartServerRequest(msg.requestId, msg.reason, {
          keepTerminals: msg.killTerminals !== true,
        });
      case "shutdown_server_request":
        return this.handleShutdownServerRequest(msg.requestId, {
          keepTerminals: msg.keepTerminals === true,
        });
      case "client_heartbeat":
        this.handleClientHeartbeat(msg);
        return undefined;
      case "ping": {
        const now = Date.now();
        this.emit({
          type: "pong",
          payload: {
            requestId: msg.requestId,
            clientSentAt: msg.clientSentAt,
            serverReceivedAt: now,
            serverSentAt: now,
          },
        });
        return undefined;
      }
      default:
        return undefined;
    }
  }

  private dispatchAgentRewindMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.rewind.request":
        return this.handleAgentRewindRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchAgentRelationshipMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "agent.detach.request":
        return this.handleDetachAgentRequest(msg.agentId, msg.requestId);
      default:
        return undefined;
    }
  }

  private dispatchAgentTimelineMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_agent_timeline_request":
        return this.handleFetchAgentTimelineRequest(msg, source);
      case "agent.timeline.append.request":
        return this.handleAgentTimelineAppendRequest(msg);
      case "agent.timeline.list_prompts.request":
        return this.handleAgentTimelineListPromptsRequest(msg, source);
      case "agent.timeline.search.request":
        return this.handleAgentTimelineSearchRequest(msg, source);
      case "agent.provider_subagents.list.request":
        return this.handleProviderSubagentListRequest(msg);
      case "agent.background_work.list.request":
        return this.handleAgentBackgroundWorkListRequest(msg);
      case "agent.background_work.stop.request":
        return this.handleAgentBackgroundWorkStopRequest(msg);
      case "agent.provider_subagents.timeline.get.request":
        return this.handleProviderSubagentTimelineRequest(msg, source);
      case "agent.timeline.set_subscription.request":
        return this.handleAgentTimelineSubscription(msg, source);
      case "agent.fork_context.request":
        return this.handleAgentForkContextRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchHubExecutionMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "hub.execution.agent.create.request") {
      return this.hubExecutionController?.createAgent(msg);
    }
    if (msg.type === "hub.execution.control.request") {
      return this.hubExecutionController?.controlExecution(msg);
    }
    return undefined;
  }

  private dispatchAgentLifecycleMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_agents_request":
        return this.handleFetchAgents(msg);
      case "fetch_agent_history_request":
        return this.handleFetchAgentHistory(msg);
      case "fetch_recent_provider_sessions_request":
        return this.handleFetchRecentProviderSessions(msg);
      case "fetch_agent_request":
        return this.handleFetchAgent(msg.agentId, msg.requestId);
      case "delete_agent_request":
        return this.handleDeleteAgentRequest(msg.agentId, msg.requestId);
      case "archive_agent_request":
        return this.handleArchiveAgentRequest(msg.agentId, msg.requestId);
      case "close_items_request":
        return this.handleCloseItemsRequest(msg);
      case "update_agent_request":
        return this.handleUpdateAgentRequest(msg.agentId, msg.name, msg.labels, msg.requestId);
      case "project.rename.request":
        return this.handleProjectRenameRequest(msg.projectId, msg.customName, msg.requestId);
      case "project.icon.set.request":
        return this.handleProjectIconSetRequest(msg);
      case "send_agent_message_request":
        return this.handleSendAgentMessageRequest(msg);
      case "wait_for_finish_request":
        return this.handleWaitForFinish(msg.agentId, msg.requestId, msg.timeoutMs);
      case "create_agent_request":
        return this.handleCreateAgentRequest(msg);
      case "resume_agent_request":
        return this.handleResumeAgentRequest(msg);
      case "import_agent_request":
        return this.handleImportAgentRequest(msg);
      case "refresh_agent_request":
        return this.handleRefreshAgentRequest(msg);
      case "cancel_agent_request":
        return this.handleCancelAgentRequest(msg.agentId, msg.requestId);
      case "agent_permission_response":
        return this.handleAgentPermissionResponse(msg.agentId, msg.requestId, msg.response);
      case "clear_agent_attention":
        return this.handleClearAgentAttention(msg.agentId, msg.requestId);
      default:
        return undefined;
    }
  }

  /** The per-agent config mutations (mode/model/provider/feature/thinking). */
  private dispatchAgentConfigSessionMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "set_agent_mode_request":
        return this.agentConfigSession.handleSetAgentModeRequest(msg);
      case "set_agent_model_request":
        return this.agentConfigSession.handleSetAgentModelRequest(msg);
      case "switch_agent_provider_request":
        return this.agentConfigSession.handleSwitchAgentProviderRequest(msg);
      case "set_agent_feature_request":
        return this.agentConfigSession.handleSetAgentFeatureRequest(msg);
      case "set_agent_thinking_request":
        return this.agentConfigSession.handleSetAgentThinkingRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchAgentConfigMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "get_daemon_config_request":
        this.emit({
          type: "get_daemon_config_response",
          payload: { requestId: msg.requestId, config: this.daemonConfigStore.get() },
        });
        return undefined;
      case "daemon.get_status.request":
        return this.daemonSession.handleGetStatusRequest(msg);
      case "daemon.get_pairing_offer.request":
        return this.daemonSession.handleGetPairingOfferRequest(msg);
      case "pairing.device.register.request":
        return this.daemonSession.handlePairingRegisterRequest(msg);
      case "pairing.device.cancel.request":
        return this.daemonSession.handlePairingCancelRequest(msg);
      case "pairing.device.revoke.request":
        return this.daemonSession.handlePairingRevokeRequest(msg);
      case "pairing.device.list.request":
        return this.daemonSession.handlePairingListRequest(msg);
      case "hub.management.daemon.connect.request":
      case "hub.management.daemon.get_status.request":
      case "hub.management.daemon.disconnect.request":
      case "hub.management.daemon.permissions.update.request":
        return this.daemonSession.handleHubRelationshipRequest(msg);
      case "diagnostics.request":
        return this.daemonSession.handleDiagnosticsRequest(msg);
      case "daemon.update.request":
        return this.daemonSession.handleUpdateRequest(msg);
      case "set_daemon_config_request":
        this.emit({
          type: "set_daemon_config_response",
          payload: {
            requestId: msg.requestId,
            config: this.daemonConfigStore.patch(
              (() => {
                if (msg.config.builtinPlugins)
                  throw new Error("Use plugins.builtin.set.request to change built-in plugins");
                return msg.config;
              })(),
            ),
          },
        });
        return undefined;
      case "read_project_config_request":
        return this.projectConfigSession.handleReadProjectConfigRequest(msg);
      case "write_project_config_request":
        return this.projectConfigSession.handleWriteProjectConfigRequest(msg);
      default:
        return this.dispatchAgentConfigSessionMessage(msg);
    }
  }

  private dispatchSkillsMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (isNativeSkillsRequest(msg)) {
      return handleNativeSkillsRequest(this.skillsStorage, msg, (out) => this.emit(out));
    }
    switch (msg.type) {
      case "skills.get.request":
        this.emit({
          type: "skills.get.response",
          payload: { requestId: msg.requestId, skills: this.skillsStorage?.get() ?? [] },
        });
        return undefined;
      case "skills.mutate.request":
        return (async () => {
          const skills = this.skillsStorage ? await this.skillsStorage.mutate(msg.mutation) : [];
          this.emit({
            type: "skills.mutate.response",
            payload: { requestId: msg.requestId, skills },
          });
        })();
      default:
        return undefined;
    }
  }

  private logRequestError(err: Error): void {
    if (err instanceof BuiltinPluginError)
      this.sessionLogger.warn({ err }, "Built-in plugin request rejected");
    else this.sessionLogger.error({ err }, "Error handling message");
  }

  private dispatchUsageMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (msg.type === "usage.history.get.request") {
      this.emit({
        type: "usage.history.get.response",
        payload: {
          requestId: msg.requestId,
          days: this.usageHistory?.get() ?? [],
          lifetime: this.usageHistory?.lifetime() ?? EMPTY_LIFETIME_USAGE,
        },
      });
      return undefined;
    }
    if (msg.type === "usage.history.reset.request") {
      // Destructive: zero the persisted time-series + lifetime baseline. clear()
      // also notifies listeners so the daemon broadcasts status:usage_changed and
      // every other viewer's dashboard drops to zero too.
      this.usageHistory?.clear();
      this.emit({
        type: "usage.history.reset.response",
        payload: {
          requestId: msg.requestId,
          days: this.usageHistory?.get() ?? [],
          lifetime: this.usageHistory?.lifetime() ?? EMPTY_LIFETIME_USAGE,
        },
      });
      return undefined;
    }
    if (msg.type === "host.capabilities.refresh.request") {
      return this.handleHostCapabilitiesRefresh(msg.requestId);
    }
    if (msg.type === "host.tools.plan.request") {
      return this.handleHostToolsPlan(msg.requestId, msg.tool);
    }
    if (msg.type === "host.tools.install.request") {
      return this.handleHostToolsInstall(msg.requestId, msg.planId);
    }
    return undefined;
  }

  // Spec 24.2: probe the host again (e.g. after installing Docker); the change is also
  // broadcast to every client through server_info.
  private async handleHostCapabilitiesRefresh(requestId: string): Promise<void> {
    const capabilities = (await this.hostCapabilities?.refresh()) ?? {};
    this.emit({
      type: "host.capabilities.refresh.response",
      payload: { requestId, capabilities },
    });
  }

  // Spec 24.3: what installing a tool would do here (nothing is installed yet).
  private async handleHostToolsPlan(requestId: string, tool: string): Promise<void> {
    try {
      if (!this.hostToolInstaller) throw new ToolInstallError("unknown_tool", "No installer");
      const plan = await this.hostToolInstaller.plan(tool);
      this.emit({ type: "host.tools.plan.response", payload: { requestId, plan, error: null } });
    } catch (error) {
      this.emit({
        type: "host.tools.plan.response",
        payload: { requestId, plan: null, error: toolInstallErrorPayload(error) },
      });
    }
  }

  // Spec 24.3: carry out a plan the user reviewed, streaming output lines.
  private async handleHostToolsInstall(requestId: string, planId: string): Promise<void> {
    try {
      if (!this.hostToolInstaller) throw new ToolInstallError("plan_expired", "No installer");
      const result = await this.hostToolInstaller.install(planId, (line) => {
        this.emit({ type: "host.tools.install.progress", payload: { requestId, planId, line } });
      });
      this.emit({
        type: "host.tools.install.response",
        payload: { requestId, ok: true, version: result.version, path: result.path, error: null },
      });
    } catch (error) {
      this.emit({
        type: "host.tools.install.response",
        payload: {
          requestId,
          ok: false,
          version: null,
          path: null,
          error: toolInstallErrorPayload(error),
        },
      });
    }
  }

  private dispatchOrchestrationMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "orchestration.config.get.request":
        this.emit({
          type: "orchestration.config.get.response",
          payload: {
            requestId: msg.requestId,
            config: this.daemonConfigStore.get().orchestration,
          },
        });
        return undefined;
      case "orchestration.config.update.request":
        this.emit({
          type: "orchestration.config.update.response",
          payload: {
            requestId: msg.requestId,
            config: this.daemonConfigStore.patch({ orchestration: msg.config }).orchestration,
          },
        });
        return undefined;
      case "orchestration.task.prepare.request": {
        const brief = prepareTaskBrief({
          rawRequest: msg.rawRequest,
          config: this.daemonConfigStore.get().orchestration,
          routeCategory: msg.routeCategory,
        });
        this.emit({
          type: "orchestration.task.prepare.response",
          payload: { requestId: msg.requestId, brief },
        });
        return undefined;
      }
      default:
        return undefined;
    }
  }

  // eslint-disable-next-line complexity
  private dispatchCheckoutMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "checkout_status_request":
        return this.checkoutSession.handleStatusRequest(msg);
      case "checkout.worktrees.list.request":
        return this.checkoutSession.handleWorktreesListRequest(msg);
      case "checkout.commits.list.request":
        return this.checkoutSession.handleCommitsListRequest(msg);
      case "checkout.commits.file_diff.request":
        return this.checkoutSession.handleCommitFileDiffRequest(msg);
      case "validate_branch_request":
        return this.checkoutSession.handleValidateBranchRequest(msg);
      case "branch_suggestions_request":
        return this.checkoutSession.handleBranchSuggestionsRequest(msg);
      case "directory_suggestions_request":
        return this.handleDirectorySuggestionsRequest(msg);
      case "subscribe_checkout_diff_request":
        return this.checkoutSession.handleSubscribeDiffRequest(msg);
      case "unsubscribe_checkout_diff_request":
        this.checkoutSession.handleUnsubscribeDiffRequest(msg);
        return undefined;
      case "checkout_switch_branch_request":
        return this.checkoutSession.handleCheckoutSwitchBranchRequest(msg);
      case "checkout.rename_branch.request":
        return this.checkoutSession.handleCheckoutRenameBranchRequest(msg);
      case "checkout.discard_changes.request":
        return this.checkoutSession.handleCheckoutDiscardChangesRequest(msg);
      case "checkout_commit_request":
        return this.checkoutSession.handleCheckoutCommitRequest(msg);
      case "checkout_merge_request":
        return this.checkoutSession.handleCheckoutMergeRequest(msg);
      case "checkout_merge_from_base_request":
        return this.checkoutSession.handleCheckoutMergeFromBaseRequest(msg);
      case "checkout_pull_request":
        return this.checkoutSession.handleCheckoutPullRequest(msg);
      case "checkout_push_request":
        return this.checkoutSession.handleCheckoutPushRequest(msg);
      case "checkout.refresh.request":
        return this.checkoutSession.handleRefreshRequest(msg);
      case "checkout_pr_create_request":
        return this.checkoutSession.handleCheckoutPrCreateRequest(msg);
      case "checkout_pr_merge_request":
        return this.checkoutSession.handleCheckoutPrMergeRequest(msg);
      case "checkout.forge.set_auto_merge.request":
      case "checkout.github.set_auto_merge.request":
        return this.checkoutSession.handleCheckoutForgeSetAutoMergeRequest(msg);
      case "checkout.forge.get_check_details.request":
      case "checkout.github.get_check_details.request":
        return this.checkoutSession.handleCheckoutForgeGetCheckDetailsRequest(msg);
      case "checkout_pr_status_request":
        return this.checkoutSession.handleCheckoutPrStatusRequest(msg);
      case "pull_request_timeline_request":
        return this.checkoutSession.handlePullRequestTimelineRequest(msg);
      case "forge.search.request":
      case "github_search_request":
        return this.checkoutSession.handleForgeSearchRequest(msg);
      case "forge.connection.list.request":
      case "forge.connection.add.request":
      case "forge.connection.remove.request":
      case "forge.repo.list.request":
      case "forge.change_request.list.request":
      case "forge.change_request.files.request":
      case "forge.branch.list.request":
      case "forge.commit.list.request":
      case "forge.commit.compare.request":
      case "forge.tree.list.request":
      case "forge.file.get.request":
      case "forge.change_request.review.request":
      case "forge.change_request.merge.request":
      case "forge.pipeline.list.request":
      case "forge.pipeline.get.request":
      case "forge.job.log.request":
      case "forge.pipeline.rerun.request":
      case "forge.pipeline.cancel.request":
      case "forge.job.play.request":
      case "forge.change_request.set_auto_merge.request":
      case "forge.artifact.list.request":
      case "forge.artifact.download.request":
      case "forge.release.list.request":
      case "forge.tag.list.request":
      case "forge.issue.list.request":
      case "forge.issue.get.request":
      case "forge.issue.create.request":
      case "forge.issue.comment.request":
      case "forge.issue.close.request":
      case "forge.member.list.request":
      case "forge.member.add.request":
      case "forge.member.remove.request":
      case "forge.change_request.create.request":
      case "forge.change_request.close.request":
      case "forge.release.create.request":
      case "forge.release.get.request":
      case "forge.cli.status.request":
      case "forge.cli.install.request":
      case "forge.connection.login.request":
      case "forge.connection.login.cancel.request":
        return this.forgeHubSession.handle(msg);
      case "stash_save_request":
        return this.checkoutSession.handleStashSaveRequest(msg);
      case "stash_pop_request":
        return this.checkoutSession.handleStashPopRequest(msg);
      case "stash_list_request":
        return this.checkoutSession.handleStashListRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceAndProjectMessage(
    msg: SessionInboundMessage,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "fetch_workspaces_request":
        return this.handleFetchWorkspacesRequest(msg);
      case "project.list.request":
        return this.handleProjectListRequest(msg.requestId);
      case "project.suggestions.request":
        return this.handleProjectSuggestionsRequest(msg);
      case "jagentdesk_worktree_list_request":
        return this.handleJAgentDeskWorktreeListRequest(msg);
      case "jagentdesk_worktree_archive_request":
        return this.handleJAgentDeskWorktreeArchiveRequest(msg);
      case "create_jagentdesk_worktree_request":
        return this.handleCreateJAgentDeskWorktreeRequest(msg);
      case "workspace_setup_status_request":
        return this.handleWorkspaceSetupStatusRequest(msg);
      // COMPAT(desktopEditorBridge): added in v0.1.88, remove after 2026-12-03 once old clients no longer call daemon editor RPCs.
      case "list_available_editors_request":
        return this.handleLegacyListAvailableEditorsRequest(msg);
      case "open_in_editor_request":
        return this.handleLegacyOpenInEditorRequest(msg);
      case "open_project_request":
        return this.handleOpenProjectRequest(msg);
      case "project.add.request":
        return this.handleProjectAddRequest(msg);
      case "project.create_directory.request":
        return this.handleProjectCreateDirectoryRequest(msg);
      case "workspace.github.search_repositories.request":
        return this.handleWorkspaceGithubSearchRepositoriesRequest(msg);
      case "project.github.clone.request":
        return this.handleProjectGithubCloneRequest(msg);
      case "archive_workspace_request":
        return this.handleArchiveWorkspaceRequest(msg);
      case "project.remove.request":
        return this.handleProjectRemoveRequest(msg);
      case "workspace.create.request":
        return this.handleWorkspaceCreateRequest(msg);
      case "workspace.clear_attention.request":
        return this.handleWorkspaceClearAttentionRequest(msg);
      default:
        return this.dispatchWorkspaceMetadataMessage(msg);
    }
  }

  private dispatchWorkspaceMetadataMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "workspace.title.set.request":
        return this.handleWorkspaceTitleSetRequest(msg.workspaceId, msg.title, msg.requestId);
      case "workspace.pin.set.request":
        return this.handleWorkspacePinSetRequest(msg.workspaceId, msg.pinned, msg.requestId);
      case "workspace.archive.undo.request":
        return this.handleWorkspaceArchiveUndoRequest(msg);
      case "workspace.base_branch.set.request":
        return this.handleWorkspaceBaseBranchSetRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceFileMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "file_explorer_request":
        return this.workspaceFilesSession.handleFileExplorerRequest(msg, source);
      case "fs.file.subscribe.request":
        return this.workspaceFilesSession.handleFileSubscribeRequest(msg);
      case "fs.file.unsubscribe.request":
        this.workspaceFilesSession.handleFileUnsubscribeRequest(msg);
        return undefined;
      case "fs.file.write.request":
        return this.workspaceFilesSession.handleFileWriteRequest(msg);
      case "project_icon_request":
        return this.workspaceFilesSession.handleProjectIconRequest(msg);
      case "project.icon.get.request":
        return this.handleProjectIconGetRequest(msg.projectId, msg.requestId);
      case "file_download_token_request":
        return this.workspaceFilesSession.handleFileDownloadTokenRequest(msg);
      case "file.upload.request":
        this.workspaceFilesSession.handleFileUploadRequest(msg);
        return undefined;
      default:
        return undefined;
    }
  }

  private dispatchWorkspaceRecoveryMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "workspace.recovery.inspect.request":
        return this.handleWorkspaceRecoveryInspectRequest(msg);
      case "workspace.recovery.restore.request":
        return this.handleWorkspaceRecoveryRestoreRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchProviderMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "list_provider_models_request":
        return this.providerCatalogSession.handleListProviderModelsRequest(msg);
      case "list_provider_modes_request":
        return this.providerCatalogSession.handleListProviderModesRequest(msg);
      case "list_provider_features_request":
        return this.providerCatalogSession.handleListProviderFeaturesRequest(msg);
      case "list_available_providers_request":
        return this.providerCatalogSession.handleListAvailableProvidersRequest(msg);
      case "get_providers_snapshot_request":
        return this.providerCatalogSession.handleGetProvidersSnapshotRequest(msg);
      case "refresh_providers_snapshot_request":
        return this.providerCatalogSession.handleRefreshProvidersSnapshotRequest(msg);
      case "provider_diagnostic_request":
        return this.providerCatalogSession.handleProviderDiagnosticRequest(msg);
      case "provider.installation.inspect.request":
        return this.providerCatalogSession.handleInspectProviderInstallationRequest(msg);
      case "provider.installation.check_updates.request":
        return this.providerCatalogSession.handleCheckProviderUpdatesRequest(msg);
      case "provider.installation.update.request":
        return this.providerCatalogSession.handleUpdateProviderRequest(msg);
      case "usage.list_reports.request":
        return this.usageSession.handleListReports(msg);
      case "provider.usage.list.request":
        return this.providerCatalogSession.handleProviderUsageListRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchTerminalMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    switch (msg.type) {
      case "start_workspace_script_request":
        return this.handleStartWorkspaceScriptRequest(msg);
      case "workspace.script.list.request":
        return this.handleWorkspaceScriptListRequest(msg);
      case "workspace.script.start.request":
        return this.handleWorkspaceScriptStartRequest(msg);
      case "workspace.script.stop.request":
        return this.handleWorkspaceScriptStopRequest(msg);
      case "subscribe_terminal_request":
      case "unsubscribe_terminal_request":
      case "terminal_input":
        return this.terminalStreamControllerForSource(source).dispatch(msg);
      default:
        return this.terminalController.dispatch(msg);
    }
  }

  private terminalStreamControllerForSource(source?: object): TerminalSessionController {
    if (!source) return this.terminalController;
    let controller = this.terminalStreamControllers.get(source);
    if (!controller) {
      controller = new TerminalSessionController({
        terminalManager: this.terminalManager,
        emit: (message) => this.emitForSource(message, source),
        emitBinary: (frame) => {
          void this.emitBinaryReply(frame, source).catch((error) =>
            this.sessionLogger.warn({ err: error }, "Terminal viewer disconnected"),
          );
        },
        hasBinaryChannel: () => this.onBinaryMessage !== null,
        supportsChunkedReplay: () =>
          this.supportsForSource(CLIENT_CAPS.terminalChunkedReplay, source),
        isPathWithinRoot: (root, candidate) => this.isPathWithinRoot(root, candidate),
        sessionLogger: this.sessionLogger,
        getClientBufferedAmount: () => this.getTransportBufferedAmount(source),
      });
      this.terminalStreamControllers.set(source, controller);
    }
    return controller;
  }

  // eslint-disable-next-line complexity
  private dispatchChatScheduleLoopMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "chat/create":
        return this.chatScheduleLoopSession.handleChatCreateRequest(msg);
      case "chat/list":
        return this.chatScheduleLoopSession.handleChatListRequest(msg);
      case "chat/inspect":
        return this.chatScheduleLoopSession.handleChatInspectRequest(msg);
      case "chat/delete":
        return this.chatScheduleLoopSession.handleChatDeleteRequest(msg);
      case "chat/post":
        return this.chatScheduleLoopSession.handleChatPostRequest(msg);
      case "chat/read":
        return this.chatScheduleLoopSession.handleChatReadRequest(msg);
      case "chat/wait":
        return this.chatScheduleLoopSession.handleChatWaitRequest(msg);
      case "loop/run":
        return this.chatScheduleLoopSession.handleLoopRunRequest(msg);
      case "loop/list":
        return this.chatScheduleLoopSession.handleLoopListRequest(msg);
      case "loop/inspect":
        return this.chatScheduleLoopSession.handleLoopInspectRequest(msg);
      case "loop/logs":
        return this.chatScheduleLoopSession.handleLoopLogsRequest(msg);
      case "loop/stop":
        return this.chatScheduleLoopSession.handleLoopStopRequest(msg);
      case "schedule/create":
        return this.chatScheduleLoopSession.handleScheduleCreateRequest(msg);
      case "schedule/list":
        return this.chatScheduleLoopSession.handleScheduleListRequest(msg);
      case "schedule/inspect":
        return this.chatScheduleLoopSession.handleScheduleInspectRequest(msg);
      case "schedule/logs":
        return this.chatScheduleLoopSession.handleScheduleLogsRequest(msg);
      case "schedule/pause":
        return this.chatScheduleLoopSession.handleSchedulePauseRequest(msg);
      case "schedule/resume":
        return this.chatScheduleLoopSession.handleScheduleResumeRequest(msg);
      case "schedule/delete":
        return this.chatScheduleLoopSession.handleScheduleDeleteRequest(msg);
      case "schedule/run-once":
        return this.chatScheduleLoopSession.handleScheduleRunOnceRequest(msg);
      case "schedule/update":
        return this.chatScheduleLoopSession.handleScheduleUpdateRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchAutorunMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    const autorun = this.autorunSession;
    if (!autorun) return undefined;
    switch (msg.type) {
      case "autorun.start.request":
        return autorun.handleStartRequest(msg);
      case "autorun.stop.request":
        return autorun.handleStopRequest(msg);
      case "autorun.get.request":
        return autorun.handleGetRequest(msg);
      case "autorun.list.request":
        return autorun.handleListRequest(msg);
      default:
        return undefined;
    }
  }

  private dispatchSpecModeMessage(
    msg: SessionInboundMessage,
    source?: object,
  ): Promise<void> | undefined {
    const specMode = this.specMode?.session;
    if (!specMode) return undefined;
    switch (msg.type) {
      case "agent.spec_mode.get.request":
      case "agent.spec_mode.setup.preview.request":
      case "agent.spec_mode.set.request":
      case "agent.spec_mode.review.request": {
        const supported = source
          ? this.supportsForSource(CLIENT_CAPS.specMode, source)
          : this.supports(CLIENT_CAPS.specMode);
        return specMode.handle(msg, supported);
      }
      default:
        return undefined;
    }
  }

  private dispatchSessionShareMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    const share = this.sessionShareSession;
    if (!share) return undefined;
    switch (msg.type) {
      case "session.share.create.request":
        return share.handleCreateRequest(msg);
      case "session.share.stop.request":
        return share.handleStopRequest(msg);
      case "session.share.kick.request":
        return share.handleKickRequest(msg);
      case "session.share.respond.request":
        return share.handleRespondRequest(msg);
      case "session.share.set_options.request":
        return share.handleSetOptionsRequest(msg);
      case "session.share.list.request":
        return share.handleListRequest(msg);
      default:
        return undefined;
    }
  }

  // oxlint-disable-next-line complexity
  private dispatchClusterMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "cluster/contexts":
        return this.clusterSession.handleContextsRequest(msg);
      case "cluster/import":
        return this.clusterSession.handleImportRequest(msg);
      case "cluster/list":
        return this.clusterSession.handleListRequest(msg);
      case "cluster/connect":
        return this.activateRemoteCluster(msg.id).then(() =>
          this.clusterSession.handleConnectRequest(msg),
        );
      case "cluster/disconnect":
        return this.clusterSession.handleDisconnectRequest(msg);
      case "cluster/resources":
        return this.clusterSession.handleResourcesRequest(msg);
      case "cluster/get":
        return this.clusterSession.handleGetRequest(msg);
      case "cluster/logs":
        return this.clusterSession.handleLogsRequest(msg);
      case "cluster/logs/subscribe":
        return this.clusterSession.handleLogsSubscribeRequest(msg);
      case "cluster/logs/unsubscribe":
        return this.clusterSession.handleLogsUnsubscribeRequest(msg);
      case "cluster/write":
        return this.clusterSession.handleWriteRequest(msg);
      case "cluster/kinds":
        return this.clusterSession.handleClusterKinds(msg);
      case "cluster/resource/list":
        return this.clusterSession.handleClusterResourceList(msg);
      case "cluster/reveal-secret":
        return this.clusterSession.handleRevealSecretRequest(msg);
      case "cluster/node-op":
        return this.clusterSession.handleNodeOpRequest(msg);
      case "cluster/cronjob-op":
        return this.clusterSession.handleCronjobOpRequest(msg);
      case "cluster/metrics":
        return this.clusterSession.handleClusterMetrics(msg);
      case "cluster/helm/list":
        return this.clusterSession.handleHelmListRequest(msg);
      case "cluster/helm/history":
        return this.clusterSession.handleHelmHistoryRequest(msg);
      case "cluster/helm/values":
        return this.clusterSession.handleHelmValuesRequest(msg);
      case "cluster/helm/rollback":
        return this.clusterSession.handleHelmRollbackRequest(msg);
      case "cluster/helm/uninstall":
        return this.clusterSession.handleHelmUninstallRequest(msg);
      case "cluster/exec/start":
        return this.clusterSession.handleExecStart(
          msg as unknown as Parameters<typeof this.clusterSession.handleExecStart>[0],
        );
      case "cluster/exec/stdin":
        return this.clusterSession.handleExecStdin(
          msg as unknown as Parameters<typeof this.clusterSession.handleExecStdin>[0],
        );
      case "cluster/exec/close":
        return this.clusterSession.handleExecClose(
          msg as unknown as Parameters<typeof this.clusterSession.handleExecClose>[0],
        );
      case "cluster/pf/start" as string:
        return this.clusterSession.handlePfStart(
          msg as unknown as Parameters<typeof this.clusterSession.handlePfStart>[0],
        );
      case "cluster/pf/stdin" as string:
        return this.clusterSession.handlePfStdin(
          msg as unknown as Parameters<typeof this.clusterSession.handlePfStdin>[0],
        );
      case "cluster/pf/close" as string:
        return this.clusterSession.handlePfClose(
          msg as unknown as Parameters<typeof this.clusterSession.handlePfClose>[0],
        );
      default:
        return undefined;
    }
  }

  // docker/* with `serverId` drive the same cockpit against that SSH server's forwarded socket
  // (spec 25.10, ssh/remote-docker/route.ts). One-shot requests give the socket back when done;
  // a subscription holds it until its unsubscribe, which is routed by subscription id.
  private dispatchDockerMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!msg.type.startsWith("docker/")) return undefined;
    const local = { service: this.dockerService, streams: this.dockerStreams };
    const subscriptionId = "subscriptionId" in msg ? msg.subscriptionId : undefined;
    if (subscriptionId && msg.type.endsWith("/unsubscribe")) {
      const held = this.remoteDockerSubscriptions.get(subscriptionId);
      if (held) {
        this.remoteDockerSubscriptions.delete(subscriptionId);
        const done = this.dispatchDockerMessageWith(msg, held.service, held.streams);
        held.release();
        return done;
      }
    }
    const serverId = "serverId" in msg ? msg.serverId : undefined;
    const hosts = this.sshService.modules?.docker;
    if (!serverId || !hosts)
      return this.dispatchDockerMessageWith(msg, local.service, local.streams);
    return this.dispatchRemoteDockerMessage(msg, serverId, local, hosts, subscriptionId);
  }

  private async dispatchRemoteDockerMessage(
    msg: SessionInboundMessage,
    serverId: string,
    local: { service: DockerService; streams: DockerStreams },
    hosts: RemoteDockerHosts,
    subscriptionId: string | undefined,
  ): Promise<void> {
    let routed: RoutedDocker;
    try {
      routed = await routeDockerMessage({ serverId }, local, hosts);
    } catch (error) {
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: "requestId" in msg && msg.requestId ? msg.requestId : "",
          requestType: msg.type,
          error: error instanceof Error ? error.message : String(error),
          code: error instanceof RemoteDockerError ? error.code : "ssh_docker_unavailable",
        },
      });
      return;
    }
    if (subscriptionId && msg.type.endsWith("/subscribe")) {
      this.remoteDockerSubscriptions.set(subscriptionId, routed);
      await this.dispatchDockerMessageWith(msg, routed.service, routed.streams);
      return;
    }
    try {
      await this.dispatchDockerMessageWith(msg, routed.service, routed.streams);
    } finally {
      routed.release();
    }
  }

  // A cluster imported through an SSH server needs its forward + kubeconfig before KubeClient
  // connects (ssh/remote-k8s); failures surface through the normal connect response.
  private async activateRemoteCluster(clusterId: string): Promise<void> {
    const k8s = this.sshService.modules?.remoteK8s;
    const cluster = this.clusterRegistry.list().find((candidate) => candidate.id === clusterId);
    if (!k8s || !cluster || !k8s.isRemoteContext(cluster.contextName)) return;
    await k8s.activate(cluster.contextName).catch((error: unknown) => {
      this.sessionLogger.warn({ err: error, clusterId }, "remote cluster activation failed");
    });
  }

  // A database reached through an SSH server listens on its fixed 127.0.0.1 port again before
  // the registry connects (ssh/remote-db).
  private async reopenRemoteDatabase(databaseId: string): Promise<void> {
    const tunnels = this.sshService.modules?.remoteDb;
    const info = this.databaseRegistry.list().find((candidate) => candidate.id === databaseId);
    const port = info ? localPortOfTarget(info.target) : null;
    if (!tunnels || port === null || !tunnels.isRemotePort(port)) return;
    await tunnels.reopenForLocalPort(port).catch((error: unknown) => {
      this.sessionLogger.warn({ err: error, databaseId }, "remote database tunnel failed");
    });
  }

  private dispatchDockerMessageWith(
    msg: SessionInboundMessage,
    dockerService: DockerService,
    dockerStreams: DockerStreams,
  ): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    if (msg.type === "docker/list") {
      const { requestId } = msg;
      return dockerService
        .list()
        .then((result) => {
          this.emit({
            type: "docker/list/response",
            payload: { requestId, error: null, ...result },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/list/response",
            payload: {
              requestId,
              error: fail(error),
              available: false,
              containers: [],
              images: [],
            },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/logs") {
      const { requestId } = msg;
      return dockerService
        .logs(msg.container, msg.tail)
        .then((logs) => {
          this.emit({ type: "docker/logs/response", payload: { requestId, error: null, logs } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/logs/response",
            payload: { requestId, error: fail(error), logs: "" },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/inspect") {
      const { requestId } = msg;
      return dockerService
        .inspect(msg.container)
        .then((inspect) => {
          this.emit({
            type: "docker/inspect/response",
            payload: { requestId, error: null, inspect },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/inspect/response",
            payload: { requestId, error: fail(error), inspect: "" },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/action") {
      const { requestId } = msg;
      return dockerService
        .action(msg.container, msg.action)
        .then(() => {
          this.emit({ type: "docker/action/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/action/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/exec") {
      const { requestId } = msg;
      return dockerService
        .exec(msg.container, msg.command)
        .then((output) => {
          this.emit({ type: "docker/exec/response", payload: { requestId, error: null, output } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/exec/response",
            payload: { requestId, error: fail(error), output: "" },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/image/action") {
      const { requestId } = msg;
      return dockerService
        .imageAction(msg.image, msg.action)
        .then(() => {
          this.emit({ type: "docker/image/action/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/image/action/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/volume/action") {
      const { requestId } = msg;
      return dockerService
        .volumeAction(msg.name, msg.action)
        .then(() => {
          this.emit({ type: "docker/volume/action/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/volume/action/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/fs/list") {
      const { requestId } = msg;
      return dockerService
        .fsList(msg.container, msg.path)
        .then((entries) => {
          this.emit({
            type: "docker/fs/list/response",
            payload: { requestId, error: null, path: msg.path, entries },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/fs/list/response",
            payload: { requestId, error: fail(error), path: msg.path, entries: [] },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/cp") {
      const { requestId } = msg;
      return dockerService
        .cp(msg.container, msg.direction, msg.containerPath, msg.hostPath)
        .then(() => {
          this.emit({ type: "docker/cp/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/cp/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/fs/read") {
      const { requestId } = msg;
      return dockerService
        .fsRead(msg.container, msg.path)
        .then(({ content, truncated }) => {
          this.emit({
            type: "docker/fs/read/response",
            payload: { requestId, error: null, content, truncated },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/fs/read/response",
            payload: { requestId, error: fail(error), content: "", truncated: false },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/fs/write") {
      const { requestId } = msg;
      return dockerService
        .fsWrite(msg.container, msg.path, msg.content)
        .then(() => {
          this.emit({ type: "docker/fs/write/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/fs/write/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/fs/op") {
      const { requestId } = msg;
      return dockerService
        .fsOp(msg.container, msg.op, msg.path, msg.newPath)
        .then(() => {
          this.emit({ type: "docker/fs/op/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "docker/fs/op/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "docker/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.emit({
        type: "docker/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      void dockerStreams.subscribeSnapshot(subscriptionId, (snapshot) => {
        this.emit({ type: "docker/snapshot", payload: { subscriptionId, ...snapshot } });
      });
      return undefined;
    }
    if (msg.type === "docker/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      dockerStreams.unsubscribeSnapshot(subscriptionId);
      this.emit({
        type: "docker/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    if (msg.type === "docker/logs/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.emit({
        type: "docker/logs/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      dockerStreams.subscribeLogs(subscriptionId, msg.container, msg.tail ?? 500, (chunk) => {
        this.emit({ type: "docker/log-chunk", payload: { subscriptionId, chunk } });
      });
      return undefined;
    }
    if (msg.type === "docker/logs/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      dockerStreams.unsubscribeLogs(subscriptionId);
      this.emit({
        type: "docker/logs/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    if (msg.type === "docker/stats/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.emit({
        type: "docker/stats/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      dockerStreams.subscribeStats(subscriptionId, msg.container, (stats) => {
        this.emit({ type: "docker/stats-data", payload: { subscriptionId, stats } });
      });
      return undefined;
    }
    if (msg.type === "docker/stats/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      dockerStreams.unsubscribeStats(subscriptionId);
      this.emit({
        type: "docker/stats/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    return undefined;
  }

  // The fleet itself: listing it, what the host can run, and adding devices to it.
  private dispatchSimulatorFleet(
    msg: SessionInboundMessage,
    fail: (error: unknown) => string,
  ): Promise<void> | undefined {
    if (msg.type === "simulator/list") {
      const { requestId } = msg;
      return fleetSnapshot(this.simulatorService, this.physicalDevices)
        .then((result) => {
          this.emit({
            type: "simulator/list/response",
            payload: { requestId, error: null, ...result },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/list/response",
            payload: {
              requestId,
              error: fail(error),
              availability: { simctl: false, idb: false, maestro: false, xcode: false },
              devices: [],
            },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/catalog") {
      const { requestId } = msg;
      return this.simulatorService
        .catalog()
        .then((runtimes) => {
          this.emit({
            type: "simulator/catalog/response",
            payload: { requestId, error: null, runtimes },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/catalog/response",
            payload: { requestId, error: fail(error), runtimes: [] },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/create") {
      const { requestId } = msg;
      return this.simulatorService
        .create(msg.name, msg.deviceTypeId, msg.runtimeId, msg.boot ?? false)
        .then((udid) => {
          this.emit({
            type: "simulator/create/response",
            payload: { requestId, error: null, udid },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/create/response",
            payload: { requestId, error: fail(error), udid: "" },
          });
          return undefined;
        });
    }
    return undefined;
  }

  private dispatchProxyMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    if (msg.type === "proxy/capture/start") {
      const { requestId } = msg;
      return this.proxyService
        .captureStart({ mode: msg.mode, label: msg.label, udid: msg.udid, bundleId: msg.bundleId })
        .then((session) => {
          this.emit({
            type: "proxy/capture/start/response",
            payload: { requestId, error: null, session },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "proxy/capture/start/response",
            payload: { requestId, error: fail(error), session: null },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/capture/stop") {
      const { requestId, sessionId } = msg;
      return this.proxyService
        .captureStop(sessionId)
        .then(() => {
          this.emit({
            type: "proxy/capture/stop/response",
            payload: { requestId, error: null, sessionId },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "proxy/capture/stop/response",
            payload: { requestId, error: fail(error), sessionId },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/session/remove") {
      const { requestId, sessionId } = msg;
      return this.proxyService
        .removeSession(sessionId)
        .then(() => {
          this.emit({
            type: "proxy/session/remove/response",
            payload: { requestId, error: null, sessionId },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "proxy/session/remove/response",
            payload: { requestId, error: fail(error), sessionId },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/sessions/list") {
      const { requestId } = msg;
      this.emit({
        type: "proxy/sessions/list/response",
        payload: { requestId, error: null, sessions: this.proxyService.sessionsList() },
      });
      return undefined;
    }
    if (msg.type === "proxy/history/query") {
      const { requestId } = msg;
      const rows = this.proxyService.historyQuery({
        sessionId: msg.sessionId,
        host: msg.host,
        method: msg.method,
        status: msg.status,
        contains: msg.contains,
        limit: msg.limit,
      });
      this.emit({
        type: "proxy/history/query/response",
        payload: { requestId, error: null, rows },
      });
      return undefined;
    }
    if (msg.type === "proxy/transaction/get") {
      const { requestId } = msg;
      this.emit({
        type: "proxy/transaction/get/response",
        payload: { requestId, error: null, transaction: this.proxyService.transactionGet(msg.id) },
      });
      return undefined;
    }
    if (msg.type === "proxy/history/clear") {
      const { requestId } = msg;
      this.proxyService.clearHistory(msg.sessionId);
      this.emit({ type: "proxy/history/clear/response", payload: { requestId, error: null } });
      return undefined;
    }
    if (msg.type === "proxy/transaction/delete") {
      const { requestId, id } = msg;
      this.proxyService.deleteTransaction(id);
      this.emit({
        type: "proxy/transaction/delete/response",
        payload: { requestId, error: null, id },
      });
      return undefined;
    }
    if (msg.type === "proxy/transaction/annotate") {
      const { requestId } = msg;
      const row = this.proxyService.annotate(msg.id, {
        comment: msg.comment,
        highlight: msg.highlight,
      });
      this.emit({
        type: "proxy/transaction/annotate/response",
        payload: { requestId, error: null, row },
      });
      return undefined;
    }
    if (msg.type === "proxy/ca/export") {
      const { requestId } = msg;
      try {
        this.emit({
          type: "proxy/ca/export/response",
          payload: { requestId, error: null, pem: this.proxyService.caExportPem() },
        });
      } catch (error) {
        this.emit({
          type: "proxy/ca/export/response",
          payload: { requestId, error: fail(error), pem: "" },
        });
      }
      return undefined;
    }
    return this.dispatchProxyMessageContinued(msg);
  }

  private dispatchProxyMessageContinued(msg: SessionInboundMessage): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    if (msg.type === "proxy/repeater/send") {
      const { requestId } = msg;
      return this.proxyService
        .repeaterSend({
          secure: msg.secure,
          host: msg.host,
          port: msg.port,
          method: msg.method,
          path: msg.path,
          headers: msg.headers,
          body: Buffer.from(msg.bodyB64, "base64"),
        })
        .then((transaction) => {
          this.emit({
            type: "proxy/repeater/send/response",
            payload: { requestId, error: null, transaction },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "proxy/repeater/send/response",
            payload: { requestId, error: fail(error), transaction: null },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/intercept/set") {
      const { requestId } = msg;
      const enabled = this.proxyService.setIntercept(msg.enabled);
      this.emit({
        type: "proxy/intercept/set/response",
        payload: { requestId, error: null, enabled },
      });
      return undefined;
    }
    if (msg.type === "proxy/intercept/decide") {
      const { requestId, heldId } = msg;
      this.proxyService.decideIntercept({
        heldId,
        action: msg.action,
        method: msg.method,
        path: msg.path,
        headers: msg.headers,
        bodyB64: msg.bodyB64,
      });
      this.emit({
        type: "proxy/intercept/decide/response",
        payload: { requestId, error: null, heldId },
      });
      return undefined;
    }
    if (msg.type === "proxy/intruder/run") {
      const { requestId } = msg;
      return this.proxyService
        .intruderRun({
          secure: msg.secure,
          host: msg.host,
          port: msg.port,
          template: msg.template,
          payloads: msg.payloads,
        })
        .then((out) => {
          this.emit({
            type: "proxy/intruder/run/response",
            payload: { requestId, error: null, ...out },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "proxy/intruder/run/response",
            payload: {
              requestId,
              error: fail(error),
              results: [],
              throttled: false,
              truncated: false,
            },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/frida/status") {
      const { requestId } = msg;
      return fridaAvailability()
        .then((a) => {
          this.emit({
            type: "proxy/frida/status/response",
            payload: {
              requestId,
              error: null,
              frida: a.frida,
              version: a.version,
              installer: a.installer,
            },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "proxy/frida/status/response",
            payload: {
              requestId,
              error: fail(error),
              frida: false,
              version: null,
              installer: null,
            },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/frida/install") {
      const { requestId } = msg;
      return installFrida()
        .then((r) => {
          this.emit({
            type: "proxy/frida/install/response",
            payload: { requestId, error: null, ok: r.ok, log: r.log, frida: r.availability.frida },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "proxy/frida/install/response",
            payload: { requestId, error: fail(error), ok: false, log: "", frida: false },
          });
          return undefined;
        });
    }
    if (msg.type === "proxy/scope/get") {
      const { requestId } = msg;
      this.emit({
        type: "proxy/scope/get/response",
        payload: { requestId, error: null, rules: this.proxyService.getScope() },
      });
      return undefined;
    }
    if (msg.type === "proxy/scope/set") {
      const { requestId } = msg;
      this.emit({
        type: "proxy/scope/set/response",
        payload: { requestId, error: null, rules: this.proxyService.setScope(msg.rules) },
      });
      return undefined;
    }
    if (msg.type === "proxy/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.proxySubscriptionIds.add(subscriptionId);
      this.proxyService.subscribe(subscriptionId, {
        onTransaction: (row) =>
          this.emit({ type: "proxy/transaction", payload: { subscriptionId, row } }),
        onSession: (session) =>
          this.emit({ type: "proxy/session", payload: { subscriptionId, session } }),
        onHeld: (held) =>
          this.emit({ type: "proxy/intercept/held", payload: { subscriptionId, held } }),
        onWsMessage: (message) =>
          this.emit({ type: "proxy/ws-message", payload: { subscriptionId, message } }),
      });
      this.emit({
        type: "proxy/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    if (msg.type === "proxy/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      this.proxySubscriptionIds.delete(subscriptionId);
      this.proxyService.unsubscribe(subscriptionId);
      this.emit({
        type: "proxy/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    return undefined;
  }

  private createPhysicalDeviceSession(): PhysicalDeviceSession | null {
    if (!this.physicalDevices) return null;
    return new PhysicalDeviceSession(
      this.physicalDevices,
      {
        emit: (msg) => this.emit(msg),
        emitBinary: (frame) => this.emitBinary(frame),
        supportsBinaryScreenFrames: () => this.supports(CLIENT_CAPS.binaryScreenFrames),
        transportBufferedAmount: () => this.getTransportBufferedAmount(),
      },
      this.sessionLogger,
    );
  }

  private dispatchSimulatorMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    const physical = this.physicalDeviceSession?.handle(msg);
    if (physical) return physical;
    const fleet = this.dispatchSimulatorFleet(msg, fail);
    if (fleet) return fleet;
    if (msg.type === "simulator/action") {
      const { requestId, udid } = msg;
      return this.simulatorService
        .action(udid, msg.action)
        .then(() => {
          this.emit({
            type: "simulator/action/response",
            payload: { requestId, error: null, udid },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/action/response",
            payload: { requestId, error: fail(error), udid },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/tap") {
      const { requestId } = msg;
      return this.simulatorService
        .tap(msg.udid, msg.x, msg.y)
        .then(() => {
          this.emit({ type: "simulator/tap/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({ type: "simulator/tap/response", payload: { requestId, error: fail(error) } });
          return undefined;
        });
    }
    if (msg.type === "simulator/swipe") {
      const { requestId } = msg;
      return this.simulatorService
        .swipe(msg.udid, msg.x1, msg.y1, msg.x2, msg.y2, msg.durationMs)
        .then(() => {
          this.emit({ type: "simulator/swipe/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/swipe/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/input-text") {
      const { requestId } = msg;
      return this.simulatorService
        .inputText(msg.udid, msg.text)
        .then(() => {
          this.emit({ type: "simulator/input-text/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/input-text/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/button") {
      const { requestId } = msg;
      return this.simulatorService
        .button(msg.udid, msg.button)
        .then(() => {
          this.emit({ type: "simulator/button/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/button/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/describe-ui") {
      const { requestId } = msg;
      return this.simulatorService
        .describeUi(msg.udid)
        .then((elements) => {
          this.emit({
            type: "simulator/describe-ui/response",
            payload: { requestId, error: null, elements },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/describe-ui/response",
            payload: { requestId, error: fail(error), elements: [] },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/screenshot") {
      const { requestId } = msg;
      return this.simulatorService
        .screenshot(msg.udid, { format: msg.format, maxDim: msg.maxDim })
        .then((shot) => {
          this.emit({
            type: "simulator/screenshot/response",
            payload: {
              requestId,
              error: null,
              pngBase64: shot.mimeType === "image/png" ? shot.base64 : "",
              imageBase64: shot.base64,
              mimeType: shot.mimeType,
              width: shot.width,
              height: shot.height,
            },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/screenshot/response",
            payload: { requestId, error: fail(error), pngBase64: "" },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/install-app") {
      const { requestId } = msg;
      return this.simulatorService
        .installApp(msg.udid, msg.appPath)
        .then(() => {
          this.emit({
            type: "simulator/install-app/response",
            payload: { requestId, error: null },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/install-app/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/install-batch") {
      const { requestId } = msg;
      return this.simulatorService
        .installOnMany(msg.udids, msg.filePath)
        .then((results) => {
          this.emit({
            type: "simulator/install-batch/response",
            payload: { requestId, error: null, results },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/install-batch/response",
            payload: { requestId, error: fail(error), results: [] },
          });
          return undefined;
        });
    }
    return this.dispatchSimulatorMessageContinued(msg);
  }

  private dispatchSimulatorMessageContinued(msg: SessionInboundMessage): Promise<void> | undefined {
    const fail = (error: unknown): string =>
      error instanceof Error ? error.message : String(error);
    if (msg.type === "simulator/launch-app") {
      const { requestId } = msg;
      return this.simulatorService
        .launchApp(msg.udid, msg.bundleId, msg.terminateExisting)
        .then(() => {
          this.emit({ type: "simulator/launch-app/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/launch-app/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/terminate-app") {
      const { requestId } = msg;
      return this.simulatorService
        .terminateApp(msg.udid, msg.bundleId)
        .then(() => {
          this.emit({
            type: "simulator/terminate-app/response",
            payload: { requestId, error: null },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/terminate-app/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/open-url") {
      const { requestId } = msg;
      return this.simulatorService
        .openUrl(msg.udid, msg.url)
        .then(() => {
          this.emit({ type: "simulator/open-url/response", payload: { requestId, error: null } });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/open-url/response",
            payload: { requestId, error: fail(error) },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/slim") {
      const { requestId, udid } = msg;
      return this.simulatorService
        .slim(udid, msg.reboot ?? false)
        .then((slimState) => {
          this.emit({
            type: "simulator/slim/response",
            payload: { requestId, error: null, udid, slimState },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/slim/response",
            payload: { requestId, error: fail(error), udid, slimState: "unknown" },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/unslim") {
      const { requestId, udid } = msg;
      return this.simulatorService
        .unslim(udid)
        .then((slimState) => {
          this.emit({
            type: "simulator/unslim/response",
            payload: { requestId, error: null, udid, slimState },
          });
          return undefined;
        })
        .catch((error) => {
          this.emit({
            type: "simulator/unslim/response",
            payload: { requestId, error: fail(error), udid, slimState: "unknown" },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/subscribe") {
      const { requestId, subscriptionId } = msg;
      this.emit({
        type: "simulator/subscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      void this.simulatorStreams.subscribeFleet(subscriptionId, (snapshot) => {
        this.emit({ type: "simulator/snapshot", payload: { subscriptionId, ...snapshot } });
      });
      return undefined;
    }
    if (msg.type === "simulator/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      this.simulatorStreams.unsubscribeFleet(subscriptionId);
      this.emit({
        type: "simulator/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    if (msg.type === "simulator/logs/subscribe") {
      const { requestId, subscriptionId } = msg;
      return this.simulatorStreams
        .subscribeLogs(subscriptionId, msg.udid, (chunk) => {
          this.emit({ type: "simulator/log-chunk", payload: { subscriptionId, chunk } });
        })
        .then(() => {
          this.emit({
            type: "simulator/logs/subscribe/response",
            payload: { requestId, error: null, subscriptionId },
          });
          return undefined;
        })
        .catch((error: unknown) => {
          this.emit({
            type: "simulator/logs/subscribe/response",
            payload: { requestId, error: deviceErrorText(error), subscriptionId },
          });
          return undefined;
        });
    }
    if (msg.type === "simulator/logs/unsubscribe") {
      const { requestId, subscriptionId } = msg;
      this.simulatorStreams.unsubscribeLogs(subscriptionId);
      this.emit({
        type: "simulator/logs/unsubscribe/response",
        payload: { requestId, error: null, subscriptionId },
      });
      return undefined;
    }
    return undefined;
  }

  // Argo CD allowlist (spec 30.5): every argocd.* request is listed here AND handled in
  // ArgoCdSession.handle(); a type missing from either is never answered.
  // oxlint-disable-next-line complexity
  private dispatchArgoCdMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "argocd.instances.list.request":
      case "argocd.instances.save.request":
      case "argocd.instances.delete.request":
      case "argocd.instances.login.request":
      case "argocd.instances.logout.request":
      case "argocd.sso.begin.request":
      case "argocd.sso.complete.request":
      case "argocd.sso.delegate.request":
      case "argocd.apps.list.request":
      case "argocd.apps.subscribe.request":
      case "argocd.apps.unsubscribe.request":
      case "argocd.app.get.request":
      case "argocd.app.tree.subscribe.request":
      case "argocd.app.tree.unsubscribe.request":
      case "argocd.app.diff.request":
      case "argocd.app.manifests.request":
      case "argocd.app.events.request":
      case "argocd.app.logs.subscribe.request":
      case "argocd.app.logs.unsubscribe.request":
      case "argocd.app.sync.request":
      case "argocd.app.refresh.request":
      case "argocd.app.rollback.request":
      case "argocd.app.terminate.request":
      case "argocd.app.delete.request":
      case "argocd.app.set_auto_sync.request":
      case "argocd.app.confirm_pruning.request":
      case "argocd.app.resource_actions.list.request":
      case "argocd.app.resource_action.request":
      case "argocd.can_i.request":
      case "argocd.appsets.list.request":
      case "argocd.projects.list.request":
      case "argocd.repos.list.request":
      case "argocd.clusters.list.request":
      case "argocd.cluster_links.list.request":
      case "argocd.cluster_links.set.request":
      case "argocd.cluster_links.resolve.request":
        return this.argocdSession.handle(msg);
      default:
        return undefined;
    }
  }

  // Jira (spec 29.5). Every jira.* request is listed here AND handled in JiraSession.handle: a
  // request missing from this list never reaches the handler and times out without a response.
  // oxlint-disable-next-line complexity
  private dispatchJiraMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!this.jiraSession) return undefined;
    switch (msg.type) {
      case "jira.connections.list.request":
      case "jira.connections.add.request":
      case "jira.connections.remove.request":
      case "jira.connections.test.request":
      case "jira.oauth.begin.request":
      case "jira.oauth.complete.request":
      case "jira.oauth.delegate.request":
      case "jira.projects.list.request":
      case "jira.boards.list.request":
      case "jira.boards.get.request":
      case "jira.boards.configuration.request":
      case "jira.board.issues.request":
      case "jira.board.watch.request":
      case "jira.board.unwatch.request":
      case "jira.backlog.get.request":
      case "jira.sprints.list.request":
      case "jira.sprints.create.request":
      case "jira.sprints.start.request":
      case "jira.sprints.complete.request":
      case "jira.sprints.move_issues.request":
      case "jira.issue.get.request":
      case "jira.issue.create.request":
      case "jira.issue.create_meta.request":
      case "jira.issue.update.request":
      case "jira.issue.transitions.request":
      case "jira.issue.transition.request":
      case "jira.issue.assign.request":
      case "jira.issue.rank.request":
      case "jira.issue.watch.request":
      case "jira.issue.unwatch.request":
      case "jira.issue.watchers.set.request":
      case "jira.issue.changelog.list.request":
      case "jira.issue.comments.list.request":
      case "jira.issue.comments.add.request":
      case "jira.issue.comments.update.request":
      case "jira.issue.worklog.list.request":
      case "jira.issue.worklog.add.request":
      case "jira.issue.attachments.upload.request":
      case "jira.issue.attachments.download.request":
      case "jira.issue.attachments.delete.request":
      case "jira.issue.links.add.request":
      case "jira.search.request":
      case "jira.jql.suggest.request":
      case "jira.filters.list.request":
      case "jira.filters.save.request":
      case "jira.users.find.request":
      case "jira.swimlanes.get.request":
      case "jira.swimlanes.set.request":
        return this.jiraSession.handle(msg);
      default:
        return undefined;
    }
  }

  private createFigmaSession(service: FigmaService | null | undefined): FigmaSession | null {
    if (!service) return null;
    return new FigmaSession({
      service,
      emit: (msg) => this.emit(msg),
      logger: this.sessionLogger,
      canRunLoopback: () => this.supports(CLIENT_CAPS.figmaOauthLoopback),
    });
  }

  // Figma (spec 32.9): the allowlist is FIGMA_REQUEST_TYPES, the same list FigmaService's handler
  // map is type-checked against, so every listed type has a handler.
  private dispatchFigmaMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!this.figmaSession || !isFigmaRequest(msg)) return undefined;
    return this.figmaSession.handle(msg);
  }

  private dispatchSideloadMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!this.sideloadSession?.handles(msg.type)) return undefined;
    return this.sideloadSession.handle(msg);
  }

  private dispatchSshMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!msg.type.startsWith("ssh.")) {
      return undefined;
    }
    return this.sshSession.handleMessage(msg);
  }

  private dispatchDatabaseMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "database/list":
        return this.databaseSession.handleList(msg);
      case "database/add":
        return this.databaseSession.handleAdd(msg);
      case "database/connect":
        return this.reopenRemoteDatabase(msg.id).then(() =>
          this.databaseSession.handleConnect(msg),
        );
      case "database/disconnect":
        return this.databaseSession.handleDisconnect(msg);
      case "database/remove":
        return this.databaseSession.handleRemove(msg);
      case "database/databases":
        return this.databaseSession.handleDatabases(msg);
      case "database/open-database":
        return this.databaseSession.handleOpenDatabase(msg);
      case "database/schemas":
        return this.databaseSession.handleSchemas(msg);
      case "database/objects":
        return this.databaseSession.handleObjects(msg);
      case "database/columns":
        return this.databaseSession.handleColumns(msg);
      case "database/query":
        return this.databaseSession.handleQuery(msg);
      case "database/exec":
        return this.databaseSession.handleExec(msg);
      case "database/foreign-keys":
        return this.databaseSession.handleForeignKeys(msg);
      case "database/indexes":
        return this.databaseSession.handleIndexes(msg);
      case "database/routines":
        return this.databaseSession.handleRoutines(msg);
      case "database/explain":
        return this.databaseSession.handleExplain(msg);
      case "database/begin":
        return this.databaseSession.handleBegin(msg);
      case "database/commit":
        return this.databaseSession.handleCommit(msg);
      case "database/rollback":
        return this.databaseSession.handleRollback(msg);
      default:
        return undefined;
    }
  }

  private dispatchMigrationMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "export_host_data_request":
        return this.handleExportHostDataRequest(msg);
      case "import_host_data_request":
        return this.handleImportHostDataRequest(msg);
      default:
        return undefined;
    }
  }

  private async handleExportHostDataRequest(
    msg: Extract<SessionInboundMessage, { type: "export_host_data_request" }>,
  ): Promise<void> {
    try {
      const bundle = await exportHostData({
        serverId: this.serverId,
        agentStorage: this.agentStorage,
        workspaceRegistry: this.workspaceRegistry,
        projectRegistry: this.projectRegistry,
        logger: this.sessionLogger,
        ...(msg.agentIds ? { agentIds: msg.agentIds } : {}),
      });
      this.emit({
        type: "export_host_data_response",
        payload: { requestId: msg.requestId, bundle, error: null },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error }, "Failed to export host data");
      this.emit({
        type: "export_host_data_response",
        payload: { requestId: msg.requestId, bundle: null, error: message },
      });
    }
  }

  private async handleImportHostDataRequest(
    msg: Extract<SessionInboundMessage, { type: "import_host_data_request" }>,
  ): Promise<void> {
    try {
      const result = await importHostData({
        targetServerId: this.serverId,
        bundle: msg.bundle,
        agentStorage: this.agentStorage,
        workspaceRegistry: this.workspaceRegistry,
        projectRegistry: this.projectRegistry,
        logger: this.sessionLogger,
      });
      // Surface the newly-imported workspaces so the client's directory refreshes.
      for (const raw of msg.bundle.workspaces) {
        const workspaceId = (raw as { workspaceId?: unknown }).workspaceId;
        if (typeof workspaceId !== "string") {
          continue;
        }
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (workspace) {
          await this.registerWorkspaceForImportedAgent(workspace);
        }
      }
      this.emit({
        type: "import_host_data_response",
        payload: { requestId: msg.requestId, result, error: null },
      });
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error }, "Failed to import host data");
      this.emit({
        type: "import_host_data_response",
        payload: { requestId: msg.requestId, result: null, error: message },
      });
    }
  }

  private async dispatchMiscMessage(msg: SessionInboundMessage): Promise<void> {
    switch (msg.type) {
      case "list_commands_request":
        await this.handleListCommandsRequest(msg);
        return;
      case "register_push_token":
        this.handleRegisterPushToken(msg.token);
        return;
    }
  }

  public resetPeakInflight(): void {
    this.peakInflightRequests = this.inflightRequests;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async handleBinaryFrame(binaryFrame: BinaryFrame, source?: object): Promise<void> {
    if (binaryFrame.kind === "plugin") {
      const frame = binaryFrame.frame;
      if (frame.opcode !== PluginFrameOpcode.Input) return;
      await this.handleMessage(
        {
          type: "plugin.rpc.invoke.request",
          requestId: frame.requestId,
          pluginId: frame.pluginId,
          method: frame.method,
          input: frame.payload,
        },
        source,
      );
      return;
    }
    if (binaryFrame.kind === "file_transfer") {
      await this.workspaceFilesSession.handleFileTransferFrame(binaryFrame.frame);
      return;
    }
    // Screen frames only flow daemon → client.
    if (binaryFrame.kind === "screen") return;
    this.terminalStreamControllerForSource(source).handleBinaryFrame(binaryFrame.frame);
  }

  private async handleRestartServerRequest(
    requestId: string,
    reason: string | undefined,
    options: { keepTerminals: boolean },
  ): Promise<void> {
    const lifecycleReason = normalizeClientRestartRpcReason(reason);
    const payload: { status: string } & Record<string, unknown> = {
      status: "restart_requested",
      clientId: this.clientId,
    };
    if (reason && reason.trim().length > 0) {
      payload.reason = reason;
    }
    payload.requestId = requestId;

    this.sessionLogger.warn(
      { reason: lifecycleReason, keepTerminals: options.keepTerminals },
      "Restart requested via websocket",
    );
    this.emit({
      type: "status",
      payload,
    });

    this.emitLifecycleIntent({
      type: "restart",
      clientId: this.clientId,
      requestId,
      reason: lifecycleReason,
      keepTerminals: options.keepTerminals,
    });
  }

  private async handleShutdownServerRequest(
    requestId: string,
    options: { keepTerminals: boolean },
  ): Promise<void> {
    const reason = CLIENT_SHUTDOWN_RPC_REASON;
    this.sessionLogger.warn(
      { reason, keepTerminals: options.keepTerminals },
      "Shutdown requested via websocket",
    );
    this.emit({
      type: "status",
      payload: {
        status: "shutdown_requested",
        clientId: this.clientId,
        requestId,
      },
    });

    this.emitLifecycleIntent({
      type: "shutdown",
      clientId: this.clientId,
      requestId,
      reason,
      keepTerminals: options.keepTerminals,
    });
  }

  private emitLifecycleIntent(intent: SessionLifecycleIntent): void {
    if (!this.onLifecycleIntent) {
      return;
    }
    try {
      this.onLifecycleIntent(intent);
    } catch (error) {
      this.sessionLogger.error({ err: error, intent }, "Lifecycle intent handler failed");
    }
  }

  private async handleDeleteAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Deleting agent ${agentId} from registry`);

    const knownWorkspaceId =
      this.agentManager.getAgent(agentId)?.workspaceId ??
      (await this.agentStorage.get(agentId))?.workspaceId ??
      null;

    // File-backed storage still needs an early delete fence before closeAgent().
    beginAgentDeleteIfSupported(this.agentStorage, agentId);

    try {
      await closeAgentCommand({ agentManager: this.agentManager }, agentId);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, agentId },
        `Failed to close agent ${agentId} during delete`,
      );
    }

    // Drain queued persistence from the just-closed agent before removing its
    // durable snapshot, otherwise an in-flight background write can recreate it.
    await this.agentManager.flush();

    try {
      await this.agentStorage.remove(agentId);
      await this.agentManager.deleteAgentState(agentId);
    } catch (error) {
      this.sessionLogger.error({ err: error, agentId }, `Failed to fully delete agent ${agentId}`);
    }

    this.emit({
      type: "agent_deleted",
      payload: {
        agentId,
        requestId,
      },
    });

    await this.agentUpdates.removeAgent(agentId);

    if (knownWorkspaceId) {
      await this.emitWorkspaceUpdateForWorkspaceId(knownWorkspaceId);
    }
  }

  private async handleArchiveAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Archiving agent ${agentId}`);

    const { archivedAt } = await this.archiveAgentForClose(agentId);

    this.emit({
      type: "agent_archived",
      payload: {
        agentId,
        archivedAt,
        requestId,
      },
    });
  }

  private async archiveAgentForClose(
    agentId: string,
  ): Promise<{ agentId: string; archivedAt: string }> {
    const { archivedAt, record: archivedRecord } = await archiveAgentCommand(
      {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      },
      agentId,
    );

    if (this.agentUpdates.hasSubscription()) {
      const payload = await this.agentUpdates.emitStoredRecord(archivedRecord);
      if (payload.workspaceId) {
        await this.emitWorkspaceUpdateForWorkspaceId(payload.workspaceId);
      }
    }

    return { agentId, archivedAt };
  }

  private async handleDetachAgentRequest(agentId: string, requestId: string): Promise<void> {
    this.sessionLogger.info({ agentId, requestId }, "Detaching agent from parent");

    try {
      const result = await detachAgentCommand({ agentManager: this.agentManager }, agentId);
      const affectedWorkspaceIds = new Set<string>();

      if (!result.live) {
        const payload = await this.agentUpdates.emitStoredRecord(result.record);
        if (payload.workspaceId) {
          affectedWorkspaceIds.add(payload.workspaceId);
        }
      } else if (result.record.workspaceId) {
        affectedWorkspaceIds.add(result.record.workspaceId);
      }

      if (result.previousParentAgentId) {
        const rootWorkspaceId = await this.resolveDelegationRootWorkspaceId(
          result.previousParentAgentId,
        );
        if (rootWorkspaceId) {
          affectedWorkspaceIds.add(rootWorkspaceId);
        }
      }

      await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);

      this.emit({
        type: "agent.detach.response",
        payload: {
          requestId,
          agentId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      const message = getErrorMessageOr(error, "Failed to detach agent");
      this.sessionLogger.error({ err: error, agentId, requestId }, "Failed to detach agent");
      this.emit({
        type: "agent.detach.response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: message,
        },
      });
    }
  }

  private async handleCloseItemsRequest(msg: CloseItemsRequest): Promise<void> {
    const archiveResults = await Promise.allSettled(
      msg.agentIds.map((agentId) => this.archiveAgentForClose(agentId)),
    );
    const agents = [];
    for (let i = 0; i < archiveResults.length; i += 1) {
      const result = archiveResults[i];
      if (result.status === "fulfilled") {
        agents.push(result.value);
      } else {
        this.sessionLogger.warn(
          { err: result.reason, agentId: msg.agentIds[i], requestId: msg.requestId },
          "Failed to archive agent during close_items batch",
        );
      }
    }

    const terminals = [];
    for (const terminalId of msg.terminalIds) {
      try {
        terminals.push(this.terminalController.killTerminalForClose(terminalId));
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, terminalId, requestId: msg.requestId },
          "Failed to kill terminal during close_items batch",
        );
        terminals.push({
          terminalId,
          success: false,
        });
      }
    }

    this.emit({
      type: "close_items_response",
      payload: {
        agents,
        terminals,
        requestId: msg.requestId,
      },
    });
  }

  private async unarchiveAgentByHandle(handle: AgentPersistenceHandle): Promise<{
    record: StoredAgentRecord;
    didUnarchive: boolean;
    originalArchivedAt: string | null;
  } | null> {
    const records = await this.agentStorage.list();
    const matched = records
      .filter(
        (record) =>
          record.persistence?.provider === handle.provider &&
          record.persistence?.sessionId === handle.sessionId,
      )
      .reduce<StoredAgentRecord | null>((latest, candidate) => {
        if (!latest) {
          return candidate;
        }
        const updatedDelta =
          Date.parse(resolveStoredAgentPayloadUpdatedAt(candidate)) -
          Date.parse(resolveStoredAgentPayloadUpdatedAt(latest));
        if (updatedDelta !== 0) {
          return updatedDelta > 0 ? candidate : latest;
        }
        return Date.parse(candidate.createdAt) > Date.parse(latest.createdAt) ? candidate : latest;
      }, null);
    if (!matched) {
      return null;
    }
    const didUnarchive = await unarchiveAgentState(
      this.agentStorage,
      this.agentManager,
      matched.id,
    );
    return {
      record: matched,
      didUnarchive,
      originalArchivedAt: matched.archivedAt ?? null,
    };
  }

  private async handleUpdateAgentRequest(
    agentId: string,
    name: string | undefined,
    labels: Record<string, string> | undefined,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      {
        agentId,
        requestId,
        hasName: typeof name === "string",
        labelCount: labels ? Object.keys(labels).length : 0,
      },
      "session: update_agent_request",
    );

    try {
      const result = await updateAgentCommand(
        { agentManager: this.agentManager },
        { agentId, name, labels },
      );

      if (!result.accepted) {
        this.emit({
          type: "update_agent_response",
          payload: {
            requestId,
            agentId,
            accepted: false,
            error: result.error,
          },
        });
        return;
      }

      this.emit({
        type: "update_agent_response",
        payload: { requestId, agentId, accepted: true, error: null },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId, requestId },
        "session: update_agent_request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to update agent: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "update_agent_response",
        payload: {
          requestId,
          agentId,
          accepted: false,
          error: getErrorMessageOr(error, "Failed to update agent"),
        },
      });
    }
  }

  private async handleProjectRenameRequest(
    projectId: string,
    customName: string | null,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      { projectId, requestId, hasCustomName: typeof customName === "string" },
      "session: project.rename.request",
    );

    try {
      const existing = await this.projectRegistry.get(projectId);
      if (!existing) {
        this.emit({
          type: "project.rename.response",
          payload: {
            requestId,
            projectId,
            accepted: false,
            customName: null,
            error: "Project not found",
          },
        });
        return;
      }

      const trimmed = customName?.trim() ?? "";
      const nextCustomName = trimmed.length === 0 ? null : trimmed;

      const updated = {
        ...existing,
        customName: nextCustomName,
        updatedAt: new Date().toISOString(),
      };
      await this.projectRegistry.upsert(updated);

      this.emit({
        type: "project.rename.response",
        payload: {
          requestId,
          projectId,
          accepted: true,
          customName: nextCustomName,
          error: null,
        },
      });

      // Emit a project.update so clients that track the project as an empty
      // project (no workspaces yet) receive the resolved name immediately.
      this.emitProjectUpdate({ kind: "upsert", project: updated });

      // Re-emit descriptors for every workspace under this project so the new
      // resolved name lands in the UI immediately.
      const workspaces = await this.workspaceRegistry.list();
      const affectedWorkspaceIds = workspaces
        .filter((workspace) => workspace.projectId === existing.projectId)
        .map((workspace) => workspace.workspaceId);
      if (affectedWorkspaceIds.length > 0) {
        await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);
      }
    } catch (error) {
      this.sessionLogger.error(
        { err: error, projectId, requestId },
        "session: project.rename.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to rename project: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "project.rename.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          customName: null,
          error: getErrorMessageOr(error, "Failed to rename project"),
        },
      });
    }
  }

  private async handleProjectIconSetRequest(
    request: Extract<SessionInboundMessage, { type: "project.icon.set.request" }>,
  ): Promise<void> {
    const { projectId, requestId } = request;
    try {
      const updated = await setProjectCustomIcon({
        jagentdeskHome: this.jagentdeskHome,
        projectId,
        source: request.source,
        projects: this.projectRegistry,
      });

      this.emit({
        type: "project.icon.set.response",
        payload: { requestId, projectId, accepted: true, error: null },
      });
      this.emitProjectUpdate({ kind: "upsert", project: updated });

      const affectedWorkspaceIds = (await this.workspaceRegistry.list())
        .filter((workspace) => workspace.projectId === projectId)
        .map((workspace) => workspace.workspaceId);
      if (affectedWorkspaceIds.length > 0) {
        await this.emitWorkspaceUpdatesForWorkspaceIds(affectedWorkspaceIds);
      }
    } catch (error) {
      this.emit({
        type: "project.icon.set.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          error: getErrorMessageOr(error, "Failed to update project icon"),
        },
      });
    }
  }

  private async handleProjectIconGetRequest(projectId: string, requestId: string): Promise<void> {
    try {
      const project = await this.projectRegistry.get(projectId);
      if (!project) throw new Error("Project not found");

      const icon = await readProjectIcon({ jagentdeskHome: this.jagentdeskHome, project });
      this.emit({
        type: "project.icon.get.response",
        payload: { projectId, icon, error: null, requestId },
      });
    } catch (error) {
      this.emit({
        type: "project.icon.get.response",
        payload: { projectId, icon: null, error: getErrorMessage(error), requestId },
      });
    }
  }

  private async handleProjectRemoveRequest(
    request: Extract<SessionInboundMessage, { type: "project.remove.request" }>,
  ): Promise<void> {
    const { projectId, requestId } = request;
    this.sessionLogger.info({ projectId, requestId }, "session: project.remove.request");

    try {
      const project = await this.projectRegistry.get(projectId);
      const resolvedProjectId = project?.projectId ?? projectId;
      const projectWorkspaces = (await this.workspaceRegistry.list()).filter(
        (workspace) => workspace.projectId === resolvedProjectId,
      );
      const activeWorkspaceIds = projectWorkspaces
        .filter((workspace) => !workspace.archivedAt)
        .map((workspace) => workspace.workspaceId);

      const removedWorkspaceIds: string[] = [];
      this.markWorkspaceArchiving(activeWorkspaceIds, new Date().toISOString());
      try {
        if (activeWorkspaceIds.length > 0) {
          await this.publishWorkspaceArchiveUpdates(activeWorkspaceIds);
        }
        for (const workspaceId of activeWorkspaceIds) {
          const archivedAt = new Date().toISOString();
          await archiveWorkspaceContents(
            {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              killTerminalsForWorkspace: (id) =>
                this.terminalController.killTerminalsForWorkspace(id),
              sessionLogger: this.sessionLogger,
            },
            workspaceId,
            archivedAt,
          );
          await this.archiveWorkspaceRecord(workspaceId, archivedAt);
          removedWorkspaceIds.push(workspaceId);
        }

        await this.projectRegistry.remove(resolvedProjectId);
        await removeProjectCustomIcon({
          jagentdeskHome: this.jagentdeskHome,
          projectId: resolvedProjectId,
        }).catch((error) => {
          this.sessionLogger.warn(
            { err: error, projectId: resolvedProjectId },
            "Failed to clean up removed project icon",
          );
        });

        const updateIds =
          removedWorkspaceIds.length > 0
            ? removedWorkspaceIds
            : [projectWorkspaces[0]?.workspaceId ?? projectId];
        await this.emitWorkspaceUpdatesForWorkspaceIds(updateIds, { removedProjectId: projectId });
      } finally {
        this.clearWorkspaceArchiving(activeWorkspaceIds);
        if (activeWorkspaceIds.length > 0) {
          await this.publishWorkspaceArchiveUpdates(activeWorkspaceIds);
        }
      }

      this.emit({
        type: "project.remove.response",
        payload: {
          requestId,
          projectId,
          accepted: true,
          removedWorkspaceIds,
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, projectId, requestId },
        "session: project.remove.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to remove project: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "project.remove.response",
        payload: {
          requestId,
          projectId,
          accepted: false,
          removedWorkspaceIds: [],
          error: getErrorMessageOr(error, "Failed to remove project"),
        },
      });
    }
  }

  private async handleWorkspaceTitleSetRequest(
    workspaceId: string,
    title: string | null,
    requestId: string,
  ): Promise<void> {
    this.sessionLogger.info(
      { workspaceId, requestId, hasTitle: typeof title === "string" },
      "session: workspace.title.set.request",
    );

    try {
      const trimmed = title?.trim() ?? "";
      const nextTitle = trimmed.length === 0 ? null : trimmed;
      const updatedAt = new Date().toISOString();
      const updated = await this.workspaceRegistry.update(workspaceId, (existing) => ({
        ...existing,
        title: nextTitle,
        updatedAt,
      }));
      if (!updated) {
        this.emit({
          type: "workspace.title.set.response",
          payload: {
            requestId,
            workspaceId,
            accepted: false,
            title: null,
            error: "Workspace not found",
          },
        });
        return;
      }

      this.emit({
        type: "workspace.title.set.response",
        payload: {
          requestId,
          workspaceId,
          accepted: true,
          title: nextTitle,
          error: null,
        },
      });

      await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
    } catch (error) {
      this.sessionLogger.error(
        { err: error, workspaceId, requestId },
        "session: workspace.title.set.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to set workspace title: ${getErrorMessage(error)}`,
        },
      });
      this.emit({
        type: "workspace.title.set.response",
        payload: {
          requestId,
          workspaceId,
          accepted: false,
          title: null,
          error: getErrorMessageOr(error, "Failed to set workspace title"),
        },
      });
    }
  }

  private async handleWorkspaceBaseBranchSetRequest(
    msg: WorkspaceBaseBranchSetRequest,
  ): Promise<void> {
    try {
      this.workspaceBaseBranch ??= createWorkspaceBaseBranchService({
        jagentdeskHome: this.jagentdeskHome,
        worktreesRoot: this.worktreesRoot,
        workspaceRegistry: this.workspaceRegistry,
        workspaceGitService: this.workspaceGitService,
      });
      const baseRef = await this.workspaceBaseBranch.setBaseBranch(msg);
      this.emit({
        type: "workspace.base_branch.set.response",
        payload: {
          requestId: msg.requestId,
          workspaceId: msg.workspaceId,
          accepted: true,
          baseRef,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.base_branch.set.response",
        payload: {
          requestId: msg.requestId,
          workspaceId: msg.workspaceId,
          accepted: false,
          baseRef: null,
          error: getErrorMessage(error),
        },
      });
    }
  }

  private async handleWorkspacePinSetRequest(
    workspaceId: string,
    pinned: boolean,
    requestId: string,
  ): Promise<void> {
    const logContext = { workspaceId, pinned, requestId };
    this.sessionLogger.info(logContext, "session: workspace.pin.set.request");
    const emitResponse = (accepted: boolean, pinnedAt: string | null, error: string | null) => {
      this.emit({
        type: "workspace.pin.set.response",
        payload: { requestId, workspaceId, accepted, pinnedAt, error },
      });
    };

    try {
      const nextPinnedAt = pinned ? new Date().toISOString() : null;
      const updatedAt = new Date().toISOString();
      const updated = await this.workspaceRegistry.update(workspaceId, (existing) => ({
        ...existing,
        pinnedAt: nextPinnedAt,
        updatedAt,
      }));
      if (!updated) {
        emitResponse(false, null, "Workspace not found");
        return;
      }
      emitResponse(true, nextPinnedAt, null);
      await this.emitWorkspaceUpdatesForWorkspaceIds([workspaceId]);
    } catch (error) {
      this.sessionLogger.error(
        { ...logContext, err: error },
        "session: workspace.pin.set.request error",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to pin workspace: ${getErrorMessage(error)}`,
        },
      });
      emitResponse(false, null, getErrorMessageOr(error, "Failed to pin workspace"));
    }
  }

  private async handleWorkspaceRecoveryInspectRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.recovery.inspect.request" }>,
  ): Promise<void> {
    const state = await this.workspaceRecovery.inspect(request.workspaceId);
    this.emit({
      type: "workspace.recovery.inspect.response",
      payload: {
        requestId: request.requestId,
        state,
      },
    });
  }

  private async handleWorkspaceRecoveryRestoreRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.recovery.restore.request" }>,
  ): Promise<void> {
    try {
      await this.restoreWorkspaceAndEmit(request.workspaceId);
      this.emit({
        type: "workspace.recovery.restore.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      const message = getErrorMessageOr(error, "Failed to recover workspace");
      this.sessionLogger.warn(
        { err: error, workspaceId: request.workspaceId, requestId: request.requestId },
        "session: workspace.recovery.restore.request rejected",
      );
      this.emit({
        type: "workspace.recovery.restore.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          accepted: false,
          error: message,
        },
      });
    }
  }

  /**
   * Handle text message to agent (with optional image attachments)
   */
  private async handleSendAgentMessage(
    agentId: string,
    text: string,
    messageId?: string,
    images?: Array<{ data: string; mimeType: string }>,
    attachments?: AgentAttachment[],
    runOptions?: AgentRunOptions,
    options?: { spokenInput?: boolean },
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    this.sessionLogger.info(
      {
        agentId,
        textPreview: text.substring(0, 50),
        imageCount: images?.length ?? 0,
        attachmentCount: attachments?.length ?? 0,
      },
      `Sending text to agent ${agentId}${
        images && images.length > 0 ? ` with ${images.length} image attachment(s)` : ""
      }${
        attachments && attachments.length > 0
          ? ` and ${attachments.length} structured attachment(s)`
          : ""
      }`,
    );

    const promptText = options?.spokenInput ? wrapSpokenInput(text) : text;
    // If the agent just switched provider, prepend the prior conversation (staged
    // as a chat-history attachment) so the new provider opens with full context.
    const providerSwitchSeed = this.agentManager.consumeProviderSwitchSeed(agentId);
    const effectiveAttachments = providerSwitchSeed
      ? [providerSwitchSeed, ...(attachments ?? [])]
      : attachments;
    const prompt = buildAgentPrompt(promptText, images, effectiveAttachments);

    try {
      await sendPromptToAgent({
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        agentId,
        prompt,
        messageId,
        runOptions,
        logger: this.sessionLogger,
      });
      return { ok: true };
    } catch (error) {
      this.handleAgentRunError(agentId, error, "Failed to send agent message");
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Handle create agent request
   */
  // Idempotency for createAgent: a repeated request carrying the same clientMessageId (double
  // dispatch, WS resend/reconnect) returns the already-created agent instead of spawning a duplicate.
  private readonly createdAgentByClientMessageId = new Map<string, string>();
  private readonly createAgentInFlight = new Map<string, Promise<string | null>>();

  private async emitExistingAgentCreated(agentId: string, requestId?: string): Promise<void> {
    if (!requestId) return;
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;
    const agentPayload = await this.buildAgentPayload(agent);
    this.emit({
      type: "status",
      payload: { status: "agent_created", agentId, requestId, agent: agentPayload },
    });
  }

  // Returns true (and re-emits the existing agent) if this clientMessageId already produced — or is
  // producing — an agent, so the caller can skip creating a duplicate.
  private async reuseExistingCreateAgent(
    clientMessageId: string,
    requestId?: string,
  ): Promise<boolean> {
    const existingId = this.createdAgentByClientMessageId.get(clientMessageId);
    if (existingId && this.agentManager.getAgent(existingId)) {
      await this.emitExistingAgentCreated(existingId, requestId);
      return true;
    }
    const inFlight = this.createAgentInFlight.get(clientMessageId);
    if (inFlight) {
      const id = await inFlight.catch(() => null);
      if (id && this.agentManager.getAgent(id)) {
        await this.emitExistingAgentCreated(id, requestId);
        return true;
      }
    }
    return false;
  }

  // Register an in-flight create for a clientMessageId (no-op when absent); returns its resolver.
  private beginCreateInFlight(clientMessageId: string | undefined): (id: string | null) => void {
    if (!clientMessageId) return () => {};
    let resolveFn: (id: string | null) => void = () => {};
    this.createAgentInFlight.set(
      clientMessageId,
      new Promise<string | null>((r) => {
        resolveFn = r;
      }),
    );
    return resolveFn;
  }

  private endCreateInFlight(
    clientMessageId: string | undefined,
    resolveInFlight: (id: string | null) => void,
    createdAgentId: string | null,
  ): void {
    if (!clientMessageId) return;
    resolveInFlight(createdAgentId);
    this.createAgentInFlight.delete(clientMessageId);
  }

  private recordCreatedAgent(clientMessageId: string | undefined, agentId: string): void {
    if (!clientMessageId) return;
    this.createdAgentByClientMessageId.set(clientMessageId, agentId);
    if (this.createdAgentByClientMessageId.size > 500) {
      const oldest = this.createdAgentByClientMessageId.keys().next().value;
      if (oldest !== undefined) this.createdAgentByClientMessageId.delete(oldest);
    }
  }

  private forwardCreatedAgent(agent: ManagedAgent): Promise<void> {
    return this.agentUpdates.forwardLiveAgent(this.agentManager.getAgent(agent.id) ?? agent);
  }

  private resolveCallerAgentForBackground(callerAgentId?: string): ManagedAgent | null {
    return callerAgentId ? (this.agentManager.getAgent(callerAgentId) ?? null) : null;
  }

  private async handleCreateAgentRequest(msg: CreateAgentRequestMessage): Promise<void> {
    const {
      config,
      worktreeName,
      requestId,
      initialPrompt,
      clientMessageId,
      outputSchema,
      git,
      worktree,
      autoArchive,
      images,
      attachments,
      env,
    } = msg;

    // De-duplicate by clientMessageId: a repeated create returns the already-created agent.
    if (clientMessageId && (await this.reuseExistingCreateAgent(clientMessageId, requestId)))
      return;
    const resolveInFlight = this.beginCreateInFlight(clientMessageId);
    this.sessionLogger.info(
      { cwd: config.cwd, provider: config.provider, worktreeName },
      `Creating agent in ${config.cwd} (${config.provider})${
        worktreeName ? ` with worktree ${worktreeName}` : ""
      }`,
    );

    let createdWorktreeForCleanup: CreateJAgentDeskWorktreeWorkflowResult | null = null;
    let createdAgentId: string | null = null;
    try {
      const requestedCwd = resolve(config.cwd);
      const needsRequestedDirectory =
        Boolean(worktreeName || git || worktree) || (!msg.workspaceId && !msg.callerAgentId);
      if (needsRequestedDirectory && !(await this.filesystem.isDirectory(requestedCwd))) {
        throw new Error(`Working directory does not exist or is not a directory: ${requestedCwd}`);
      }
      const trimmedPrompt = initialPrompt?.trim();
      const { provisionalTitle } = resolveCreateAgentTitles({
        configTitle: config.title,
        initialPrompt: trimmedPrompt,
      });

      const firstAgentContext: FirstAgentContext = {
        ...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      };
      const callerAgent = this.resolveCallerAgentForBackground(msg.callerAgentId);
      const background = inheritAgentBackground(msg.background, callerAgent);
      const workspacePromptTitle = resolveFirstAgentPromptTitle(firstAgentContext);
      const createdWorktree = await this.createAgentLifecycleDispatch.createWorktreeForRequest({
        cwd: config.cwd,
        target: worktree,
        firstAgentContext,
        hasLegacyGitOptions: Boolean(git),
      });
      createdWorktreeForCleanup = createdWorktree;
      const resolvedIntent = await this.resolveSessionCreateAgentIntent({
        request: msg,
        createdWorktree,
        workspacePromptTitle,
      });
      const resolvedCwd = resolve(resolvedIntent.config.cwd);
      if (!(await this.filesystem.isDirectory(resolvedCwd))) {
        throw new Error(`Working directory does not exist or is not a directory: ${resolvedCwd}`);
      }

      const { snapshot, liveSnapshot } = await createAgentCommand(
        {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.sessionLogger,
          jagentdeskHome: this.jagentdeskHome,
          worktreesRoot: this.worktreesRoot,
          providerSnapshotManager: this.providerSnapshotManager,
        },
        {
          kind: "session",
          config: resolvedIntent.config,
          workspaceId: resolvedIntent.intent.workspaceId,
          worktreeName,
          background,
          initialPrompt,
          clientMessageId,
          outputSchema,
          images,
          attachments,
          git,
          labels: resolvedIntent.intent.labels,
          env,
          provisionalTitle,
          firstAgentContext,
          buildSessionConfig: (sessionConfig, gitOptions, legacyWorktreeName, ctx) =>
            this.buildAgentSessionConfig(sessionConfig, gitOptions, legacyWorktreeName, ctx),
        },
      );
      createdAgentId = snapshot.id;
      this.recordCreatedAgent(clientMessageId, snapshot.id);
      // `snapshot` predates the initial prompt; subscribers keep the last state they receive.
      await this.forwardCreatedAgent(liveSnapshot);
      if (resolvedIntent.createdDirectoryWorkspace && trimmedPrompt) {
        this.workspaceAutoName.scheduleForDirectory(
          {
            workspaceId: resolvedIntent.intent.workspaceId,
            cwd: resolvedIntent.config.cwd,
            firstAgentContext,
          },
          { currentSelection: this.getFocusedAgentSelectionForCwd(resolvedIntent.config.cwd) },
        );
      }
      this.createAgentLifecycleDispatch.registerAutoArchiveIfRequested({
        autoArchive,
        agentId: snapshot.id,
        createdWorktree,
      });
      if (requestId) {
        const agentPayload = await this.buildAgentPayload(liveSnapshot);
        this.emit({
          type: "status",
          payload: {
            status: "agent_created",
            agentId: liveSnapshot.id,
            requestId,
            agent: agentPayload,
          },
        });
      }

      this.sessionLogger.info(
        { agentId: snapshot.id, provider: snapshot.provider },
        `Created agent ${snapshot.id} (${snapshot.provider})`,
      );
    } catch (error) {
      await this.createAgentLifecycleDispatch.cleanupCreatedWorktreeAfterFailedAgentCreate({
        createdWorktree: createdWorktreeForCleanup,
        createdAgentId,
      });
      const wireError = toWorktreeWireError(error);
      this.sessionLogger.error({ err: error }, "Failed to create agent");
      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_create_failed",
            requestId,
            error: wireError.message,
            errorCode: wireError.code,
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to create agent: ${wireError.message}`,
        },
      });
    } finally {
      this.endCreateInFlight(clientMessageId, resolveInFlight, createdAgentId);
    }
  }

  private async resolveSessionCreateAgentIntent(input: {
    request: CreateAgentRequestMessage;
    createdWorktree: CreateJAgentDeskWorktreeWorkflowResult | null;
    workspacePromptTitle: string | null;
  }): Promise<ResolvedSessionCreateAgentIntent> {
    const { request, createdWorktree } = input;
    const callerAgent = await this.resolveCreationCaller(request.callerAgentId);

    let config = request.config;

    const intent = await resolveCreateAgentIntent({
      explicitWorkspaceId: createdWorktree?.workspace.workspaceId ?? request.workspaceId,
      caller: callerAgent
        ? { id: callerAgent.id, cwd: callerAgent.cwd, workspaceId: callerAgent.workspaceId }
        : null,
      labels: request.labels,
      resolveWorkspace: async (workspaceId) => {
        if (createdWorktree?.workspace.workspaceId === workspaceId) {
          return { workspaceId, cwd: createdWorktree.workspace.cwd };
        }
        const workspace = await this.workspaceRegistry.get(workspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace ${workspaceId} not found`);
        }
        return { workspaceId, cwd: workspace.cwd };
      },
      createWorkspace: async () => ({
        workspaceId: await this.workspaceProvisioning.resolveOrCreateWorkspaceIdForCreateAgent({
          createdWorktree: null,
          cwd: config.cwd,
          initialTitle: input.workspacePromptTitle,
          background: inheritWorkspaceBackground(request.background, callerAgent),
          callerWorkspaceId: callerAgent?.workspaceId,
        }),
        cwd: config.cwd,
      }),
    });
    config = { ...config, cwd: intent.cwd };

    return {
      config,
      intent,
      createdDirectoryWorkspace: !createdWorktree && !request.workspaceId && !callerAgent,
    };
  }

  private async handleResumeAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "resume_agent_request" }>,
  ): Promise<void> {
    const { handle, overrides, requestId } = msg;
    if (!handle) {
      this.sessionLogger.warn("Resume request missing persistence handle");
      if (requestId) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: "Unable to resume agent: missing persistence handle",
            code: "agent_resume_failed",
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: "Unable to resume agent: missing persistence handle",
        },
      });
      return;
    }
    this.sessionLogger.info(
      { sessionId: handle.sessionId, provider: handle.provider },
      `Resuming agent ${handle.sessionId} (${handle.provider})`,
    );
    try {
      const matched = await this.unarchiveAgentByHandle(handle);
      const effectiveOverrides = matched
        ? { ...buildConfigOverrides(matched.record), ...overrides }
        : overrides;
      let snapshot: ManagedAgent;
      try {
        snapshot = await this.agentManager.resumeAgentFromPersistence(
          handle,
          effectiveOverrides,
          undefined,
          { workspaceId: matched?.record.workspaceId },
        );
      } catch (error) {
        if (matched?.didUnarchive && matched.originalArchivedAt) {
          await this.agentManager.archiveSnapshot(matched.record.id, matched.originalArchivedAt);
        }
        throw error;
      }
      await unarchiveAgentState(this.agentStorage, this.agentManager, snapshot.id);
      await this.agentManager.hydrateTimelineFromProvider(snapshot.id);
      await this.agentUpdates.forwardLiveAgent(snapshot);
      const timelineSize = this.agentManager.getTimeline(snapshot.id).length;
      if (requestId) {
        const agentPayload = await this.buildAgentPayload(snapshot);
        this.emit({
          type: "status",
          payload: {
            status: "agent_resumed",
            agentId: snapshot.id,
            requestId,
            timelineSize,
            agent: agentPayload,
          },
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error }, "Failed to resume agent");
      if (requestId) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: message,
            code: "agent_resume_failed",
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to resume agent: ${message}`,
        },
      });
    }
  }

  private async handleImportAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "import_agent_request" }>,
  ): Promise<void> {
    const normalized = normalizeImportAgentRequest(msg);
    if ("error" in normalized) {
      this.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId: msg.requestId,
          error: normalized.error,
        },
      });
      return;
    }
    const { provider, providerHandleId, requestId } = normalized;
    this.sessionLogger.info(
      { providerHandleId, provider },
      `Importing agent ${providerHandleId} (${provider})`,
    );

    try {
      if (!normalized.cwd) {
        throw new Error("Import requires cwd from the selected provider session");
      }
      const { snapshot, timelineSize, createdWorkspace } = await importProviderSession({
        request: normalized,
        workspaceProvisioning: this.workspaceProvisioning,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      if (createdWorkspace) {
        await this.registerWorkspaceForImportedAgent(createdWorkspace);
      }
      const agentPayload = await this.buildAgentPayload(snapshot);
      this.emit({
        type: "status",
        payload: {
          status: "agent_resumed",
          agentId: snapshot.id,
          requestId,
          timelineSize,
          agent: agentPayload,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.sessionLogger.error({ err: error }, "Failed to import agent");
      this.emit({
        type: "status",
        payload: {
          status: "agent_create_failed",
          requestId,
          error: message,
        },
      });
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to import agent: ${message}`,
        },
      });
    }
  }

  private async handleRefreshAgentRequest(
    msg: Extract<SessionInboundMessage, { type: "refresh_agent_request" }>,
  ): Promise<void> {
    const { agentId, requestId } = msg;
    this.sessionLogger.info({ agentId }, `Refreshing agent ${agentId} from persistence`);

    try {
      await this.restoreOwningWorkspaceForLegacyAgentRefresh(agentId);
      await unarchiveAgentState(this.agentStorage, this.agentManager, agentId);
      let snapshot: ManagedAgent;
      const existing = this.agentManager.getAgent(agentId);
      if (existing) {
        await this.interruptAgentIfRunning(agentId);
        snapshot = await this.agentManager.reloadAgentSession(agentId, undefined, {
          rehydrateFromDisk: true,
        });
      } else {
        const record = await this.agentStorage.get(agentId);
        if (!record) {
          throw new Error(`Agent not found: ${agentId}`);
        }
        const registeredProviderIds = this.providerSnapshotManager.listRegisteredProviderIds();
        if (!isStoredAgentProviderAvailable(record, registeredProviderIds)) {
          throw new Error(`Agent ${agentId} references unavailable provider '${record.provider}'`);
        }
        if (!toAgentPersistenceHandle(registeredProviderIds, record.persistence)) {
          throw new Error(`Agent ${agentId} cannot be refreshed because it lacks persistence`);
        }
        // Share the loader's per-agent in-flight operation with timeline fetches.
        // Unarchiving publishes the record before provider resume finishes, so
        // the agent pane can otherwise race this request and resume it twice.
        snapshot = await ensureAgentLoaded(agentId, {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          broadcastTimeline: true,
          logger: this.sessionLogger,
        });
      }
      await this.agentManager.hydrateTimelineFromProvider(agentId, { broadcast: true });
      await this.agentUpdates.forwardLiveAgent(snapshot);
      const timelineSize = this.agentManager.getTimeline(agentId).length;
      if (requestId) {
        this.emit({
          type: "status",
          payload: {
            status: "agent_refreshed",
            agentId,
            requestId,
            timelineSize,
          },
        });
      }
    } catch (error) {
      const message = getErrorMessage(error);
      this.sessionLogger.error({ err: error, agentId }, `Failed to refresh agent ${agentId}`);
      if (requestId) {
        this.emit({
          type: "rpc_error",
          payload: {
            requestId,
            requestType: msg.type,
            error: message,
            code: error instanceof WorktreeRequestError ? error.code : "agent_refresh_failed",
          },
        });
      }
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to refresh agent: ${message}`,
        },
      });
    }
  }

  private async handleCancelAgentRequest(agentId: string, requestId?: string): Promise<void> {
    this.sessionLogger.info({ agentId }, `Cancel request received for agent ${agentId}`);

    try {
      await cancelAgentRunCommand(
        { agentManager: this.agentManager, logger: this.sessionLogger },
        agentId,
      );
      if (requestId) {
        const agent = this.agentManager.getAgent(agentId);
        const payload = agent ? await this.buildAgentPayload(agent) : null;
        this.emit({
          type: "cancel_agent_response",
          payload: {
            requestId,
            agentId,
            agent: payload,
            error: null,
          },
        });
      }
    } catch (error) {
      if (requestId) {
        this.sessionLogger.error(
          { err: error, agentId },
          `Failed to cancel running agent on request for agent ${agentId}`,
        );
        const agent = this.agentManager.getAgent(agentId);
        const payload = agent ? await this.buildAgentPayload(agent) : null;
        this.emit({
          type: "cancel_agent_response",
          payload: {
            requestId,
            agentId,
            agent: payload,
            error: errorToFriendlyMessage(error),
          },
        });
      } else {
        this.handleAgentRunError(agentId, error, "Failed to cancel running agent on request");
      }
    }
  }

  private async handleAgentRewindRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.rewind.request" }>,
  ): Promise<void> {
    try {
      this.rewindInitiators.set(msg.agentId, undefined);
      await this.agentManager.rewind(msg.agentId, msg.messageId, msg.mode);
      this.emit({
        type: "agent.rewind.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          ok: true,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "agent.rewind.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          ok: false,
          error: error instanceof Error ? error.message : "Failed to rewind agent",
        },
      });
    } finally {
      this.rewindInitiators.delete(msg.agentId);
    }
  }

  // Deliver a post-rewind timeline replacement to subscribed clients. Clients that
  // support timelineReplacementInvalidation get a lightweight invalidation message
  // and re-fetch; legacy clients receive the reconstructed timeline rows inline.
  private deliverTimelineReplacement(agentId: string, initiatingSource?: object): void {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) return;
    const timeline = this.agentManager.fetchTimeline(agentId, { limit: 0 });
    const epoch = timeline.epoch;

    if (this.clientCapabilitiesBySource.size === 0) {
      if (!this.supports(CLIENT_CAPS.timelineReplacementInvalidation)) {
        this.emitReconstructedTimelineRows(agentId, agent.provider, timeline.rows, epoch);
      }
      return;
    }

    for (const [source, capabilities] of this.clientCapabilitiesBySource) {
      const isInitiator = source === initiatingSource;
      const supportsReplacement = capabilities.has(CLIENT_CAPS.timelineReplacementInvalidation);
      const isSubscribed = this.viewedTimelineAgentIdsBySource.get(source)?.has(agentId) === true;
      if (supportsReplacement) {
        if (isSubscribed && !isInitiator) {
          this.emitForSource(
            {
              type: "agent.timeline.replacement",
              payload: { agentId, epoch },
            },
            source,
          );
        }
        continue;
      }
      // COMPAT(timelineReplacementInvalidation): replay reconstructed rows to legacy
      // clients until the supported client floor advances.
      this.emitReconstructedTimelineRows(agentId, agent.provider, timeline.rows, epoch, source);
    }
  }

  private emitReconstructedTimelineRows(
    agentId: string,
    provider: ManagedAgent["provider"],
    rows: AgentTimelineFetchResult["rows"],
    epoch: string,
    source?: object,
  ): void {
    for (const row of rows) {
      if (!this.supportsTimelineItem(row.item, source)) continue;
      const event = serializeAgentStreamEvent({
        type: "timeline",
        provider,
        item: row.item,
        ...(row.turnId ? { turnId: row.turnId } : {}),
        timestamp: row.timestamp,
      });
      if (!event) continue;
      this.emitForSource(
        {
          type: "agent_stream",
          payload: { agentId, event, timestamp: row.timestamp, seq: row.seq, epoch },
        },
        source,
      );
    }
  }

  private async buildAgentSessionConfig(
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    firstAgentContext?: FirstAgentContext,
  ): Promise<{
    sessionConfig: AgentSessionConfig;
    setupContinuation?: CreateJAgentDeskWorktreeWorkflowResult["setupContinuation"];
    createdWorkspaceId?: string;
  }> {
    return buildWorktreeAgentSessionConfig(
      {
        jagentdeskHome: this.jagentdeskHome,
        worktreesRoot: this.worktreesRoot,
        sessionLogger: this.sessionLogger,
        workspaceGitService: this.workspaceGitService,
        createJAgentDeskWorktree: (input, serviceOptions) =>
          this.createJAgentDeskWorktreeWorkflow(input, {
            ...serviceOptions,
            setupContinuation: {
              kind: "agent",
              terminalManager: this.terminalManager,
              appendTimelineItem: ({ agentId, item }) =>
                appendTimelineItemIfAgentKnown({
                  agentManager: this.agentManager,
                  agentId,
                  item,
                }),
              emitLiveTimelineItem: ({ agentId, item }) =>
                emitLiveTimelineItemIfAgentKnown({
                  agentManager: this.agentManager,
                  agentId,
                  item,
                }),
              logger: this.sessionLogger,
            },
          }),
        checkoutExistingBranch: (cwd, branch) =>
          this.gitMutation.checkoutExistingBranch(cwd, branch),
        createBranchFromBase: (params) => this.gitMutation.createBranchFromBase(params),
      },
      config,
      gitOptions,
      legacyWorktreeName,
      firstAgentContext,
    );
  }

  private isPathWithinRoot(rootPath: string, candidatePath: string): boolean {
    const resolvedRoot = resolve(rootPath);
    const resolvedCandidate = resolve(candidatePath);
    if (resolvedCandidate === resolvedRoot) {
      return true;
    }
    return resolvedCandidate.startsWith(resolvedRoot + sep);
  }

  /**
   * Handle clearing agent attention flag
   */
  private async handleClearAgentAttention(
    agentId: string | string[],
    requestId?: string,
  ): Promise<void> {
    const agentIds = Array.isArray(agentId) ? agentId : [agentId];

    try {
      await Promise.all(
        agentIds.map((id) =>
          ensureAgentLoaded(id, {
            agentManager: this.agentManager,
            agentStorage: this.agentStorage,
            logger: this.sessionLogger,
          }),
        ),
      );
      await Promise.all(agentIds.map((id) => this.agentManager.clearAgentAttention(id)));
      if (requestId) {
        const agents = (
          await Promise.all(
            agentIds.map(async (id) => {
              const agent = this.agentManager.getAgent(id);
              return agent ? this.buildAgentPayload(agent) : null;
            }),
          )
        ).filter((payload): payload is NonNullable<typeof payload> => payload !== null);
        this.emit({
          type: "clear_agent_attention_response",
          payload: {
            requestId,
            agentId,
            agents,
          },
        });
      }
    } catch (error) {
      this.sessionLogger.error({ err: error, agentIds }, "Failed to clear agent attention");
      // Don't throw - this is not critical
    }
  }

  /**
   * Handle client heartbeat for activity tracking
   */
  private handleClientHeartbeat(msg: {
    deviceType: "web" | "mobile";
    focusedAgentId: string | null;
    focusedTerminalId?: string | null;
    lastActivityAt: string;
    appVisible: boolean;
    appVisibilityChangedAt?: string;
  }): void {
    const focusedTerminalId = msg.focusedTerminalId?.trim() || null;
    const appVisibilityChangedAt = msg.appVisibilityChangedAt
      ? new Date(msg.appVisibilityChangedAt)
      : new Date(msg.lastActivityAt);
    this.clientActivity = {
      deviceType: msg.deviceType,
      focusedAgentId: msg.focusedAgentId,
      focusedTerminalId,
      lastActivityAt: new Date(msg.lastActivityAt),
      appVisible: msg.appVisible,
      appVisibilityChangedAt,
    };
    if (msg.appVisible && focusedTerminalId) {
      void this.clearFocusedTerminalAttention(focusedTerminalId);
    }
  }

  private async clearFocusedTerminalAttention(terminalId: string): Promise<void> {
    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      return;
    }
    try {
      await terminalManager.clearTerminalAttention(terminalId);
    } catch (error) {
      this.sessionLogger.warn({ err: error, terminalId }, "Failed to clear terminal attention");
    }
  }

  /**
   * Handle push token registration
   */
  private handleRegisterPushToken(token: string): void {
    this.pushTokenStore.addToken(token);
    this.sessionLogger.info("Registered push token");
  }

  /**
   * Handle list commands request for an agent
   */
  private async handleListCommandsRequest(
    msg: Extract<SessionInboundMessage, { type: "list_commands_request" }>,
  ): Promise<void> {
    const { agentId, requestId, draftConfig } = msg;
    this.sessionLogger.debug(
      { agentId, draftConfig },
      `Handling list commands request for agent ${agentId}`,
    );

    try {
      const existing = this.agentManager.getAgent(agentId);
      const stored = existing ? null : await this.agentStorage.get(agentId);
      const agent =
        existing || (stored && !stored.archivedAt)
          ? await ensureAgentLoaded(agentId, {
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              logger: this.sessionLogger,
            })
          : null;

      if (agent?.session?.listCommands) {
        const commands = dedupeSlashCommands(await agent.session.listCommands());
        this.emit({
          type: "list_commands_response",
          payload: {
            agentId,
            commands,
            error: null,
            requestId,
          },
        });
        return;
      }

      if (!agent && draftConfig) {
        const sessionConfig: AgentSessionConfig = {
          provider: draftConfig.provider,
          cwd: expandTilde(draftConfig.cwd),
          ...(draftConfig.modeId ? { modeId: draftConfig.modeId } : {}),
          ...(draftConfig.model ? { model: draftConfig.model } : {}),
          ...(draftConfig.thinkingOptionId
            ? { thinkingOptionId: draftConfig.thinkingOptionId }
            : {}),
        };

        const commands = dedupeSlashCommands(
          await this.agentManager.listDraftCommands(sessionConfig),
        );
        this.emit({
          type: "list_commands_response",
          payload: {
            agentId,
            commands,
            error: null,
            requestId,
          },
        });
        return;
      }

      this.emit({
        type: "list_commands_response",
        payload: {
          agentId,
          commands: [],
          error: agent ? `Agent does not support listing commands` : `Agent not found: ${agentId}`,
          requestId,
        },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error, agentId, draftConfig }, "Failed to list commands");
      this.emit({
        type: "list_commands_response",
        payload: {
          agentId,
          commands: [],
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  /**
   * Handle agent permission response from user
   */
  private async handleAgentPermissionResponse(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    try {
      await respondToAgentPermission({
        agentManager: this.agentManager,
        agentId,
        requestId,
        response,
        logger: this.sessionLogger,
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId, requestId },
        "Failed to respond to permission",
      );
      this.emit({
        type: "activity_log",
        payload: {
          id: uuidv4(),
          timestamp: new Date(),
          type: "error",
          content: `Failed to respond to permission: ${getErrorMessage(error)}`,
        },
      });
      throw error;
    }
  }

  private async handleDirectorySuggestionsRequest(msg: DirectorySuggestionsRequest): Promise<void> {
    const { query, limit, requestId, cwd, includeFiles, includeDirectories, matchMode } = msg;

    try {
      const workspaceCwd = cwd?.trim();
      const searchesWorkspace = Boolean(workspaceCwd);
      const homeRoot = process.env.HOME ?? homedir();
      // readdir on TCC-protected folders under ~/Library blocks forever for a process that cannot
      // show a consent prompt, and each blocked call holds a libuv threadpool thread.
      const excludedDiscoveryPaths =
        !searchesWorkspace && process.platform === "darwin" ? [join(homeRoot, "Library")] : [];
      const entries = await searchDirectoryEntries({
        root: workspaceCwd ? expandTilde(workspaceCwd) : homeRoot,
        query,
        pathFormat: searchesWorkspace ? "relative" : "absolute",
        pathQueryPolicy: searchesWorkspace ? "slashes" : "rooted",
        blankQueryBehavior: searchesWorkspace ? "children" : "none",
        rootAliases: searchesWorkspace ? [] : ["~"],
        traversableHiddenDirectoryNames: searchesWorkspace
          ? WORKSPACE_SEARCH_HIDDEN_DIRECTORIES
          : [],
        confidentResultScanThreshold: searchesWorkspace ? undefined : 5_000,
        excludedDiscoveryPaths,
        includeFiles,
        includeDirectories,
        matchMode,
        limit,
      });
      const directories = entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path);
      this.emit({
        type: "directory_suggestions_response",
        payload: {
          directories,
          entries,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.emit({
        type: "directory_suggestions_response",
        payload: {
          directories: [],
          entries: [],
          error: error instanceof Error ? error.message : String(error),
          requestId,
        },
      });
    }
  }

  private async handleJAgentDeskWorktreeListRequest(
    msg: Extract<SessionInboundMessage, { type: "jagentdesk_worktree_list_request" }>,
  ): Promise<void> {
    return handleWorktreeListRequest(
      {
        emit: (message) => this.emit(message),
        jagentdeskHome: this.jagentdeskHome,
        workspaceGitService: this.workspaceGitService,
      },
      msg,
    );
  }

  private async handleJAgentDeskWorktreeArchiveRequest(
    msg: Extract<SessionInboundMessage, { type: "jagentdesk_worktree_archive_request" }>,
  ): Promise<void> {
    return handleWorktreeArchiveRequest(
      {
        jagentdeskHome: this.jagentdeskHome,
        jagentdeskWorktreesBaseRoot: this.worktreesRoot,
        github: this.github,
        workspaceGitService: this.workspaceGitService,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
        listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
        archiveWorkspaceRecord: (workspaceId, archivedAt) =>
          this.archiveWorkspaceRecord(workspaceId, archivedAt),
        emit: (message) => this.emit(message),
        emitWorkspaceUpdatesForWorkspaceIds: this.publishWorkspaceArchiveUpdates,
        markWorkspaceArchiving: (workspaceIds, archivingAt) =>
          this.markWorkspaceArchiving(workspaceIds, archivingAt),
        clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
        killTerminalsForWorkspace: (workspaceId) =>
          this.terminalController.killTerminalsForWorkspace(workspaceId),
        sessionLogger: this.sessionLogger,
      },
      msg,
    );
  }

  private async listTerminalActivityContributions(): Promise<
    Array<{ cwd: string; workspaceId?: string; activity: TerminalActivity | null }>
  > {
    const terminalManager = this.terminalManager;
    if (!terminalManager) {
      return [];
    }
    const directories = terminalManager.listDirectories();
    const terminalsByDirectory = await Promise.all(
      directories.map((cwd) => terminalManager.getTerminals(cwd)),
    );
    return terminalsByDirectory.flat().map((session) => {
      const contribution: { cwd: string; workspaceId?: string; activity: TerminalActivity | null } =
        {
          cwd: session.cwd,
          activity: session.getActivity(),
        };
      if (session.workspaceId) {
        contribution.workspaceId = session.workspaceId;
      }
      return contribution;
    });
  }

  /**
   * Build the current agent list payload (live + persisted), optionally filtered by labels.
   */
  private async listAgentPayloads(filter?: {
    labels?: Record<string, string>;
    includeArchived?: boolean;
    includeBackground?: BackgroundVisibility;
    includeUnavailablePersisted?: boolean;
  }): Promise<AgentSnapshotPayload[]> {
    return this.agentDirectory.list(filter);
  }

  private resolveBackgroundVisibility(
    includeBackground: boolean | undefined,
  ): BackgroundVisibility {
    if (!includeBackground) return false;
    return this.supports(CLIENT_CAPS.backgroundAgents) ? true : "workspaces";
  }

  private async resolveAgentIdentifier(
    identifier: string,
  ): Promise<{ ok: true; agentId: string } | { ok: false; notFound: boolean; error: string }> {
    const trimmed = identifier.trim();
    if (!trimmed) {
      return { ok: false, notFound: false, error: "Agent identifier cannot be empty" };
    }

    const stored = await this.agentStorage.list();
    const storedRecords = stored.filter((record) => !record.internal);
    const knownIds = new Set<string>();
    for (const record of storedRecords) {
      knownIds.add(record.id);
    }
    for (const agent of this.agentManager.listAgents()) {
      knownIds.add(agent.id);
    }

    if (knownIds.has(trimmed)) {
      return { ok: true, agentId: trimmed };
    }

    // A complete agent ID names one agent. When none has it, no prefix or
    // title answers for it, so a command never acts on a different agent.
    if (FULL_AGENT_ID_PATTERN.test(trimmed)) {
      return { ok: false, notFound: true, error: `Agent not found: ${trimmed}` };
    }

    const prefixMatches = Array.from(knownIds).filter((id) => id.startsWith(trimmed));
    if (prefixMatches.length === 1) {
      return { ok: true, agentId: prefixMatches[0] };
    }
    if (prefixMatches.length > 1) {
      return {
        ok: false,
        notFound: false,
        error: `Agent identifier "${trimmed}" is ambiguous (${prefixMatches
          .slice(0, 5)
          .map((id) => id.slice(0, 8))
          .join(", ")}${prefixMatches.length > 5 ? ", …" : ""})`,
      };
    }

    const titleMatches = storedRecords.filter((record) => record.title === trimmed);
    if (titleMatches.length === 1) {
      return { ok: true, agentId: titleMatches[0].id };
    }
    if (titleMatches.length > 1) {
      return {
        ok: false,
        notFound: false,
        error: `Agent title "${trimmed}" is ambiguous (${titleMatches
          .slice(0, 5)
          .map((r) => r.id.slice(0, 8))
          .join(", ")}${titleMatches.length > 5 ? ", …" : ""})`,
      };
    }

    return { ok: false, notFound: true, error: `Agent not found: ${trimmed}` };
  }

  private async getAgentPayloadById(agentId: string): Promise<AgentSnapshotPayload | null> {
    const live = this.agentManager.getAgent(agentId);
    if (live) {
      const payload = await this.buildAgentPayload(live);
      return this.isProviderVisibleToClient(payload.provider) ? payload : null;
    }

    const record = await this.agentStorage.get(agentId);
    if (!record || record.internal) {
      return null;
    }
    const payload = this.buildStoredAgentPayload(record);
    return this.isProviderVisibleToClient(payload.provider) ? payload : null;
  }

  private async resolveDelegationRootWorkspaceId(agentId: string): Promise<string | null> {
    const seen = new Set<string>();
    let currentAgentId = agentId;

    while (true) {
      if (seen.has(currentAgentId)) {
        return null;
      }
      seen.add(currentAgentId);

      const live = this.agentManager.getAgent(currentAgentId);
      const source = live ?? (await this.agentStorage.get(currentAgentId));
      if (!source) {
        return null;
      }
      if ("archivedAt" in source && source.archivedAt) {
        return null;
      }

      const parentAgentId = getParentAgentIdFromLabels(source.labels);
      if (!parentAgentId) {
        return source.workspaceId ?? null;
      }
      currentAgentId = parentAgentId;
    }
  }

  private async buildActiveProjectPlacementsByWorkspaceId(): Promise<
    Map<string, ProjectPlacementPayload>
  > {
    const [persistedWorkspaces, persistedProjects] = await Promise.all([
      this.workspaceRegistry.list(),
      this.projectRegistry.list(),
    ]);
    const activeProjects = new Map(
      persistedProjects
        .filter((project) => !project.archivedAt)
        .map((project) => [project.projectId, project] as const),
    );
    const placementsByWorkspaceId = new Map<string, ProjectPlacementPayload>();

    const pairs = persistedWorkspaces.flatMap((workspace) => {
      if (workspace.archivedAt) return [];
      const project = activeProjects.get(workspace.projectId);
      if (!project) return [];
      return [{ workspace, project }];
    });
    const placements = await Promise.all(
      pairs.map(({ workspace, project }) =>
        this.buildProjectPlacementForWorkspace(workspace, project),
      ),
    );
    for (let i = 0; i < pairs.length; i += 1) {
      placementsByWorkspaceId.set(pairs[i].workspace.workspaceId, placements[i]);
    }

    return placementsByWorkspaceId;
  }

  private async collectFetchAgentsEntries(params: {
    candidates: AgentSnapshotPayload[];
    limit: number;
    getPlacement: (workspaceId: string | undefined) => Promise<ProjectPlacementPayload | null>;
    filter: AgentUpdatesFilter | undefined;
  }): Promise<FetchAgentsResponseEntry[]> {
    const { candidates, limit, getPlacement, filter } = params;
    const matchedEntries: FetchAgentsResponseEntry[] = [];
    const batchSize = 25;
    for (
      let start = 0;
      start < candidates.length && matchedEntries.length <= limit;
      start += batchSize
    ) {
      const batch = candidates.slice(start, start + batchSize);
      const batchEntries = await Promise.all(
        batch.map(async (agent) => {
          const project = await getPlacement(agent.workspaceId);
          return project ? { agent, project } : null;
        }),
      );
      for (const entry of batchEntries) {
        if (!entry) {
          continue;
        }
        if (
          !matchesAgentUpdatesFilter({
            agent: entry.agent,
            project: entry.project,
            filter,
          })
        ) {
          continue;
        }
        matchedEntries.push(entry);
        if (matchedEntries.length > limit) {
          break;
        }
      }
    }
    return matchedEntries;
  }

  private async listFetchAgentsEntries(request: AgentDirectoryRequestMessage): Promise<{
    entries: FetchAgentsResponseEntry[];
    pageInfo: FetchAgentsResponsePageInfo;
  }> {
    const filter =
      request.type === "fetch_agent_history_request" &&
      request.filter?.includeArchived === undefined
        ? { ...request.filter, includeArchived: true }
        : request.filter;
    const scope = request.type === "fetch_agents_request" ? request.scope : undefined;
    const sort = this.agentsPager.normalizeSort(request.sort);

    let agents = await this.listAgentPayloads({
      labels: filter?.labels,
      includeArchived: filter?.includeArchived,
      includeBackground: this.resolveBackgroundVisibility(
        request.includeBackground || filter?.includeBackground,
      ),
      includeUnavailablePersisted: request.type === "fetch_agent_history_request",
    });
    const activePlacementsByWorkspaceId =
      scope === "active" ? await this.buildActiveProjectPlacementsByWorkspaceId() : null;
    if (activePlacementsByWorkspaceId) {
      agents = agents.filter(
        (agent) =>
          !agent.archivedAt &&
          agent.workspaceId != null &&
          activePlacementsByWorkspaceId.has(agent.workspaceId),
      );
    }

    const placementByWorkspaceId = new Map<string, Promise<ProjectPlacementPayload | null>>();
    const getPlacement = (
      workspaceId: string | undefined,
    ): Promise<ProjectPlacementPayload | null> => {
      if (!workspaceId) {
        return Promise.resolve(null);
      }
      if (activePlacementsByWorkspaceId) {
        return Promise.resolve(activePlacementsByWorkspaceId.get(workspaceId) ?? null);
      }
      const existing = placementByWorkspaceId.get(workspaceId);
      if (existing) {
        return existing;
      }
      const placementPromise = this.buildProjectPlacementForWorkspaceId(workspaceId);
      placementByWorkspaceId.set(workspaceId, placementPromise);
      return placementPromise;
    };

    let candidates = [...agents];
    candidates.sort((left, right) => this.agentsPager.compare(left, right, sort));
    const cursorToken = request.page?.cursor;
    if (cursorToken) {
      const cursor = this.decodeAgentCursor(cursorToken, sort);
      candidates = candidates.filter(
        (agent) => this.agentsPager.compareWithCursor(agent, cursor, sort) > 0,
      );
    }

    const limit = request.page?.limit ?? 200;

    const matchedEntries = await this.collectFetchAgentsEntries({
      candidates,
      limit,
      getPlacement,
      filter,
    });

    const pagedEntries = matchedEntries.slice(0, limit);
    const hasMore = matchedEntries.length > limit;
    const nextCursor =
      hasMore && pagedEntries.length > 0
        ? this.agentsPager.encode(pagedEntries[pagedEntries.length - 1].agent, sort)
        : null;

    return {
      entries: pagedEntries,
      pageInfo: {
        nextCursor,
        prevCursor: request.page?.cursor ?? null,
        hasMore,
      },
    };
  }

  private readonly agentsPager = new SortablePager<
    AgentSnapshotPayload,
    FetchAgentsRequestSort["key"]
  >({
    validKeys: FETCH_AGENTS_SORT_KEYS,
    defaultSort: [{ key: "updated_at", direction: "desc" }],
    label: "fetch_agents",
    getId: (agent) => agent.id,
    getSortValue: (agent, key): number | string => {
      switch (key) {
        case "status_priority":
          return getAgentStatusPriority({
            status: agent.status,
            pendingPermissionCount: agent.pendingPermissions?.length ?? 0,
            requiresAttention: agent.requiresAttention,
            attentionReason: agent.attentionReason ?? null,
            backgroundWork: agent.backgroundWork,
          });
        case "created_at":
          return Date.parse(agent.createdAt);
        case "updated_at":
          return Date.parse(agent.updatedAt);
        case "title":
          return agent.title?.toLocaleLowerCase() ?? "";
      }
    },
  });

  private decodeAgentCursor(token: string, sort: SortSpec<FetchAgentsRequestSort["key"]>[]) {
    try {
      return this.agentsPager.decode(token, sort);
    } catch (error) {
      if (error instanceof CursorError) {
        throw new SessionRequestError("invalid_cursor", error.message);
      }
      throw error;
    }
  }

  private async describeWorkspaceRecord(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const resolvedProjectRecord =
      projectRecord ?? (await this.projectRegistry.get(workspace.projectId));

    let diffStat: { additions: number; deletions: number } | null = null;
    const snapshot = this.workspaceRuntimeStore.get(workspace.cwd);
    if (snapshot?.git.diffStat) {
      diffStat = snapshot.git.diffStat;
    }

    const worktreeSlug =
      workspace.isJAgentDeskOwnedWorktree && workspace.worktreeRoot
        ? basename(workspace.worktreeRoot)
        : undefined;

    return {
      id: workspace.workspaceId,
      projectId: workspace.projectId,
      projectDisplayName: resolvedProjectRecord
        ? resolveProjectDisplayName(resolvedProjectRecord)
        : workspace.projectId,
      projectCustomName: resolvedProjectRecord?.customName ?? null,
      projectCustomIconRevision: resolvedProjectRecord?.customIconRevision ?? null,
      projectRootPath: resolvedProjectRecord?.rootPath ?? workspace.cwd,
      workspaceDirectory: workspace.cwd,
      worktreeSlug,
      projectKind: (resolvedProjectRecord?.kind ?? "directory") === "git" ? "git" : "non_git",
      workspaceKind: workspace.kind,
      name: resolveWorkspaceDisplayName(workspace),
      title: workspace.title,
      pinnedAt: workspace.pinnedAt,
      background: workspace.background,
      archivingAt: null,
      status: "done",
      statusEnteredAt: null,
      activityAt: null,
      diffStat,
      scripts: await this.buildWorkspaceScriptPayloadSnapshot(workspace, resolvedProjectRecord),
      ...(resolvedProjectRecord
        ? {
            project: await this.buildProjectPlacementForWorkspace(workspace, resolvedProjectRecord),
          }
        : {}),
    };
  }

  private buildWorkspaceGitRuntimePayload(
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): NonNullable<WorkspaceDescriptorPayload["gitRuntime"]> | null {
    if (!snapshot.git.isGit) {
      return null;
    }

    return {
      currentBranch: snapshot.git.currentBranch,
      remoteUrl: snapshot.git.remoteUrl,
      isJAgentDeskOwnedWorktree: snapshot.git.isJAgentDeskOwnedWorktree,
      isDirty: snapshot.git.isDirty,
      aheadBehind: snapshot.git.aheadBehind,
      aheadOfOrigin: snapshot.git.aheadOfOrigin,
      behindOfOrigin: snapshot.git.behindOfOrigin,
    };
  }

  private buildWorkspaceGitHubRuntimePayload(
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): NonNullable<WorkspaceDescriptorPayload["githubRuntime"]> {
    return {
      featuresEnabled: snapshot.forge.featuresEnabled,
      pullRequest: snapshot.forge.pullRequest,
      error: snapshot.forge.error,
    };
  }

  private async describeWorkspaceRecordWithGitData(
    workspace: PersistedWorkspaceRecord,
    projectRecord?: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload> {
    const base = await this.describeWorkspaceRecord(workspace, projectRecord);
    const snapshot = this.workspaceRuntimeStore.get(workspace.cwd);
    if (!snapshot) {
      return base;
    }

    const checkout = checkoutLiteFromGitSnapshot(workspace.cwd, snapshot.git);
    const displayName = deriveWorkspaceDisplayName({ cwd: workspace.cwd, checkout });

    return {
      ...base,
      name: resolveWorkspaceName({ title: workspace.title, derivedDisplayName: displayName }),
      diffStat: snapshot.git.diffStat ?? null,
      gitRuntime: this.buildWorkspaceGitRuntimePayload(snapshot) ?? undefined,
      githubRuntime: this.buildWorkspaceGitHubRuntimePayload(snapshot),
      // Reuse the forge already resolved on the snapshot (probe-aware; GitHub-only
      // resolves to "github") so the sidebar/hover-card brand mark matches the
      // status projection without a second resolve.
      forge: snapshot.forge.forge,
      forgeWeb: snapshot.forgeWeb,
    };
  }

  private async describeCreatedWorktreeWorkspace(
    result: CreateJAgentDeskWorktreeResult,
  ): Promise<WorkspaceDescriptorPayload> {
    const projectRecord = await this.projectRegistry.get(result.workspace.projectId);
    return {
      id: result.workspace.workspaceId,
      projectId: result.workspace.projectId,
      projectDisplayName: projectRecord
        ? resolveProjectDisplayName(projectRecord)
        : result.workspace.projectId,
      projectCustomName: projectRecord?.customName ?? null,
      projectCustomIconRevision: projectRecord?.customIconRevision ?? null,
      projectRootPath: projectRecord?.rootPath ?? result.repoRoot,
      workspaceDirectory: result.workspace.cwd,
      worktreeSlug: basename(result.worktree.worktreePath),
      projectKind: projectRecord?.kind ?? "git",
      workspaceKind: result.workspace.kind,
      background: result.workspace.background,
      name: resolveWorkspaceName({
        title: result.workspace.title,
        derivedDisplayName: result.worktree.branchName || result.workspace.displayName,
      }),
      title: result.workspace.title,
      pinnedAt: result.workspace.pinnedAt,
      archivingAt: null,
      status: "done",
      statusEnteredAt: result.workspace.createdAt,
      activityAt: null,
      diffStat: { additions: 0, deletions: 0 },
      scripts: [],
      gitRuntime: {
        currentBranch: result.worktree.branchName || null,
        remoteUrl: null,
        isJAgentDeskOwnedWorktree: true,
        isDirty: false,
        aheadBehind: null,
        aheadOfOrigin: null,
        behindOfOrigin: null,
      },
      githubRuntime: null,
    };
  }

  private async buildWorkspaceDescriptor(input: {
    workspace: PersistedWorkspaceRecord;
    projectRecord?: PersistedProjectRecord | null;
    includeGitData: boolean;
  }): Promise<WorkspaceDescriptorPayload> {
    if (input.includeGitData && input.workspace.kind !== "directory") {
      return this.describeWorkspaceRecordWithGitData(input.workspace, input.projectRecord);
    }
    return this.describeWorkspaceRecord(input.workspace, input.projectRecord);
  }

  markWorkspaceArchiving(workspaceIds: Iterable<string>, archivingAt: string): void {
    this.workspaceArchiveOperations.markArchiving(workspaceIds, archivingAt);
  }

  clearWorkspaceArchiving(workspaceIds: Iterable<string>): void {
    this.workspaceArchiveOperations.clearArchiving(workspaceIds);
  }

  private async buildWorkspaceDescriptorMap(options: {
    includeGitData: boolean;
    workspaceIds?: Iterable<string>;
  }): Promise<Map<string, WorkspaceDescriptorPayload>> {
    return this.workspaceDirectory.buildDescriptorMap(options);
  }

  // external path→workspace adapter, not ownership. Used by archive-by-path flows
  // where the request carries a worktree path (unique to one workspace) rather
  // than a workspaceId. This is a directory lookup for an archive target, not a
  // status/ownership attribution.
  private async findWorkspaceIdForCwd(cwd: string): Promise<string | null> {
    const workspaces = await this.workspaceRegistry.list();
    return resolveWorkspaceIdForPath(cwd, workspaces);
  }

  private matchesWorkspaceFilter(input: {
    workspace: WorkspaceDescriptorPayload;
    filter: FetchWorkspacesRequestFilter | undefined;
  }): boolean {
    return this.workspaceDirectory.matchesFilter(input);
  }

  private async listFetchWorkspacesEntries(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<{
    entries: FetchWorkspacesResponseEntry[];
    emptyProjects: WorkspaceProjectDescriptorPayload[];
    pageInfo: FetchWorkspacesResponsePageInfo;
  }> {
    try {
      return await this.workspaceDirectory.listFetchEntries({
        ...request,
        filter: {
          ...request.filter,
          ...(request.includeBackground ? { includeBackground: true } : {}),
        },
      });
    } catch (error) {
      if (error instanceof CursorError) {
        throw new SessionRequestError("invalid_cursor", error.message);
      }
      throw error;
    }
  }

  private bufferOrEmitWorkspaceUpdate(
    subscription: WorkspaceUpdatesSubscriptionState,
    payload: WorkspaceUpdatePayload,
  ): void {
    if (payload.kind === "upsert") {
      subscription.visibleEmptyProjectIds?.delete(payload.workspace.projectId);
    } else {
      if (payload.emptyProject) {
        subscription.visibleEmptyProjectIds?.add(payload.emptyProject.projectId);
      }
      if (payload.removedProjectId) {
        subscription.visibleEmptyProjectIds?.delete(payload.removedProjectId);
      }
    }
    if (subscription.isBootstrapping) {
      const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
      subscription.pendingUpdatesByWorkspaceId.set(workspaceId, payload);
      return;
    }
    const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
    subscription.lastEmittedByWorkspaceId.set(workspaceId, payload);
    this.emit({
      type: "workspace_update",
      payload,
    });
  }

  private flushBootstrappedWorkspaceUpdates(options?: {
    snapshotByWorkspaceId?: Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >;
  }): void {
    const subscription = this.workspaceUpdatesSubscription;
    if (!subscription || !subscription.isBootstrapping) {
      return;
    }

    subscription.isBootstrapping = false;
    const pending = Array.from(subscription.pendingUpdatesByWorkspaceId.values());
    subscription.pendingUpdatesByWorkspaceId.clear();

    for (const payload of pending) {
      if (payload.kind === "upsert") {
        const snapshot = options?.snapshotByWorkspaceId?.get(payload.workspace.id);
        const updateActivityAtMs = payload.workspace.activityAt
          ? Date.parse(payload.workspace.activityAt)
          : null;
        const shouldEmit = shouldEmitPendingBootstrapUpdate({
          snapshot: snapshot
            ? {
                status: snapshot.status,
                statusEnteredAt: snapshot.statusEnteredAt,
                activityAtMs: snapshot.activityAtMs,
              }
            : null,
          update: {
            status: payload.workspace.status,
            statusEnteredAt: payload.workspace.statusEnteredAt ?? null,
            activityAtMs: Number.isNaN(updateActivityAtMs) ? null : updateActivityAtMs,
          },
        });
        if (!shouldEmit) {
          continue;
        }
      }
      const workspaceId = payload.kind === "upsert" ? payload.workspace.id : payload.id;
      subscription.lastEmittedByWorkspaceId.set(workspaceId, payload);
      this.emit({
        type: "workspace_update",
        payload,
      });
    }
  }

  private buildProjectDescriptor(
    project: PersistedProjectRecord,
  ): WorkspaceProjectDescriptorPayload {
    return {
      projectId: project.projectId,
      ...(project.projectKey ? { projectKey: project.projectKey } : {}),
      projectDisplayName: resolveProjectDisplayName(project),
      projectCustomName: project.customName ?? null,
      projectCustomIconRevision: project.customIconRevision ?? null,
      projectRootPath: project.rootPath,
      projectKind: project.kind,
    };
  }

  private async restoreWorkspaceAndEmit(workspaceId: string): Promise<void> {
    await this.workspaceRecovery.restore(workspaceId);
    await this.publishRecoveredWorkspace(workspaceId);
  }

  private async publishRecoveredWorkspace(workspaceId: string): Promise<void> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) {
      throw new Error(`Recovered workspace record not found: ${workspaceId}`);
    }
    if (this.onWorkspaceRecovered) {
      try {
        await this.onWorkspaceRecovered(workspace);
        return;
      } catch (error) {
        this.sessionLogger.warn(
          { err: error, workspaceId },
          "Failed to publish workspace recovery to active sessions",
        );
      }
    }
    await this.refreshRecoveredWorkspaceForExternalMutation(workspace);
  }

  private async restoreOwningWorkspaceForLegacyAgentRefresh(agentId: string): Promise<void> {
    // COMPAT(worktreeRestore): clients older than v0.1.105 used refresh_agent_request
    // as their explicit recovery RPC. Remove after 2027-01-11.
    if (!clientUsesLegacyWorkspaceRestore(this.appVersion)) {
      return;
    }
    const record = await this.agentStorage.get(agentId);
    if (!record?.workspaceId) {
      return;
    }
    const recovery = await this.workspaceRecovery.inspect(record.workspaceId);
    if (recovery.kind !== "recoverable") {
      return;
    }
    await this.restoreWorkspaceAndEmit(record.workspaceId);
  }

  private async createJAgentDeskWorktree(
    input: CreateJAgentDeskWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
    },
  ): Promise<CreateJAgentDeskWorktreeResult> {
    const result = await createJAgentDeskWorktree(input, {
      lifecycle: this.pluginRuntime,
      github: this.github,
      ...(options?.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      workspaceGitService: this.workspaceGitService,
      workspaceProvisioning: this.workspaceProvisioning,
    });
    void Promise.all([
      this.gitMutation.notifyGitMutation(input.cwd, "create-worktree"),
      this.gitMutation.notifyGitMutation(result.worktree.worktreePath, "create-worktree"),
    ]).catch((error) => {
      this.sessionLogger.warn(
        { err: error, cwd: input.cwd, worktreePath: result.worktree.worktreePath },
        "Failed to warm git snapshots after creating worktree",
      );
    });
    return result;
  }

  private async listActiveWorkspaceRefs(): Promise<ActiveWorkspaceRef[]> {
    const workspaces = await this.workspaceRegistry.list();
    return workspaces
      .filter((workspace) => !workspace.archivedAt)
      .map((workspace) => ({
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
        kind: workspace.kind,
        worktreeRoot: workspace.worktreeRoot,
        isJAgentDeskOwnedWorktree: workspace.isJAgentDeskOwnedWorktree,
        mainRepoRoot: workspace.mainRepoRoot,
      }));
  }

  private async archiveWorkspaceRecord(workspaceId: string, archivedAt?: string): Promise<void> {
    const archiveTimestamp = archivedAt ?? new Date().toISOString();
    const existingWorkspace = await archivePersistedWorkspaceRecord({
      workspaceId,
      archivedAt: archiveTimestamp,
      workspaceRegistry: this.workspaceRegistry,
    });
    if (!existingWorkspace) {
      this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
      return;
    }

    if (!existingWorkspace.archivedAt) {
      const activeSiblings = (await this.workspaceRegistry.list()).filter(
        (workspace) => workspace.projectId === existingWorkspace.projectId && !workspace.archivedAt,
      );
      this.sessionLogger.info(
        {
          workspaceId,
          workspaceCwd: existingWorkspace.cwd,
          projectId: existingWorkspace.projectId,
          projectArchived: activeSiblings.length === 0,
          archivedAt: archiveTimestamp,
        },
        "Workspace archived",
      );
    }

    await this.teardownArchivedWorkspace(existingWorkspace.workspaceId);
  }

  private async teardownArchivedWorkspace(workspaceId: string): Promise<void> {
    this.workspaceGitObserver.removeForWorkspaceId(workspaceId);
    this.scriptRuntimeStore?.removeForWorkspace(workspaceId);
    releaseWorkspaceServicePortPlan(workspaceId);
  }

  private async emitWorkspaceUpdatesForWorkspaceIds(
    workspaceIds: Iterable<string>,
    options?: WorkspaceUpdateOptions,
  ): Promise<void> {
    const subscription = this.workspaceUpdatesSubscription;
    if (!subscription) {
      return;
    }

    const uniqueWorkspaceIds = new Set(Array.from(workspaceIds));
    if (uniqueWorkspaceIds.size === 0) {
      return;
    }

    await this.enqueueWorkspaceUpdates(uniqueWorkspaceIds, subscription, options);
  }

  private enqueueWorkspaceUpdates(
    workspaceIds: ReadonlySet<string>,
    subscription: WorkspaceUpdatesSubscriptionState,
    options: WorkspaceUpdateOptions | undefined,
  ): Promise<void> {
    const previous = Array.from(workspaceIds, (workspaceId) =>
      (this.workspaceUpdateTails.get(workspaceId) ?? Promise.resolve()).catch(() => undefined),
    );
    const next = Promise.all(previous).then(() =>
      this.emitWorkspaceUpdateBatch(workspaceIds, subscription, options),
    );
    for (const workspaceId of workspaceIds) {
      this.workspaceUpdateTails.set(workspaceId, next);
    }

    const clearTail = () => {
      for (const workspaceId of workspaceIds) {
        if (this.workspaceUpdateTails.get(workspaceId) === next) {
          this.workspaceUpdateTails.delete(workspaceId);
        }
      }
    };
    void next.then(clearTail, clearTail);
    return next;
  }

  private async emitWorkspaceUpdateBatch(
    workspaceIds: ReadonlySet<string>,
    subscription: WorkspaceUpdatesSubscriptionState,
    options: WorkspaceUpdateOptions | undefined,
  ): Promise<void> {
    if (this.workspaceUpdatesSubscription !== subscription) {
      return;
    }

    const descriptorsByWorkspaceId = await this.buildWorkspaceDescriptorMap({
      workspaceIds,
      includeGitData: true,
    });

    for (const workspaceId of workspaceIds) {
      if (this.workspaceUpdatesSubscription !== subscription) {
        return;
      }
      const workspace = descriptorsByWorkspaceId.get(workspaceId);
      const filteredWorkspace =
        workspace && this.matchesWorkspaceFilter({ workspace, filter: subscription.filter })
          ? workspace
          : null;
      const nextWorkspace = this.applyOptimisticWorkspaceStatus(
        filteredWorkspace,
        options?.optimisticStatus,
      );
      const lastEmitted = subscription.lastEmittedByWorkspaceId.get(workspaceId);
      if (
        options?.dedupeGitState &&
        this.workspaceGitObserver.shouldSkipUpdate(workspaceId, nextWorkspace)
      ) {
        continue;
      }
      this.workspaceGitObserver.recordDescriptorState(workspaceId, nextWorkspace);

      if (!nextWorkspace) {
        if (this.shouldSkipWorkspaceRemoval(lastEmitted, options?.removedProjectId)) {
          continue;
        }
        if (this.workspaceUpdatesSubscription !== subscription) {
          return;
        }
        subscription.lastEmittedByWorkspaceId.delete(workspaceId);
        this.bufferOrEmitWorkspaceUpdate(
          subscription,
          await this.buildWorkspaceRemoveUpdatePayload(workspaceId, options?.removedProjectId),
        );
        continue;
      }

      const nextPayload: WorkspaceUpdatePayload = {
        kind: "upsert",
        workspace: nextWorkspace,
      };

      if (
        lastEmitted &&
        lastEmitted.kind === "upsert" &&
        equal(lastEmitted.workspace, nextWorkspace)
      ) {
        continue;
      }

      this.bufferOrEmitWorkspaceUpdate(subscription, nextPayload);
    }
  }

  private applyOptimisticWorkspaceStatus(
    workspace: WorkspaceDescriptorPayload | null,
    optimisticStatus: WorkspaceDescriptorPayload["status"] | undefined,
  ): WorkspaceDescriptorPayload | null {
    if (!workspace || !optimisticStatus) {
      return workspace;
    }
    return { ...workspace, status: optimisticStatus };
  }

  private shouldSkipWorkspaceRemoval(
    lastEmitted: WorkspaceUpdatePayload | undefined,
    removedProjectId: string | undefined,
  ): boolean {
    if (lastEmitted?.kind === "remove") {
      return !removedProjectId || lastEmitted.removedProjectId === removedProjectId;
    }
    return !lastEmitted && !removedProjectId;
  }

  private async buildWorkspaceRemoveUpdatePayload(
    workspaceId: string,
    removedProjectId?: string,
  ): Promise<WorkspaceUpdatePayload> {
    if (removedProjectId) {
      return { kind: "remove", id: workspaceId, removedProjectId };
    }
    return {
      kind: "remove",
      id: workspaceId,
      ...(await this.resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(workspaceId)),
    };
  }

  // When a workspace is archived its project may have no active workspaces left.
  // Resolve that project parent so the `remove` update can carry it, keeping the
  // sidebar in sync without a full re-hydration.
  private async resolveProjectWithoutActiveWorkspacesForArchivedWorkspace(
    workspaceId: string,
  ): Promise<{ emptyProject: WorkspaceProjectDescriptorPayload } | null> {
    const archivedWorkspace = await this.workspaceRegistry.get(workspaceId);
    if (!archivedWorkspace) {
      return null;
    }
    const projectWithoutActiveWorkspaces = (await this.workspaceDirectory.listEmptyProjects()).find(
      (project) => project.projectId === archivedWorkspace.projectId,
    );
    return projectWithoutActiveWorkspaces ? { emptyProject: projectWithoutActiveWorkspaces } : null;
  }

  private async emitWorkspaceUpdateForTerminalContribution(
    event: TerminalWorkspaceContributionChangedEvent,
  ): Promise<void> {
    // A terminal's activity contributes only to the workspace it carries. A
    // terminal with no workspaceId attributes to nothing — status is per-id.
    if (!event.workspaceId) {
      return;
    }
    await this.emitWorkspaceUpdatesForWorkspaceIds([event.workspaceId]);
  }

  // A git fact (branch, diff, dirty, PR) changed at `cwd`. Every workspace whose
  // OWN cwd is this folder re-derives its git facts from that folder (id → cwd)
  // and emits its own per-id descriptor. This is a deliberate same-folder fan,
  // not a cwd → id ownership lookup: git never resolves which workspace owns a
  // path. See `workspaceIdsOnCheckout`.
  private async emitWorkspaceUpdateForCwd(
    cwd: string,
    options?: {
      dedupeGitState?: boolean;
    },
  ): Promise<void> {
    const workspaceIds = workspaceIdsOnCheckout(await this.workspaceRegistry.list(), cwd);
    if (workspaceIds.length === 0) {
      return;
    }
    await this.emitWorkspaceUpdatesForWorkspaceIds(workspaceIds, options);
  }

  private async handleFetchAgents(
    request: Extract<SessionInboundMessage, { type: "fetch_agents_request" }>,
  ): Promise<void> {
    // Guest session (ADR-0019): confine the directory to the one shared agent and skip the live
    // subscription entirely — a guest must never learn about other agents, even via later pushes.
    if (this.guestAgentId !== null) {
      const payload = await this.listFetchAgentsEntries(request);
      const entries = payload.entries.filter((e) => e.agent.id === this.guestAgentId);
      this.emit({
        type: "fetch_agents_response",
        payload: { requestId: request.requestId, ...payload, entries },
      });
      return;
    }

    const requestedSubscriptionId = request.subscribe?.subscriptionId?.trim();
    const subscriptionId = resolveSubscriptionId(request.subscribe, requestedSubscriptionId);

    try {
      if (subscriptionId) {
        this.agentUpdates.beginSubscription({
          subscriptionId,
          filter: request.filter,
          backgroundVisibility: this.resolveBackgroundVisibility(
            request.includeBackground || request.filter?.includeBackground,
          ),
        });
      }

      const payload = await this.listFetchAgentsEntries(request);
      const snapshotUpdatedAtByAgentId = new Map<string, number>();
      for (const entry of payload.entries) {
        const parsedUpdatedAt = Date.parse(entry.agent.updatedAt);
        if (!Number.isNaN(parsedUpdatedAt)) {
          snapshotUpdatedAtByAgentId.set(entry.agent.id, parsedUpdatedAt);
        }
      }

      this.emit({
        type: "fetch_agents_response",
        payload: {
          requestId: request.requestId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...payload,
        },
      });

      if (subscriptionId) {
        this.agentUpdates.flushBootstrapped(subscriptionId, { snapshotUpdatedAtByAgentId });
      }
    } catch (error) {
      if (subscriptionId) {
        this.agentUpdates.clearSubscription(subscriptionId);
      }
      const code = error instanceof SessionRequestError ? error.code : "fetch_agents_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch agents";
      this.sessionLogger.error({ err: error }, "Failed to handle fetch_agents_request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleFetchAgentHistory(
    request: Extract<SessionInboundMessage, { type: "fetch_agent_history_request" }>,
  ): Promise<void> {
    try {
      const payload = await this.listFetchAgentsEntries(request);
      this.emit({
        type: "fetch_agent_history_response",
        payload: {
          requestId: request.requestId,
          ...payload,
        },
      });
    } catch (error) {
      const code = error instanceof SessionRequestError ? error.code : "fetch_agent_history_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch agent history";
      this.sessionLogger.error({ err: error }, "Failed to handle fetch_agent_history_request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleFetchRecentProviderSessions(
    request: Extract<SessionInboundMessage, { type: "fetch_recent_provider_sessions_request" }>,
  ): Promise<void> {
    try {
      const result = await listImportableProviderSessions({
        request,
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        providerSnapshotManager: this.providerSnapshotManager,
      });
      this.emit({
        type: "fetch_recent_provider_sessions_response",
        payload: {
          requestId: request.requestId,
          entries: result.entries,
          ...(result.filteredAlreadyImportedCount > 0
            ? { filteredAlreadyImportedCount: result.filteredAlreadyImportedCount }
            : {}),
        },
      });
    } catch (error) {
      const code =
        error instanceof ImportSessionsRequestError
          ? error.code
          : "fetch_recent_provider_sessions_failed";
      const message =
        error instanceof Error ? error.message : "Failed to fetch recent provider sessions";
      this.sessionLogger.error(
        { err: error },
        "Failed to handle fetch_recent_provider_sessions_request",
      );
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleFetchWorkspacesRequest(
    request: Extract<SessionInboundMessage, { type: "fetch_workspaces_request" }>,
  ): Promise<void> {
    const requestedSubscriptionId = request.subscribe?.subscriptionId?.trim();
    const subscriptionId = resolveSubscriptionId(request.subscribe, requestedSubscriptionId);

    try {
      this.sessionLogger.debug(
        {
          requestId: request.requestId,
          subscribeRequested: Boolean(request.subscribe),
          filter: {
            ...request.filter,
            ...(request.includeBackground ? { includeBackground: true } : {}),
          },
          sort: request.sort ?? null,
          page: request.page ?? null,
        },
        "fetch_workspaces_request_received",
      );
      if (subscriptionId) {
        this.workspaceUpdatesSubscription = {
          subscriptionId,
          filter: {
            ...request.filter,
            ...(request.includeBackground ? { includeBackground: true } : {}),
          },
          isBootstrapping: true,
          pendingUpdatesByWorkspaceId: new Map(),
          lastEmittedByWorkspaceId: new Map(),
          visibleEmptyProjectIds: new Set(),
        };
      }

      const payload = await this.listFetchWorkspacesEntries(request);
      this.workspaceGitObserver.syncObservers(payload.entries);
      this.sessionLogger.debug(
        {
          requestId: request.requestId,
          subscriptionId,
          pageInfo: payload.pageInfo,
          payload: summarizeFetchWorkspacesEntries(payload.entries),
        },
        "fetch_workspaces_response_ready",
      );
      const snapshot = this.buildBootstrapSnapshot(payload.entries);
      this.seedWorkspaceSubscriptionSnapshot(
        subscriptionId,
        request.filter,
        payload.entries,
        payload.emptyProjects,
      );

      this.emit({
        type: "fetch_workspaces_response",
        payload: {
          requestId: request.requestId,
          ...(subscriptionId ? { subscriptionId } : {}),
          ...payload,
        },
      });

      if (subscriptionId && this.workspaceUpdatesSubscription?.subscriptionId === subscriptionId) {
        this.flushBootstrappedWorkspaceUpdates(snapshot);
      }
    } catch (error) {
      if (subscriptionId && this.workspaceUpdatesSubscription?.subscriptionId === subscriptionId) {
        this.workspaceUpdatesSubscription = null;
      }
      const code = error instanceof SessionRequestError ? error.code : "fetch_workspaces_failed";
      const message = error instanceof Error ? error.message : "Failed to fetch workspaces";
      this.sessionLogger.error({ err: error }, "Failed to handle fetch_workspaces_request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: message,
          code,
        },
      });
    }
  }

  private async handleProjectListRequest(requestId: string): Promise<void> {
    // Guests (ADR-0019) don't browse projects — return empty so the runtime bootstrap succeeds
    // without exposing the host's project list.
    if (this.guestAgentId !== null) {
      this.emit({ type: "project.list.response", payload: { requestId, projects: [] } });
      return;
    }
    try {
      const projects = (await this.projectRegistry.list())
        .filter((project) => !project.archivedAt)
        .map((project) => this.buildProjectDescriptor(project));
      this.emit({
        type: "project.list.response",
        payload: { requestId, projects },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to handle project.list.request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId,
          requestType: "project.list.request",
          error: error instanceof Error ? error.message : "Failed to list projects",
          code: "project_list_failed",
        },
      });
    }
  }

  private async handleProjectSuggestionsRequest(
    request: Extract<SessionInboundMessage, { type: "project.suggestions.request" }>,
  ): Promise<void> {
    try {
      const result = await listProjectSuggestions({
        request,
        agentManager: this.agentManager,
        projectRegistry: this.projectRegistry,
        workspaceGitService: this.workspaceGitService,
      });
      this.emit({
        type: "project.suggestions.response",
        payload: { requestId: request.requestId, ...result },
      });
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to handle project.suggestions.request");
      this.emit({
        type: "rpc_error",
        payload: {
          requestId: request.requestId,
          requestType: request.type,
          error: error instanceof Error ? error.message : "Failed to list project suggestions",
          code:
            error instanceof ProjectSuggestionsRequestError
              ? error.code
              : "project_suggestions_failed",
        },
      });
    }
  }

  // Build the bootstrap snapshot used by `flushBootstrappedWorkspaceUpdates`
  // to decide which pending updates to drop. Captures the status,
  // statusEnteredAt, and activityAt (parsed to ms) for each workspace entry
  // so a status-only change (e.g. the unmask case), a statusEnteredAt-only
  // change (e.g. a fresh unmask time), AND a fresher activity all still
  // ship to the client.
  private buildBootstrapSnapshot(entries: FetchWorkspacesResponseEntry[]): {
    snapshotByWorkspaceId: Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >;
  } {
    const snapshotByWorkspaceId = new Map<
      string,
      { status: string; statusEnteredAt: string | null; activityAtMs: number | null }
    >();
    for (const entry of entries) {
      const parsedActivity = entry.activityAt ? Date.parse(entry.activityAt) : null;
      snapshotByWorkspaceId.set(entry.id, {
        status: entry.status,
        statusEnteredAt: entry.statusEnteredAt ?? null,
        activityAtMs: Number.isNaN(parsedActivity) ? null : parsedActivity,
      });
    }
    return { snapshotByWorkspaceId };
  }

  private seedWorkspaceSubscriptionSnapshot(
    subscriptionId: string | null,
    filter: FetchWorkspacesRequestFilter | undefined,
    entries: FetchWorkspacesResponseEntry[],
    emptyProjects: WorkspaceProjectDescriptorPayload[],
  ): void {
    const subscription = this.workspaceUpdatesSubscription;
    if (!subscription) return;
    if (subscriptionId && subscription.subscriptionId !== subscriptionId) return;
    if (!subscriptionId && !equal(subscription.filter, filter)) return;
    for (const entry of entries) {
      subscription.lastEmittedByWorkspaceId.set(entry.id, {
        kind: "upsert",
        workspace: entry,
      });
    }
    for (const project of emptyProjects) {
      subscription.visibleEmptyProjectIds?.add(project.projectId);
    }
  }

  private async registerWorkspaceForImportedAgent(
    workspace: PersistedWorkspaceRecord,
  ): Promise<void> {
    try {
      await this.syncWorkspaceGitObserverForWorkspace(workspace);
      await this.describeWorkspaceRecord(workspace);
      await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, workspaceId: workspace.workspaceId, cwd: workspace.cwd },
        "Failed to register workspace for imported agent",
      );
    }
  }

  private async handleWorkspaceCreateRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
  ): Promise<void> {
    try {
      const provision = async (workspaceId?: string) => {
        if (this.pluginRuntime?.before) {
          const { type, requestId, ...input } = request;
          request = {
            ...(await this.pluginRuntime.before("workspace.create.before", input)),
            type,
            requestId,
          };
        }
        return request.source.kind === "directory"
          ? this.handleWorkspaceCreateLocal(request, workspaceId)
          : this.handleWorkspaceCreateWorktree(request, workspaceId);
      };
      let workspace: WorkspaceDescriptorPayload | undefined;
      if (request.idempotencyKey) {
        const { requestId: _requestId, idempotencyKey, ...fingerprint } = request;
        const creation = await this.creationService.create({
          kind: "workspace",
          key: idempotencyKey,
          request: fingerprint,
          hasAgent: false,
          hasPrompt: false,
          exists: async (_kind, id) => (await this.workspaceRegistry.get(id)) !== null,
          provision: async (id) => ({ workspace: await provision(id) }),
        });
        if (creation.error || !creation.workspace)
          throw new Error(creation.error ?? "Workspace creation failed");
        workspace = creation.workspace;
      } else {
        // COMPAT(workspaceRequestReceipts): added in v0.9.59, remove after 2027-05-24.
        workspace = await provision();
      }
      this.emit({
        type: "workspace.create.response",
        payload: {
          requestId: request.requestId,
          workspace,
          setupTerminalId: null,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create workspace";
      this.sessionLogger.error(
        { err: error, sourceKind: request.source.kind, requestId: request.requestId },
        "Failed to create workspace",
      );
      const errorCode =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : undefined;
      this.emit({
        type: "workspace.create.response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          setupTerminalId: null,
          error: message,
          errorCode,
        },
      });
    }
  }

  private async resolveCreationCaller(
    callerAgentId?: string,
  ): Promise<(CreateAgentCaller & { background?: boolean }) | null> {
    if (!callerAgentId) return null;
    const stored = await this.agentStorage.get(callerAgentId);
    if (stored?.archivedAt) throw new Error(`Caller agent ${callerAgentId} not found`);
    const caller = this.agentManager.getAgent(callerAgentId) ?? stored;
    if (!caller) throw new Error(`Caller agent ${callerAgentId} not found`);
    return {
      id: caller.id,
      cwd: caller.cwd,
      workspaceId: caller.workspaceId,
      background: caller.background,
    };
  }

  private async callerWorkspaceForBackground(callerAgentId?: string): Promise<string | undefined> {
    return (await this.resolveCreationCaller(callerAgentId))?.workspaceId;
  }

  private async handleWorkspaceCreateLocal(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    workspaceId?: string,
  ): Promise<WorkspaceDescriptorPayload> {
    if (request.source.kind !== "directory") {
      throw new Error("Invalid workspace source");
    }

    const cwd = expandTilde(request.source.path);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists)
      throw Object.assign(new Error(`Directory not found: ${cwd}`), {
        code: "directory_not_found",
      });

    const explicitTitle = request.title?.trim() || null;
    const promptTitle = resolveFirstAgentPromptTitle(request.firstAgentContext);
    const workspace = await this.workspaceProvisioning.createWorkspaceForDirectory(
      cwd,
      explicitTitle ?? promptTitle,
      request.source.projectId,
      {
        expectsInitialAgent: Boolean(request.firstAgentContext),
        workspaceId,
        background: request.background,
        callerWorkspaceId: await this.callerWorkspaceForBackground(request.callerAgentId),
      },
    );
    await this.syncWorkspaceGitObserverForWorkspace(workspace);
    const descriptor = await this.describeWorkspaceRecord(workspace);
    await this.emitCreatedWorkspaceUpdate(
      descriptor,
      request.firstAgentContext ? "running" : undefined,
    );
    void this.workspaceGitService
      .getSnapshot(workspace.cwd, { force: true, includeForge: true, reason: "open_project" })
      .catch((error) => {
        this.sessionLogger.warn(
          { err: error, cwd: workspace.cwd },
          "Background snapshot refresh failed after workspace.create",
        );
      });
    if (request.firstAgentContext) {
      const firstAgentContext = request.firstAgentContext;
      this.workspaceAutoName.scheduleForDirectory(
        {
          workspaceId: workspace.workspaceId,
          cwd: workspace.cwd,
          firstAgentContext,
        },
        { currentSelection: this.getFocusedAgentSelectionForCwd(workspace.cwd) },
      );
    }
    return descriptor;
  }

  private async handleWorkspaceCreateWorktree(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    workspaceId?: string,
  ): Promise<WorkspaceDescriptorPayload> {
    if (request.source.kind !== "worktree") {
      throw new Error("Invalid workspace source");
    }

    const source = request.source;

    if (!source.cwd && !source.projectId)
      throw Object.assign(
        new Error("cwd or projectId is required for a worktree-backed workspace"),
        { code: "source_required" },
      );

    const sourceCwd = await resolveWorktreeSourceCwd(source, this.projectRegistry);

    const result = await this.createJAgentDeskWorktreeWorkflow(
      {
        cwd: sourceCwd,
        workspaceId,
        projectId: source.projectId,
        worktreeSlug: source.worktreeSlug,
        action: source.action,
        refName: source.refName,
        branchName: source.branchName,
        checkoutSource: source.checkoutSource,
        githubPrNumber: source.githubPrNumber,
        firstAgentContext: request.firstAgentContext,
        title: request.title,
        background: request.background,
        callerWorkspaceId: await this.callerWorkspaceForBackground(request.callerAgentId),
      },
      source.baseBranch
        ? { resolveDefaultBranch: async () => source.baseBranch as string }
        : undefined,
    );

    const descriptor = await this.describeCreatedWorktreeWorkspace(result);
    await this.emitCreatedWorkspaceUpdate(
      descriptor,
      request.firstAgentContext ? "running" : undefined,
    );
    return descriptor;
  }

  private async handleOpenProjectRequest(
    request: Extract<SessionInboundMessage, { type: "open_project_request" }>,
  ): Promise<void> {
    const requestedCwd = request.cwd;
    const cwd = expandTilde(requestedCwd);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      this.sessionLogger.info(
        { requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" },
        "Open project rejected",
      );
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          error: `Directory not found: ${cwd}`,
          errorCode: "directory_not_found",
        },
      });
      return;
    }

    try {
      const projectsBefore = new Map<string, PersistedProjectRecord>();
      for (const project of await this.projectRegistry.list()) {
        projectsBefore.set(project.projectId, project);
      }
      const workspacesBefore = new Map<string, PersistedWorkspaceRecord>();
      for (const workspaceRecord of await this.workspaceRegistry.list()) {
        workspacesBefore.set(workspaceRecord.workspaceId, workspaceRecord);
      }
      const workspace = await this.workspaceProvisioning.findOrCreateWorkspaceForDirectory(cwd);
      const project = await this.projectRegistry.get(workspace.projectId);
      await this.syncWorkspaceGitObserverForWorkspace(workspace);
      const descriptor = await this.describeWorkspaceRecord(workspace);
      await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
      this.sessionLogger.info(
        {
          requestedCwd,
          resolvedCwd: cwd,
          workspaceCwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
          workspaceKind: workspace.kind,
          workspaceTransition: describeRegistryTransition(
            workspacesBefore.get(workspace.workspaceId) ?? null,
          ),
          projectId: workspace.projectId,
          projectKind: project?.kind ?? null,
          projectTransition: describeRegistryTransition(
            projectsBefore.get(workspace.projectId) ?? null,
          ),
        },
        "Project opened",
      );
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: descriptor,
          error: null,
        },
      });
      void this.workspaceGitService
        .getSnapshot(workspace.cwd, {
          force: true,
          includeForge: true,
          reason: "open_project",
        })
        .catch((error) => {
          this.sessionLogger.warn(
            { err: error, cwd: workspace.cwd },
            "Background snapshot refresh failed after open_project",
          );
        });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to open project";
      this.sessionLogger.error({ err: error, cwd }, "Failed to open project");
      this.emit({
        type: "open_project_response",
        payload: {
          requestId: request.requestId,
          workspace: null,
          error: message,
        },
      });
    }
  }

  private async handleProjectAddRequest(
    request: Extract<SessionInboundMessage, { type: "project.add.request" }>,
  ): Promise<void> {
    const requestedCwd = request.cwd;
    const cwd = expandTilde(requestedCwd);
    const directoryExists = await this.filesystem.isDirectory(cwd).catch(() => false);
    if (!directoryExists) {
      this.sessionLogger.info(
        { requestedCwd, resolvedCwd: cwd, reason: "directory_not_found" },
        "Add project rejected",
      );
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: null,
          error: `Directory not found: ${cwd}`,
          errorCode: "directory_not_found",
        },
      });
      return;
    }

    try {
      const projectsBefore = new Map<string, PersistedProjectRecord>();
      for (const project of await this.projectRegistry.list()) {
        projectsBefore.set(project.projectId, project);
      }
      const project = await this.workspaceProvisioning.findOrCreateProjectForDirectory(cwd);
      this.sessionLogger.info(
        {
          requestedCwd,
          resolvedCwd: cwd,
          projectId: project.projectId,
          projectKind: project.kind,
          projectTransition: describeRegistryTransition(
            projectsBefore.get(project.projectId) ?? null,
          ),
        },
        "Project added",
      );
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: this.buildProjectDescriptor(project),
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to add project";
      this.sessionLogger.error({ err: error, cwd }, "Failed to add project");
      this.emit({
        type: "project.add.response",
        payload: {
          requestId: request.requestId,
          project: null,
          error: message,
        },
      });
    }
  }

  private async handleProjectCreateDirectoryRequest(
    request: Extract<SessionInboundMessage, { type: "project.create_directory.request" }>,
  ): Promise<void> {
    try {
      const result = await createProjectDirectory(
        { parentPath: request.parentPath, name: request.name },
        {
          registerProject: (directoryPath) =>
            this.workspaceProvisioning.findOrCreateProjectForDirectory(directoryPath),
        },
      );
      this.emit({
        type: "project.create_directory.response",
        payload: {
          requestId: request.requestId,
          directoryPath: result.directoryPath,
          project: this.buildProjectDescriptor(result.project),
          error: null,
          errorCode: null,
        },
      });
    } catch (error) {
      const requestError =
        error instanceof ProjectDirectoryRequestError
          ? error
          : new ProjectDirectoryRequestError(
              "registration_failed",
              error instanceof Error ? error.message : "Failed to create project directory",
            );
      this.sessionLogger.error(
        {
          err: error,
          parentPath: request.parentPath,
          name: request.name,
          errorCode: requestError.code,
        },
        "Failed to create project directory",
      );
      this.emit({
        type: "project.create_directory.response",
        payload: {
          requestId: request.requestId,
          directoryPath: requestError.directoryPath,
          project: null,
          error: requestError.message,
          errorCode: requestError.code,
        },
      });
    }
  }

  private async handleWorkspaceGithubSearchRepositoriesRequest(
    request: Extract<
      SessionInboundMessage,
      { type: "workspace.github.search_repositories.request" }
    >,
  ): Promise<void> {
    try {
      const searchRepositories = (this.github as Partial<GitHubService>).searchRepositories;
      if (!searchRepositories) {
        throw new Error("GitHub repository search is unavailable");
      }
      const repositories = await searchRepositories.call(this.github, {
        cwd: homedir(),
        query: request.query,
        limit: request.limit,
      });
      this.emit({
        type: "workspace.github.search_repositories.response",
        payload: {
          requestId: request.requestId,
          repositories,
          status: "success",
          available: true,
          error: null,
        },
      });
    } catch (error) {
      const missing = error instanceof GitHubCliMissingError;
      const unauthenticated = error instanceof GitHubAuthenticationError;
      const commandError = error instanceof GitHubCommandError ? error.stderr.trim() : "";
      let message: string;
      if (missing) {
        message = "GitHub CLI (gh) is not installed or not in PATH";
      } else if (unauthenticated) {
        message = "GitHub CLI is not authenticated. Run gh auth login on the host.";
      } else if (commandError) {
        message = commandError;
      } else {
        message = error instanceof Error ? error.message : "GitHub search failed";
      }
      let payload: WorkspaceGithubSearchRepositoriesResponsePayload;
      if (missing) {
        payload = {
          status: "unavailable",
          requestId: request.requestId,
          repositories: [],
          reason: "gh_missing",
          available: false,
          error: message,
        };
      } else if (unauthenticated) {
        payload = {
          status: "unauthenticated",
          requestId: request.requestId,
          repositories: [],
          available: false,
          error: message,
        };
      } else {
        payload = {
          status: "error",
          requestId: request.requestId,
          repositories: [],
          available: true,
          error: message,
        };
      }
      this.sessionLogger.warn({ err: error }, "GitHub repository search failed");
      this.emit({
        type: "workspace.github.search_repositories.response",
        payload,
      });
    }
  }

  private async handleProjectGithubCloneRequest(
    request: Extract<SessionInboundMessage, { type: "project.github.clone.request" }>,
  ): Promise<void> {
    let normalizedRepo = request.repo;
    let checkoutPath: string | null = null;
    try {
      const repo = normalizeCloneRepository({
        repo: request.repo,
        cloneProtocol: request.cloneProtocol,
      });
      normalizedRepo = repo.displayName;
      const targetParent = resolve(expandTilde(request.targetDirectory.trim()));
      checkoutPath = resolve(targetParent, repo.name);
      if (!this.isPathWithinRoot(targetParent, checkoutPath)) {
        throw new Error("Resolved checkout path must stay inside the target directory");
      }

      await mkdir(targetParent, { recursive: true });
      try {
        await lstat(checkoutPath);
        throw new Error(`Checkout path already exists: ${checkoutPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }

      const cloneStagingPath = await mkdtemp(resolve(targetParent, ".jagentdesk-clone-"));
      try {
        await runGitCommand(["clone", repo.cloneUrl, cloneStagingPath], {
          cwd: targetParent,
          timeout: 5 * 60 * 1000,
          maxOutputBytes: 1024 * 1024,
          logger: this.sessionLogger,
        });
        await rename(cloneStagingPath, checkoutPath);
      } catch (error) {
        await rm(cloneStagingPath, { recursive: true, force: true }).catch((cleanupError) => {
          this.sessionLogger.warn(
            { err: cleanupError, cloneStagingPath },
            "Failed to clean up partial GitHub clone",
          );
        });
        throw error;
      }

      const project =
        await this.workspaceProvisioning.findOrCreateProjectForDirectory(checkoutPath);

      this.emit({
        type: "project.github.clone.response",
        payload: {
          requestId: request.requestId,
          repo: repo.displayName,
          checkoutPath,
          project: this.buildProjectDescriptor(project),
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to clone GitHub repo";
      this.sessionLogger.error(
        { err: error, repo: request.repo, targetDirectory: request.targetDirectory },
        "Failed to clone GitHub project",
      );
      this.emit({
        type: "project.github.clone.response",
        payload: {
          requestId: request.requestId,
          repo: normalizedRepo,
          checkoutPath,
          project: null,
          error: message,
        },
      });
    }
  }

  // Named accessor: the workspace descriptor builder and the git-watch test both read a workspace's
  // scripts snapshot through here; the workspace-scripts module owns the payload assembly.
  private buildWorkspaceScriptPayloadSnapshot(
    workspace: PersistedWorkspaceRecord,
    project: PersistedProjectRecord | null,
  ): Promise<WorkspaceDescriptorPayload["scripts"]> {
    return this.workspaceScripts.buildSnapshot(workspace, project);
  }

  private handleStartWorkspaceScriptRequest(request: StartWorkspaceScriptRequest): Promise<void> {
    return this.workspaceScripts.start(request);
  }

  private async handleWorkspaceScriptListRequest(
    request: WorkspaceScriptListRequest,
  ): Promise<void> {
    try {
      const scripts = await this.workspaceScripts.list(request.workspaceId);
      this.emit({
        type: "workspace.script.list.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scripts,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.script.list.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scripts: [],
          error: error instanceof Error ? error.message : "Failed to list workspace scripts",
        },
      });
    }
  }

  private async handleWorkspaceScriptStartRequest(
    request: WorkspaceScriptStartRequest,
  ): Promise<void> {
    try {
      const script = await this.workspaceScripts.launch(request);
      this.emit({
        type: "workspace.script.start.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.script.start.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script: null,
          error: error instanceof Error ? error.message : "Failed to start workspace script",
        },
      });
    }
  }

  private async handleWorkspaceScriptStopRequest(
    request: WorkspaceScriptStopRequest,
  ): Promise<void> {
    try {
      const script = await this.workspaceScripts.stop(request);
      this.emit({
        type: "workspace.script.stop.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "workspace.script.stop.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          scriptName: request.scriptName,
          script: null,
          error: error instanceof Error ? error.message : "Failed to stop workspace script",
        },
      });
    }
  }

  // COMPAT(desktopEditorBridge): added in v0.1.88, remove after 2026-12-03 once old clients no longer call daemon editor RPCs.
  private async handleLegacyListAvailableEditorsRequest(
    request: Extract<SessionInboundMessage, { type: "list_available_editors_request" }>,
  ): Promise<void> {
    this.emit({
      type: "list_available_editors_response",
      payload: {
        requestId: request.requestId,
        editors: [],
        error: "Editor opening moved to the desktop app and is no longer supported by the daemon",
      },
    });
  }

  private async handleLegacyOpenInEditorRequest(
    request: Extract<SessionInboundMessage, { type: "open_in_editor_request" }>,
  ): Promise<void> {
    this.emit({
      type: "open_in_editor_response",
      payload: {
        requestId: request.requestId,
        error: "Editor opening moved to the desktop app and is no longer supported by the daemon",
      },
    });
  }

  private async handleCreateJAgentDeskWorktreeRequest(
    request: Extract<SessionInboundMessage, { type: "create_jagentdesk_worktree_request" }>,
  ): Promise<void> {
    return handleCreateWorktreeRequest(
      {
        jagentdeskHome: this.jagentdeskHome,
        worktreesRoot: this.worktreesRoot,
        describeWorkspaceRecord: (result) => this.describeCreatedWorktreeWorkspace(result),
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        createJAgentDeskWorktreeWorkflow: (input) => this.createJAgentDeskWorktreeWorkflow(input),
      },
      request,
    );
  }

  private async createJAgentDeskWorktreeWorkflow(
    input: CreateJAgentDeskWorktreeInput,
    options?: {
      resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
      setupContinuation?: CreateJAgentDeskWorktreeSetupContinuationInput;
    },
  ): Promise<CreateJAgentDeskWorktreeWorkflowResult> {
    return createWorktreeWorkflow(
      {
        jagentdeskHome: this.jagentdeskHome,
        worktreesRoot: this.worktreesRoot,
        createJAgentDeskWorktree: (workflowInput, serviceOptions) =>
          this.createJAgentDeskWorktree(workflowInput, serviceOptions),
        warmWorkspaceGitData: (workspace) => this.warmWorkspaceGitDataForWorkspace(workspace),
        autoNameWorkspaceBranchForFirstAgent: (autoNameInput) =>
          this.workspaceAutoName.scheduleForWorktree(autoNameInput, {
            currentSelection: this.getFocusedAgentSelectionForCwd(autoNameInput.workspace.cwd),
          }),
        emitWorkspaceUpdateForWorkspaceId: (workspaceId) =>
          this.emitWorkspaceUpdateForWorkspaceId(workspaceId),
        cacheWorkspaceSetupSnapshot: (workspaceId, snapshot) => {
          this.workspaceSetupSnapshots.set(workspaceId, snapshot);
        },
        emit: (message) => this.emit(message),
        sessionLogger: this.sessionLogger,
        terminalManager: this.terminalManager,
        serviceProxy: this.serviceProxy,
        scriptRuntimeStore: this.scriptRuntimeStore,
        getDaemonTcpPort: this.getDaemonTcpPort,
        getDaemonTcpHost: this.getDaemonTcpHost,
        serviceProxyPublicBaseUrl: this.serviceProxyPublicBaseUrl,
        onScriptsChanged: (workspaceId, workspaceDirectory) => {
          this.workspaceScripts.emitStatusUpdate(workspaceId, workspaceDirectory);
        },
      },
      input,
      options,
    );
  }

  private async handleWorkspaceSetupStatusRequest(
    request: Extract<SessionInboundMessage, { type: "workspace_setup_status_request" }>,
  ): Promise<void> {
    return handleWorkspaceSetupStatusRequestMessage(
      {
        emit: (message) => this.emit(message),
        workspaceSetupSnapshots: this.workspaceSetupSnapshots,
      },
      request,
    );
  }

  private async handleArchiveWorkspaceRequest(
    request: Extract<SessionInboundMessage, { type: "archive_workspace_request" }>,
  ): Promise<void> {
    try {
      // Claim the archive queue before any await, so an undo sent right behind this request
      // queues after it and cancels it instead of running first.
      const outcome = await this.workspaceArchiveOperations.archive(
        request.workspaceId,
        async (signal) => {
          const existing = await this.workspaceRegistry.get(request.workspaceId);
          if (!existing) {
            throw new Error(`Workspace not found: ${request.workspaceId}`);
          }
          return archiveByScope(
            {
              jagentdeskHome: this.jagentdeskHome,
              jagentdeskWorktreesBaseRoot: this.worktreesRoot,
              github: this.github,
              workspaceGitService: this.workspaceGitService,
              agentManager: this.agentManager,
              agentStorage: this.agentStorage,
              findWorkspaceIdForCwd: (cwd) => this.findWorkspaceIdForCwd(cwd),
              listActiveWorkspaces: () => this.listActiveWorkspaceRefs(),
              archiveWorkspaceRecord: (workspaceId, archivedAt) =>
                this.archiveWorkspaceRecord(workspaceId, archivedAt),
              emitWorkspaceUpdatesForWorkspaceIds: this.publishWorkspaceArchiveUpdates,
              markWorkspaceArchiving: (workspaceIds, archivingAt) =>
                this.markWorkspaceArchiving(workspaceIds, archivingAt),
              clearWorkspaceArchiving: (workspaceIds) => this.clearWorkspaceArchiving(workspaceIds),
              killTerminalsForWorkspace: (workspaceId) =>
                this.terminalController.killTerminalsForWorkspace(workspaceId),
              sessionLogger: this.sessionLogger,
            },
            {
              scope: { kind: "workspace", workspaceId: existing.workspaceId },
              requestId: request.requestId,
              signal,
            },
          );
        },
      );

      if (outcome.kind === "canceled") {
        this.emit({
          type: "archive_workspace_response",
          payload: {
            requestId: request.requestId,
            workspaceId: request.workspaceId,
            archivedAt: null,
            error: "Workspace archive was undone",
            canceled: true,
          },
        });
        return;
      }

      const archivedWorkspace = await this.workspaceRegistry.get(request.workspaceId);
      const archivedAt = archivedWorkspace?.archivedAt ?? new Date().toISOString();
      this.emit({
        type: "archive_workspace_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          archivedAt,
          error: null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to archive workspace";
      this.sessionLogger.error(
        { err: error, workspaceId: request.workspaceId },
        "Failed to archive workspace",
      );
      this.emit({
        type: "archive_workspace_response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          archivedAt: null,
          error: message,
        },
      });
    }
  }

  private async handleWorkspaceArchiveUndoRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.archive.undo.request" }>,
  ): Promise<void> {
    try {
      await this.workspaceArchiveOperations.undo(request.workspaceId, (input) =>
        this.restoreArchivedWorkspaceAndAgents(request.workspaceId, input),
      );
      this.emit({
        type: "workspace.archive.undo.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.warn(
        { err: error, workspaceId: request.workspaceId, requestId: request.requestId },
        "session: workspace.archive.undo.request rejected",
      );
      this.emit({
        type: "workspace.archive.undo.response",
        payload: {
          requestId: request.requestId,
          workspaceId: request.workspaceId,
          accepted: false,
          error: getErrorMessageOr(error, "Failed to undo the workspace archive"),
        },
      });
    }
  }

  // Runs on the archive lane after any in-flight archive has stopped, so the record reflects how
  // far it got: still active when it was canceled early, archived (directory kept or removed)
  // otherwise.
  private async restoreArchivedWorkspaceAndAgents(
    workspaceId: string,
    input: WorkspaceArchiveUndoInput,
  ): Promise<void> {
    const workspace = await this.workspaceRegistry.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    if (workspace.archivedAt) {
      await this.workspaceRecovery.restore(workspaceId);
    } else if (input.archivedAt) {
      await this.workspaceProvisioning.ensureWorkspaceRecordUnarchived(workspace, input.archivedAt);
    }
    await this.publishRecoveredWorkspace(workspaceId);
  }

  private async handleWorkspaceClearAttentionRequest(
    request: Extract<SessionInboundMessage, { type: "workspace.clear_attention.request" }>,
  ): Promise<void> {
    const { requestId, workspaceId } = request;
    const requestedWorkspaceIds = Array.isArray(workspaceId) ? workspaceId : [workspaceId];
    let agents: AgentSnapshotPayload[];
    try {
      agents = await this.listAgentPayloads();
    } catch (error) {
      const message = getErrorMessage(error);
      const results = requestedWorkspaceIds.map((requestedWorkspaceId) => ({
        workspaceId: requestedWorkspaceId,
        clearedAgentIds: [],
        success: false,
        error: message,
      }));
      this.emit({
        type: "workspace.clear_attention.response",
        payload: {
          requestId,
          workspaceId,
          clearedAgentIds: [],
          results,
          success: false,
          error: message,
        },
      });
      return;
    }
    const results: Array<{
      workspaceId: string;
      clearedAgentIds: string[];
      success: boolean;
      error: string | null;
    }> = [];

    for (const requestedWorkspaceId of requestedWorkspaceIds) {
      const clearedAgentIds: string[] = [];
      try {
        const workspace = await this.workspaceRegistry.get(requestedWorkspaceId);
        if (!workspace || workspace.archivedAt) {
          throw new Error(`Workspace not found: ${requestedWorkspaceId}`);
        }

        // Clearing attention is scoped to the workspace that OWNS the agent, by
        // workspaceId — never by comparing cwd strings. A sibling workspace
        // sharing the same directory keeps its own agents' attention.
        const clearableAgentIds = agents
          .filter((agent) => !agent.archivedAt)
          .filter((agent) => agent.workspaceId === workspace.workspaceId)
          .filter((agent) => agent.requiresAttention === true)
          .filter((agent) => (agent.pendingPermissions?.length ?? 0) === 0)
          .filter((agent) => agent.attentionReason !== "permission")
          .map((agent) => agent.id);

        for (const agentId of clearableAgentIds) {
          const liveAgent = this.agentManager.getAgent(agentId);
          if (liveAgent) {
            await this.agentManager.clearAgentAttention(agentId);
            clearedAgentIds.push(agentId);
            continue;
          }

          const record = await this.agentStorage.get(agentId);
          if (
            !record ||
            record.internal ||
            record.archivedAt ||
            record.requiresAttention !== true
          ) {
            continue;
          }
          const nextRecord: StoredAgentRecord = {
            ...record,
            updatedAt: new Date().toISOString(),
            requiresAttention: false,
            attentionReason: null,
            attentionTimestamp: null,
          };
          await this.agentStorage.upsert(nextRecord);
          const agent = this.buildStoredAgentPayload(nextRecord);
          const project = await this.buildProjectPlacementForWorkspace(workspace);
          this.emit({
            type: "agent_update",
            payload: {
              kind: "upsert",
              agent,
              project,
            },
          });
          clearedAgentIds.push(agentId);
        }

        await this.emitWorkspaceUpdateForWorkspaceId(workspace.workspaceId);
        results.push({
          workspaceId: requestedWorkspaceId,
          clearedAgentIds,
          success: true,
          error: null,
        });
      } catch (error) {
        const message = getErrorMessage(error);
        this.sessionLogger.error(
          { err: error, workspaceId: requestedWorkspaceId },
          "Failed to clear workspace attention",
        );
        results.push({
          workspaceId: requestedWorkspaceId,
          clearedAgentIds,
          success: false,
          error: message,
        });
      }
    }

    const clearedAgentIds = results.flatMap((result) => result.clearedAgentIds);
    const failedResults = results.filter((result) => !result.success);
    this.emit({
      type: "workspace.clear_attention.response",
      payload: {
        requestId,
        workspaceId,
        clearedAgentIds,
        results,
        success: failedResults.length === 0,
        error:
          failedResults.length === 0
            ? null
            : failedResults
                .map((result) => result.error)
                .filter((error) => error !== null)
                .join("; "),
      },
    });
  }

  private async handleFetchAgent(agentIdOrIdentifier: string, requestId: string): Promise<void> {
    // An unknown agent is a null agent, not an error. Errors are for empty or ambiguous identifiers.
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.emit({
        type: "fetch_agent_response",
        payload: {
          requestId,
          agent: null,
          project: null,
          error: resolved.notFound ? null : resolved.error,
        },
      });
      return;
    }

    const agent = await this.getAgentPayloadById(resolved.agentId);
    if (!agent) {
      this.emit({
        type: "fetch_agent_response",
        payload: { requestId, agent: null, project: null, error: null },
      });
      return;
    }

    const project = agent.workspaceId
      ? await this.buildProjectPlacementForWorkspaceId(agent.workspaceId)
      : null;
    this.emit({
      type: "fetch_agent_response",
      payload: { requestId, agent, project, error: null },
    });
  }

  private async handleFetchAgentTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "fetch_agent_timeline_request" }>,
    source?: object,
  ): Promise<void> {
    const direction: AgentTimelineFetchDirection = msg.direction ?? (msg.cursor ? "after" : "tail");
    // ADR-0020: the daemon retains only projected items, so every fetch (including a legacy
    // `canonical` request) is answered with projected items.
    const projection = "projected" as const;
    const cursor: AgentTimelineCursor | undefined = msg.cursor
      ? {
          epoch: msg.cursor.epoch,
          seq: msg.cursor.seq,
        }
      : undefined;

    try {
      const snapshot = await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
        purpose: "history",
      });
      const agentPayload = await this.buildAgentPayload(snapshot);

      const fetchedControlTimeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction,
        cursor,
        limit: msg.limit,
      });
      const selectedTimeline = {
        timeline: fetchedControlTimeline,
        entries: fetchedControlTimeline.rows,
        startSeq: fetchedControlTimeline.startSeq,
        endSeq: fetchedControlTimeline.endSeq,
        hasOlder: fetchedControlTimeline.hasOlder,
        hasNewer: fetchedControlTimeline.hasNewer,
      };
      const startCursor =
        selectedTimeline.startSeq !== null
          ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.startSeq }
          : null;
      const endCursor =
        selectedTimeline.endSeq !== null
          ? { epoch: selectedTimeline.timeline.epoch, seq: selectedTimeline.endSeq }
          : null;

      this.emitForSource(
        {
          type: "fetch_agent_timeline_response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            agent: agentPayload,
            direction,
            projection,
            epoch: selectedTimeline.timeline.epoch,
            reset: fetchedControlTimeline.reset,
            staleCursor: fetchedControlTimeline.staleCursor,
            gap: fetchedControlTimeline.gap,
            window: selectedTimeline.timeline.window,
            startCursor,
            endCursor,
            hasOlder: selectedTimeline.hasOlder,
            hasNewer: selectedTimeline.hasNewer,
            ...(msg.mergeWindow === true ? { mergeWindow: true } : {}),
            entries: selectedTimeline.entries
              .filter((entry) => this.supportsTimelineItem(entry.item, source))
              .map((entry) => ({
                provider: snapshot.provider,
                item: entry.item,
                timestamp: entry.timestamp,
                turnId: entry.turnId,
                seqStart: entry.seqStart,
                seqEnd: entry.seqEnd,
                sourceSeqRanges: entry.sourceSeqRanges,
                turnMetrics: entry.turnMetrics,
                collapsed: (
                  source
                    ? this.supportsForSource(CLIENT_CAPS.reasoningMergeEnum, source)
                    : this.supports(CLIENT_CAPS.reasoningMergeEnum)
                )
                  ? entry.collapsed
                  : entry.collapsed.filter((value) => value !== "reasoning_merge"),
              })),
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle fetch_agent_timeline_request",
      );
      this.emitForSource(
        {
          type: "fetch_agent_timeline_response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            agent: null,
            direction,
            projection,
            epoch: "",
            reset: false,
            staleCursor: false,
            gap: false,
            window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
            startCursor: null,
            endCursor: null,
            hasOlder: false,
            hasNewer: false,
            ...(msg.mergeWindow === true ? { mergeWindow: true } : {}),
            entries: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleAgentTimelineAppendRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.append.request" }>,
  ): Promise<void> {
    const pluginId = parsePluginClientId(this.clientId);
    if (!pluginId) throw new Error("Only plugin sessions can append plugin timeline items");
    assertPluginTimelineKind(msg.item.kind);
    assertPluginTimelineDataSize(msg.item.data);
    const { seq, epoch } = await this.agentManager.appendTimelineItem(msg.agentId, {
      ...msg.item,
      pluginId,
    });
    this.emit({
      type: "agent.timeline.append.response",
      payload: { requestId: msg.requestId, seq, epoch },
    });
  }

  private async handleAgentTimelineListPromptsRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.list_prompts.request" }>,
    source?: object,
  ): Promise<void> {
    try {
      await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const rows = await this.agentManager.getTimelineRows(msg.agentId);
      const timeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction: "tail",
        limit: 1,
      });
      const index = buildTimelinePromptIndex(timeline.epoch, rows);
      this.emitForSource(
        {
          type: "agent.timeline.list_prompts.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            ...index,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle agent.timeline.list_prompts.request",
      );
      this.emitForSource(
        {
          type: "agent.timeline.list_prompts.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            epoch: "",
            prompts: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  // Chat Find (0.9.0): search the agent's whole timeline server-side. Recheck the epoch after the
  // (possibly long) scan so results computed against a since-changed history are rejected.
  private async handleAgentTimelineSearchRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.timeline.search.request" }>,
    source?: object,
  ): Promise<void> {
    try {
      await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const rows = await this.agentManager.getTimelineRows(msg.agentId);
      const { epoch } = this.agentManager.fetchTimeline(msg.agentId, {
        direction: "tail",
        limit: 1,
      });
      const result = await searchTimeline({ rows, query: msg.query, cursor: msg.cursor });
      if (
        this.agentManager.fetchTimeline(msg.agentId, { direction: "tail", limit: 1 }).epoch !==
        epoch
      ) {
        throw new Error("History changed; search again");
      }
      this.emitForSource(
        {
          type: "agent.timeline.search.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            epoch,
            ...result,
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.timeline.search.response",
          payload: {
            requestId: msg.requestId,
            agentId: msg.agentId,
            epoch: "",
            locations: [],
            nextCursor: null,
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleProviderSubagentListRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.provider_subagents.list.request" }>,
  ): Promise<void> {
    try {
      await ensureUnarchivedAgentLoaded(msg.parentAgentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      this.emit({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: msg.requestId,
          parentAgentId: msg.parentAgentId,
          subagents: this.agentManager.listProviderSubagents(msg.parentAgentId),
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "agent.provider_subagents.list.response",
        payload: {
          requestId: msg.requestId,
          parentAgentId: msg.parentAgentId,
          subagents: [],
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async handleAgentBackgroundWorkStopRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.background_work.stop.request" }>,
  ): Promise<void> {
    let error: string | null = null;
    try {
      const target = await this.resolveBackgroundWorkAgent(msg.agentId);
      if ("error" in target) throw new Error(target.error);
      await this.agentManager.stopAgentBackgroundWork({
        agentId: msg.agentId,
        itemId: msg.itemId,
        stopToken: msg.stopToken,
        canManageAutomation: isSessionRpcAllowed(this.scopes, "schedule/delete"),
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    this.emit({
      type: "agent.background_work.stop.response",
      payload: {
        requestId: msg.requestId,
        agentId: msg.agentId,
        itemId: msg.itemId,
        error,
      },
    });
  }

  private async handleAgentBackgroundWorkListRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.background_work.list.request" }>,
  ): Promise<void> {
    try {
      this.emit({
        type: "agent.background_work.list.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          items: await this.readAgentBackgroundWork(msg.agentId),
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "agent.background_work.list.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          items: [],
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async readAgentBackgroundWork(agentId: string): Promise<AgentBackgroundWorkItem[]> {
    const target = await this.resolveBackgroundWorkAgent(agentId);
    if ("error" in target) throw new Error(target.error);
    if (!this.agentManager.getAgentBackgroundWorkSummary(agentId)) {
      throw new Error("Background work inventory is unavailable");
    }
    return this.projectBackgroundWorkItems(this.agentManager.listAgentBackgroundWork(agentId));
  }

  private async resolveBackgroundWorkAgent(
    agentId: string,
  ): Promise<{ agent: ManagedAgent | null; record: StoredAgentRecord | null } | { error: string }> {
    const record = await this.agentStorage.get(agentId);
    const agent = this.agentManager.getAgent(agentId);
    if ((!agent && !record) || agent?.internal || record?.internal) {
      return { error: `Unknown agent '${agentId}'` };
    }
    if (record?.archivedAt) {
      return { error: `Agent is archived: ${agentId}` };
    }
    return { agent, record };
  }

  private async handleProviderSubagentTimelineRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.provider_subagents.timeline.get.request" }>,
    source?: object,
  ): Promise<void> {
    const direction: AgentTimelineFetchDirection = msg.direction ?? (msg.cursor ? "after" : "tail");
    try {
      await ensureUnarchivedAgentLoaded(msg.parentAgentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const descriptor = this.agentManager.getProviderSubagent(msg.parentAgentId, msg.subagentId);
      if (!descriptor) {
        throw new Error("Provider subagent not found");
      }
      // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove after 2027-03-14.
      const supportsProjection = source
        ? this.supportsForSource(CLIENT_CAPS.projectedSubagentTimeline, source)
        : this.supports(CLIENT_CAPS.projectedSubagentTimeline);
      const timeline = this.agentManager.fetchProviderSubagentTimeline(
        msg.parentAgentId,
        msg.subagentId,
        {
          direction,
          cursor: msg.cursor,
          limit: msg.limit ?? (direction === "after" ? 0 : 200),
        },
      );
      this.emitForSource(
        {
          type: "agent.provider_subagents.timeline.get.response",
          payload: {
            requestId: msg.requestId,
            parentAgentId: msg.parentAgentId,
            subagentId: msg.subagentId,
            provider: descriptor.provider,
            direction,
            epoch: timeline.epoch,
            projection: "projected",
            startCursor:
              timeline.startSeq === null ? null : { epoch: timeline.epoch, seq: timeline.startSeq },
            endCursor:
              timeline.endSeq === null ? null : { epoch: timeline.epoch, seq: timeline.endSeq },
            reset: timeline.reset,
            staleCursor: timeline.staleCursor,
            gap: timeline.gap,
            window: timeline.window,
            hasOlder: supportsProjection && timeline.hasOlder,
            hasNewer: supportsProjection && timeline.hasNewer,
            rows: supportsProjection
              ? timeline.rows
                  .filter((row) => this.supportsTimelineItem(row.item, source))
                  .map((row) => ({
                    item: row.item,
                    timestamp: row.timestamp,
                    seq: row.seqEnd,
                    seqStart: row.seqStart,
                    seqEnd: row.seqEnd,
                    sourceSeqRanges: row.sourceSeqRanges,
                  }))
              : [
                  {
                    seq: timeline.window.maxSeq,
                    timestamp: new Date().toISOString(),
                    item: {
                      type: "assistant_message",
                      text: "Please upgrade the JAgentDesk app to view this subagent conversation.",
                    },
                  },
                ],
            error: null,
          },
        },
        source,
      );
    } catch (error) {
      this.emitForSource(
        {
          type: "agent.provider_subagents.timeline.get.response",
          payload: {
            requestId: msg.requestId,
            parentAgentId: msg.parentAgentId,
            subagentId: msg.subagentId,
            provider: null,
            direction,
            epoch: "",
            reset: false,
            staleCursor: false,
            gap: false,
            window: { minSeq: 0, maxSeq: 0, nextSeq: 0 },
            hasOlder: false,
            hasNewer: false,
            rows: [],
            error: error instanceof Error ? error.message : String(error),
          },
        },
        source,
      );
    }
  }

  private async handleAgentForkContextRequest(
    msg: Extract<SessionInboundMessage, { type: "agent.fork_context.request" }>,
  ): Promise<void> {
    try {
      const snapshot = await ensureAgentLoaded(msg.agentId, {
        agentManager: this.agentManager,
        agentStorage: this.agentStorage,
        logger: this.sessionLogger,
      });
      const agentPayload = await this.buildAgentPayload(snapshot);
      const timeline = this.agentManager.fetchTimeline(msg.agentId, {
        direction: "tail",
        limit: 0,
      });
      const forkContext = buildAgentForkContextAttachment({
        rows: timeline.rows,
        cursorBoundary: msg.boundaryCursor
          ? { timelineEpoch: timeline.epoch, cursor: msg.boundaryCursor }
          : null,
        boundaryMessageId: msg.boundaryMessageId,
        agentTitle: agentPayload.title,
        cwd: snapshot.cwd,
      });

      this.emit({
        type: "agent.fork_context.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          attachment: forkContext.attachment,
          itemCount: forkContext.itemCount,
          boundaryCursor: forkContext.boundaryCursor,
          boundaryMessageId: forkContext.boundaryMessageId,
          error: null,
        },
      });
    } catch (error) {
      this.sessionLogger.error(
        { err: error, agentId: msg.agentId },
        "Failed to handle agent.fork_context.request",
      );
      this.emit({
        type: "agent.fork_context.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          attachment: null,
          itemCount: 0,
          boundaryCursor: msg.boundaryCursor ?? null,
          boundaryMessageId: msg.boundaryMessageId ?? null,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private messageSkillIds(
    skillIds: string[] | undefined,
    specPhase: boolean,
  ): string[] | undefined {
    if (
      specPhase ||
      (this.pluginRuntime?.builtin && !this.pluginRuntime.builtin.isEnabled("skills"))
    )
      return undefined;
    return skillIds;
  }

  private queueAgentMessage(
    msg: Extract<SessionInboundMessage, { type: "send_agent_message_request" }>,
    agentId: string,
    prompt: AgentPromptInput,
  ): boolean {
    if (msg.sourceAgentId && !msg.skillIds?.length) {
      const receipt = enqueueAgentMessage(
        {
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          logger: this.sessionLogger,
        },
        {
          recipientId: agentId,
          prompt,
          messageId: msg.messageId,
          source: { kind: "agent-message", agentId: msg.sourceAgentId },
          activeTurnBehavior: msg.activeTurnBehavior ?? "steer",
          clearPendingPermissions: false,
        },
      );
      receipt.dispatched.catch((error) => {
        this.handleAgentRunError(agentId, error, "Failed to send agent message");
      });
      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId,
          accepted: true,
          error: null,
          deliveryStatus: receipt.status,
          messageId: receipt.messageId,
        },
      });
      return true;
    }
    return false;
  }

  private async handleSendAgentMessageRequest(
    msg: Extract<SessionInboundMessage, { type: "send_agent_message_request" }>,
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(msg.agentId);
    if (!resolved.ok) {
      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          accepted: false,
          error: resolved.error,
        },
      });
      return;
    }

    try {
      const agentId = resolved.agentId;

      // Spec mode (spec 28.4 step 2): the message becomes the pending phase's spec-kit command.
      // The command must lead the turn, so attached skills are not prefixed to it.
      const specPhase =
        this.pluginRuntime?.builtin && !this.pluginRuntime.builtin.isEnabled("spec-mode")
          ? undefined
          : await this.specMode?.service.prepareUserMessage(agentId, msg.text);
      const prompt = buildAgentPrompt(specPhase?.text ?? msg.text, msg.images, msg.attachments);
      this.sessionLogger.trace(
        {
          agentId,
          messageId: msg.messageId,
          textPrefix: msg.text.slice(0, 80),
        },
        "agent.session.send_agent_message",
      );
      if (this.queueAgentMessage(msg, agentId, prompt)) return;

      let dispatchResult: PromptDispatchResult;
      try {
        dispatchResult = await sendPromptToAgent({
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          agentId,
          prompt,
          messageId: msg.messageId,
          source: msg.sourceAgentId
            ? { kind: "agent-message", agentId: msg.sourceAgentId }
            : undefined,
          activeTurnBehavior: msg.activeTurnBehavior,
          skillIds: this.messageSkillIds(msg.skillIds, Boolean(specPhase)),
          skillInvocation: this.skillsStorage,
          logger: this.sessionLogger,
        });
      } catch (error) {
        if (specPhase) await this.specMode?.service.revertPhaseStart(agentId, specPhase.phase);
        const message = error instanceof Error ? error.message : String(error);
        this.handleAgentRunError(agentId, error, "Failed to send agent message");
        this.emit({
          type: "send_agent_message_response",
          payload: {
            requestId: msg.requestId,
            agentId,
            accepted: false,
            error: message,
          },
        });
        return;
      }

      // A steered message was injected into the already-running turn — there is
      // no new run to wait for, so ack immediately (like an out-of-band prompt).
      if (dispatchResult.disposition !== "turn_started") {
        this.emit({
          type: "send_agent_message_response",
          payload: {
            requestId: msg.requestId,
            agentId,
            accepted: true,
            error: null,
          },
        });
        return;
      }

      try {
        await waitForAgentRunStartWithTimeout(this.agentManager, agentId, dispatchResult.started);
      } catch (error) {
        this.emit({
          type: "send_agent_message_response",
          payload: {
            requestId: msg.requestId,
            agentId,
            accepted: false,
            error: errorToFriendlyMessage(error),
          },
        });
        return;
      }

      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId,
          accepted: true,
          error: null,
        },
      });
    } catch (error) {
      this.emit({
        type: "send_agent_message_response",
        payload: {
          requestId: msg.requestId,
          agentId: resolved.agentId,
          accepted: false,
          error: errorToFriendlyMessage(error),
        },
      });
    }
  }

  private async handleWaitForFinish(
    agentIdOrIdentifier: string,
    requestId: string,
    timeoutMs?: number,
  ): Promise<void> {
    const resolved = await this.resolveAgentIdentifier(agentIdOrIdentifier);
    if (!resolved.ok) {
      this.emit({
        type: "wait_for_finish_response",
        payload: {
          requestId,
          status: "error",
          final: null,
          error: resolved.error,
          lastMessage: null,
        },
      });
      return;
    }

    const agentId = resolved.agentId;
    const live = this.agentManager.getAgent(agentId);
    if (!live) {
      const record = await this.agentStorage.get(agentId);
      if (!record || record.internal) {
        this.emit({
          type: "wait_for_finish_response",
          payload: {
            requestId,
            status: "error",
            final: null,
            error: `Agent not found: ${agentId}`,
            lastMessage: null,
          },
        });
        return;
      }
      const final = this.buildStoredAgentPayload(record);
      let status: "permission" | "error" | "idle";
      if (record.attentionReason === "permission") {
        status = "permission";
      } else if (record.lastStatus === "error") {
        status = "error";
      } else {
        status = "idle";
      }
      const error = resolveWaitForFinishError({ status, final });
      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status, final, error, lastMessage: null },
      });
      return;
    }

    const abortController = new AbortController();
    const hasTimeout = typeof timeoutMs === "number" && timeoutMs > 0;
    const timeoutHandle = hasTimeout
      ? setTimeout(() => {
          abortController.abort("timeout");
        }, timeoutMs)
      : null;

    try {
      // A CLI `send` from an agent is queued; wait for its dispatch before the turn.
      await waitForAgentMessageDispatch(this.agentManager, agentId, abortController.signal).catch(
        () => undefined,
      );
      let result = await this.agentManager.waitForAgentEvent(agentId, {
        signal: abortController.signal,
        waitForActive: true,
      });
      let final = await this.getAgentPayloadById(agentId);
      if (!final) {
        throw new Error(`Agent ${agentId} disappeared while waiting`);
      }

      let status: "permission" | "error" | "idle";
      if (result.permission) {
        status = "permission";
      } else if (result.status === "error") {
        status = "error";
      } else {
        status = "idle";
      }
      const error = resolveWaitForFinishError({ status, final });

      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status, final, error, lastMessage: result.lastMessage },
      });
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" || error.message.toLowerCase().includes("aborted"));
      if (!isAbort) {
        const message = errorToFriendlyMessage(error);
        this.sessionLogger.error({ err: error, agentId }, "wait_for_finish_request failed");
        const final = await this.getAgentPayloadById(agentId);
        this.emit({
          type: "wait_for_finish_response",
          payload: {
            requestId,
            status: "error",
            final,
            error: message,
            lastMessage: null,
          },
        });
        return;
      }

      const final = await this.getAgentPayloadById(agentId);
      if (!final) {
        throw new Error(`Agent ${agentId} disappeared while waiting`, { cause: error });
      }
      this.emit({
        type: "wait_for_finish_response",
        payload: { requestId, status: "timeout", final, error: null, lastMessage: null },
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Emit a message to the client
   */
  wantsEvent(event: string, source?: object): boolean {
    const capabilities = source
      ? this.clientCapabilitiesBySource.get(source)
      : this.clientCapabilities;
    if (!capabilities?.has(CLIENT_CAPS.explicitEventSubscriptions))
      return event !== "agent.background_work.update";
    return [...this.eventSubscriptions.values()].some(
      ({ owner, events }) =>
        (!source || owner.source === source) && events.has(event as SessionEventSubscription),
    );
  }

  private emit(msg: SessionOutboundMessage): void {
    const event = msg.type === "status" ? `status.${msg.payload.status}` : msg.type;
    if (
      SessionEventSubscriptionSchema.safeParse(event).success &&
      !("payload" in msg && "requestId" in msg.payload && typeof msg.payload.requestId === "string")
    ) {
      if (this.clientCapabilitiesBySource.size > 0 && this.onMessageToSource) {
        for (const [source] of this.clientCapabilitiesBySource) {
          if (
            this.wantsEvent(event, source) &&
            isSessionRpcAllowed(this.scopes, msg.type) &&
            !(this.guestAgentId !== null && this.guestMessageTouchesOtherAgent(msg))
          )
            this.onMessageToSource(source, msg);
        }
        return;
      }
      if (!this.wantsEvent(event)) return;
    }
    if (msg.type !== "rpc_error" && !isSessionRpcAllowed(this.scopes, msg.type)) {
      return;
    }
    // Guest sessions never receive another agent's data, even via broadcast (ADR-0019).
    if (this.guestAgentId !== null && this.guestMessageTouchesOtherAgent(msg)) {
      return;
    }
    // JSON.stringify(msg) is only computed when trace is enabled — it runs for
    // every outbound message otherwise, and trace is disabled by default.
    // Optional-chained because test logger stubs don't implement isLevelEnabled.
    if (this.sessionLogger.isLevelEnabled?.("trace")) {
      this.sessionLogger.trace(
        {
          messageType: msg.type,
          payloadBytes: JSON.stringify(msg).length,
        },
        "agent.session.outbound",
      );
    }
    this.onMessage(msg);
  }

  private emitBinary(frame: Uint8Array): void {
    if (!this.onBinaryMessage) {
      return;
    }
    try {
      this.onBinaryMessage(frame);
    } catch (error) {
      this.sessionLogger.error({ err: error }, "Failed to emit binary frame");
    }
  }

  private async emitBinaryReply(frame: Uint8Array, source?: object): Promise<void> {
    if (source && this.onBinaryMessageToSource) {
      await this.onBinaryMessageToSource(source, frame);
      return;
    }
    this.emitBinary(frame);
  }

  private emitForSource(msg: SessionOutboundMessage, source?: object): void {
    if (source && this.onMessageToSource) {
      this.onMessageToSource(source, msg);
      return;
    }
    this.emit(msg);
  }

  /**
   * Clean up session resources
   */
  public async cleanup(): Promise<void> {
    this.sessionLogger.trace({}, "agent.session.lifecycle.cleanup");
    this.isCleanedUp = true;
    await this.delivery.close();

    if (this.unsubscribeAgentEvents) {
      this.unsubscribeAgentEvents();
      this.unsubscribeAgentEvents = null;
    }
    this.unsubscribeProjectMutations?.();
    this.unsubscribeProjectMutations = null;
    this.unsubscribeWorkspaceMutations?.();
    this.unsubscribeWorkspaceMutations = null;
    this.unsubscribePluginChanges?.();
    this.unsubscribePluginChanges = null;
    this.agentUpdates.dispose();
    this.activityGraphSession?.dispose();
    await this.hubExecutionController?.cleanup();
    if (this.unsubscribeTerminalWorkspaceContributionEvents) {
      this.unsubscribeTerminalWorkspaceContributionEvents();
      this.unsubscribeTerminalWorkspaceContributionEvents = null;
    }
    this.providerCatalogSession.dispose();

    await this.voiceSession.cleanup();

    this.botsSession?.dispose();
    this.jiraSession?.dispose();
    this.figmaSession?.dispose();
    this.dockerStreams.disposeAll();
    disposeRemoteDocker({ service: this.dockerService, streams: this.dockerStreams });
    for (const routed of this.remoteDockerSubscriptions.values()) routed.release();
    this.remoteDockerSubscriptions.clear();
    this.simulatorStreams.disposeAll();
    this.physicalDeviceSession?.dispose();
    for (const id of this.proxySubscriptionIds) this.proxyService.unsubscribe(id);
    this.proxySubscriptionIds.clear();
    this.terminalController.dispose();
    for (const controller of this.terminalStreamControllers.values()) controller.dispose();
    this.terminalStreamControllers.clear();

    this.checkoutSession.cleanup();

    this.workspaceGitObserver.dispose();
    this.workspaceFilesSession.dispose();
    this.clusterSession.dispose();
    this.argocdSession.dispose();
  }
}

interface CloneRepositoryInput {
  name: string;
  displayName: string;
  cloneUrl: string;
}

function normalizeCloneRepository(input: {
  repo: string;
  cloneProtocol?: "https" | "ssh";
}): CloneRepositoryInput {
  const trimmed = input.repo.trim();
  if (!trimmed) {
    throw new Error("Repository is required");
  }

  const remote = parseGitRemoteLocation(trimmed);
  if (remote) {
    const segments = remote.path.split("/").filter(Boolean);
    const name = segments.at(-1);
    if (!name || !isValidGitHubRepoSegment(name)) {
      throw new Error("Repository name contains invalid characters");
    }
    return { name, displayName: remote.path, cloneUrl: trimmed };
  }

  const [owner, rawName, ...extra] = trimmed.split("/");
  if (!owner || !rawName || extra.length > 0) {
    throw new Error("Repository must use owner/repo format or a git remote URL");
  }
  const name = rawName.endsWith(".git") ? rawName.slice(0, -4) : rawName;
  if (!isValidGitHubRepoSegment(owner) || !isValidGitHubRepoSegment(name)) {
    throw new Error("Repository contains invalid characters");
  }
  if (!input.cloneProtocol) {
    throw new Error("Clone protocol is required for owner/repo repository names");
  }
  const cloneUrl =
    input.cloneProtocol === "ssh"
      ? `git@github.com:${owner}/${name}.git`
      : `https://github.com/${owner}/${name}.git`;
  return {
    name,
    displayName: `${owner}/${name}`,
    cloneUrl,
  };
}

function isValidGitHubRepoSegment(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(value);
}

function createPluginUsageRuntime(
  runtime: SessionOptions["pluginRuntime"],
): UsageSessionOptions["runtime"] {
  if (!runtime?.listUsageReports || !runtime.listLegacyUsage) return undefined;
  return {
    listUsageReports: runtime.listUsageReports.bind(runtime),
    listLegacyUsage: runtime.listLegacyUsage.bind(runtime),
  };
}

function dedupeSlashCommands<T extends { name: string }>(commands: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const command of commands) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    unique.push(command);
  }
  return unique;
}
