import { type RuntimeCleanupCandidate } from "./idle-runtime-cleanup/index.js";
import { type ProviderJAgentDeskToolsPolicy } from "@jagentdesk/protocol/provider-config";
import { isJAgentDeskToolPolicyEnabled } from "./jagentdesk-tool-policy.js";
import type { AttachedAgentTool, PluginAgentToolsRuntime } from "../plugins/agent-tools.js";
import type { AgentToolResult } from "@jagentdesk/plugin/server";
import { TimelineProjection } from "./timeline-projection.js";
import type { PluginLifecycle } from "../plugins/lifecycle/index.js";
import { describeHookAgent, publishAgentStream } from "../plugins/lifecycle/index.js";
import type { PluginSessionOpenRequest } from "@jagentdesk/plugin/server";
import { ensureAgentLoaded, AgentNotFoundError } from "./agent-loading.js";
import { randomUUID } from "node:crypto";
import { AgentTurnChangedError } from "./agent-prompt.js";
import { continuesAssistantMessage, projectTimelineRows } from "./timeline-projection.js";
import { isDefaultAgentCreateConfigUnattended } from "./create-agent-mode.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import { basename, resolve } from "node:path";
import { stat } from "node:fs/promises";
import {
  AGENT_LIFECYCLE_STATUSES,
  type AgentLifecycleStatus,
} from "@jagentdesk/protocol/agent-lifecycle";
import {
  getParentAgentIdFromLabels,
  hasOpenAgentTab,
  isDelegatedAgent,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
} from "@jagentdesk/protocol/agent-labels";
import { type Logger } from "pino";
import {
  type ToolPolicy,
  type AgentUsageTotals,
  type JsonValue,
  type ProviderOptions,
} from "@jagentdesk/protocol/agent-types";
import { z } from "zod";
import { type TerminalManager } from "../../terminal/terminal-manager.js";
import {
  AgentTurnStartCanceledError,
  getAgentStreamEventTurnId,
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentCreateSessionOptions,
  type AgentResumePurpose,
  type AgentResumeSessionOptions,
  type AgentLaunchContext,
  type AgentSlashCommand,
  type AgentMode,
  type AgentPermissionRequest,
  type AgentPermissionAction,
  type AgentPermissionResponse,
  type AgentPermissionResult,
  type AgentPersistenceHandle,
  type AgentProviderNotice,
  type AgentPromptInput,
  type AgentProvider,
  type AgentRunOptions,
  type AgentSteerOptions,
  type AgentRunResult,
  type AgentSession,
  type AgentSessionConfig,
  type SteerResult,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type AgentMetric,
  type AgentUsage,
  type AgentRuntimeInfo,
  type ImportedTimelineEntry,
  type ImportableProviderSession,
  type ListImportableSessionsOptions,
  type AgentDraftControls,
  type AgentOptionControl,
} from "./agent-sdk-types.js";
import { buildArchivedAgentRecord, type ArchivedStoredAgentRecord } from "./agent-archive.js";
import type { StoredProviderSession } from "./agent-storage.js";
import { SessionLedgerStore } from "./session-ledger/ledger-store.js";
import { composeSystemPromptParts } from "./system-prompt.js";
import {
  SESSION_LEDGER_INSTRUCTION,
  SessionContinuity,
} from "./session-ledger/session-continuity.js";
import { handoffBudgetTokens } from "./session-ledger/ledger-render.js";
import { DurableContext } from "./durable-context/durable-context.js";
import { agentIdentityInstruction, LESSON_INSTRUCTION } from "./durable-context/instructions.js";
import { agentShimEnv } from "../agent-browser-shim/install.js";
import type { DurableContextSettings, MemoryPort } from "./memory-port.js";
import type { LedgerTimelineRow } from "./session-ledger/ledger-builder.js";
import type { LedgerMergeResult } from "./session-ledger/ledger-merge.js";
import type {
  HandoffReason,
  LedgerCompaction,
  LedgerHandoffRecord,
  LedgerNote,
  LedgerOpenItem,
  LedgerRegrounding,
  SessionLedgerUpdateInput,
} from "./session-ledger/ledger-schema.js";
import { getAgentProviderDefinition } from "@jagentdesk/protocol/provider-manifest";
import { FailoverCoordinator } from "./failover/failover-coordinator.js";
import {
  checkChildProvider,
  rankChildProviders,
  type ChildProviderEntry,
} from "./failover/child-provider-policy.js";
import type { ProviderQuota } from "./failover/provider-quota.js";
import {
  CROSS_PROVIDER_CHILDREN_DISABLED,
  FAILOVER_DISABLED,
  type AgentContinuityOverrides,
  type CrossProviderChildrenConfig,
  type FailoverConfig,
  type ProviderModelRef,
} from "./failover/failover-policy.js";

import { sanitizeAgentMetrics, withModelMetric } from "./agent-metrics.js";
import type { StoredAgentRecord, AgentStorage } from "./agent-storage.js";
import type { AgentOwner } from "./agent-owner.js";
import {
  InMemoryAgentTimelineStore,
  type SeedAgentTimelineOptions,
} from "./agent-timeline-store.js";
import type {
  AgentTimelineSnapshotCapture,
  AgentTimelineSnapshots,
  StoredAgentTimelineSnapshot,
} from "./agent-timeline-snapshots.js";
import {
  type AgentTimelineFetchOptions,
  type AgentTimelineFetchResult,
  type AgentTimelineRow,
  type AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import {
  AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
  AgentStreamCoalescer,
} from "./agent-stream-coalescer.js";
import { limitAgentTimelineItemContent } from "./agent-timeline-content.js";
import {
  AgentRunState,
  type ForegroundPromptStart,
  type ForegroundTurnWaiter,
  type PendingForegroundRun,
} from "./agent-run-state.js";
import { invokeRewindCapability, type RewindMode } from "./rewind/rewind.js";
import { projectAgentMessages } from "./agent-messages/index.js";
import {
  JAGENTDESK_MCP_SERVER_NAME,
  stripInternalJAgentDeskMcpServer,
  withRuntimeJAgentDeskMcpServer,
} from "./runtime-mcp-config.js";
import { resolveCreateAgentTitles } from "./create-agent-title.js";
import { type JAgentDeskToolCatalogFactory } from "./tools/types.js";
import {
  diffHostToolSets,
  hostToolSetSignature,
  type HostToolSetDiff,
  type HostToolSetSource,
} from "./host-tool-set.js";
import {
  ProviderSubagentStore,
  type ProviderSubagentDescriptor,
  type ProviderSubagentStoreEvent,
} from "./provider-subagents/store.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import {
  AgentBackgroundWorkStore,
  isDaemonBackgroundWorkItem,
  type AgentBackgroundWorkItem,
  type DaemonBackgroundWorkInput,
  type DaemonBackgroundWorkKey,
} from "./background-work/index.js";
import { BackgroundWorkTimeline } from "./background-work/timeline.js";
import { extractAttention, buildSessionConfig } from "../persistence-hooks.js";
import { ProviderOptionsValidationError } from "./provider-options.js";
import { PermissionNotPendingError } from "./permission-not-pending-error.js";
import { applyRecordPatch } from "../record-patch.js";
import {
  applyProviderOptionsPatch,
  exposeFeatureValuesToHook,
  convertLegacyOptions,
  MalformedLegacyOptionError,
  resolveAdapter,
  foldHookFeatureValues,
  type ProviderOptionsPatch,
} from "./option-controls.js";

const RELOAD_SESSION_CLOSE_TIMEOUT_MS = 3_000;

const INTERRUPT_SESSION_TIMEOUT_MS = 2_000;
const IMPORTABLE_SESSION_LIST_TIMEOUT_MS = 90_000;

const STORED_AGENT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

type TimeoutResult = "completed" | "timed_out";

function submittedPromptText(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  return prompt
    .flatMap((block) => (block.type === "text" && !("mimeType" in block) ? [block.text] : []))
    .join("\n")
    .trim();
}

/** The provider has no native fork; the caller seeds a new agent instead (spec 41 §6). */
export class NativeForkUnavailableError extends Error {
  readonly code = "native_fork_unavailable";
  constructor(readonly provider: string) {
    super(`${provider} agents cannot be forked natively`);
    this.name = "NativeForkUnavailableError";
  }
}

/** Where a fork's history comes from; the fork's timeline shows these parent rows by reference. */
export interface AgentForkOrigin {
  parentAgentId: string;
  parentTitle: string | null;
  provider: string;
  /** The parent's timeline position the fork ends at; null for the whole conversation. */
  boundary: { epoch: string; seq: number } | null;
}

export const FORK_ORIGIN_PLUGIN_ID = "jagentdesk";
export const FORK_ORIGIN_ITEM_KIND = "fork-origin";

const JAGENTDESK_TOOLS_CHECK_TIMEOUT_MS = 20_000;

function hostHintsSignature(instructions: readonly string[], hidden: readonly string[]): string {
  return JSON.stringify({ instructions, hidden });
}

export class AgentManagerShuttingDownError extends Error {
  constructor() {
    super("Agent manager is shutting down");
    this.name = "AgentManagerShuttingDownError";
  }
}

type RunCancellationCause = "reload" | "replace" | "rewind" | "stop";

export class AgentRunCancellationError extends Error {
  constructor(agentId: string, action: RunCancellationCause) {
    super(
      `Cannot ${action} agent ${agentId} because its active run cancellation was not acknowledged`,
    );
    this.name = "AgentRunCancellationError";
  }
}

export type AgentRunCancellationResult =
  | { status: "not_running" }
  | { status: "settled" }
  | { status: "refused" };

interface StopAgentBackgroundWorkOptions {
  agentId: string;
  itemId: string;
  stopToken: string;
  canManageAutomation?: boolean;
}

/**
 * A restored or retained timeline is already held, so the session's history is never streamed.
 * Whatever the session reads later to index turns must not stay in memory.
 */
function discardHeldHistoryReplay(agent: ActiveManagedAgent, restoring: boolean): void {
  if (agent.historyPrimed && restoring) agent.session.discardHistoryReplay?.();
}

async function resolveResumePurpose(
  record: StoredAgentRecord | null,
  requested: AgentResumePurpose | undefined,
  cwd: string,
): Promise<AgentResumePurpose> {
  if (!record) return requested ?? "interactive";
  if (record.archivedAt) return "history";
  if (requested !== "history") return "interactive";
  try {
    await stat(cwd);
    return "interactive";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "history";
    throw error;
  }
}

interface PreparedSessionConfig {
  storedConfig: AgentSessionConfig;
  launchConfig: AgentSessionConfig;
}

/** A session that will run in a directory needs that directory to be there. */
async function assertUsableWorkingDirectory(cwd: string): Promise<void> {
  try {
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: ${cwd}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new Error(`Working directory does not exist: ${cwd}`, { cause: error });
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Failed to access working directory: ${cwd}`, { cause: error });
  }
}

interface NormalizeConfigOptions {
  resolveDefaultModel?: boolean;
  env?: Record<string, string>;
  /** Defaults to interactive. A history load reads persisted state and runs nothing. */
  purpose?: AgentResumePurpose;
}

interface TimeoutOptions {
  operation: Promise<void>;
  timeoutMs: number;
  onLateError?: (error: unknown) => void;
}

function formatProviderList(providers: readonly string[]): string {
  return providers.length > 0 ? providers.join(", ") : "none";
}

function buildStoredAgentConfig(record: StoredAgentRecord): AgentSessionConfig {
  const config: AgentSessionConfig = {
    provider: record.provider,
    cwd: record.cwd,
  };
  // lastModeId is the last live mode — it also covers provider-side switches
  // that never reach record.config.modeId.
  const modeId = record.lastModeId ?? record.config?.modeId;
  if (modeId != null) config.modeId = modeId;
  if (!record.config) {
    return config;
  }
  if (record.config.model != null) config.model = record.config.model;
  if (record.config.thinkingOptionId != null) {
    config.thinkingOptionId = record.config.thinkingOptionId;
  }
  if (record.config.providerOptions != null) {
    config.providerOptions = record.config.providerOptions;
  }
  if (record.config.toolPolicy != null) config.toolPolicy = record.config.toolPolicy;
  if (record.config.extra != null) config.extra = record.config.extra;
  if (record.config.systemPrompt != null) {
    config.systemPrompt = record.config.systemPrompt;
  }
  if (record.config.mcpServers != null) config.mcpServers = record.config.mcpServers;
  return stripInternalJAgentDeskMcpServer(config);
}

export { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus };

export type {
  AgentTimelineCursor,
  AgentTimelineFetchDirection,
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineWindow,
} from "./agent-timeline-store-types.js";

export type AgentManagerEvent =
  | { type: "agent_state"; agent: ManagedAgent }
  | { type: "agent_removed"; agentId: string; workspaceId?: string; internal: boolean }
  | { type: "provider_subagent"; event: ProviderSubagentStoreEvent }
  | { type: "background_work"; agentId: string; items: AgentBackgroundWorkItem[] }
  | { type: "timeline_replacement"; agentId: string; epoch: string }
  | {
      type: "agent_stream";
      agentId: string;
      event: AgentStreamEvent;
      seq?: number;
      epoch?: string;
      timestamp?: string;
    };

export type AgentSubscriber = (event: AgentManagerEvent) => void;

export type AgentLaunchEnvProvider = (agentId: string) => Record<string, string> | null;

export interface SubscribeOptions {
  agentId?: string;
  replayState?: boolean;
}

interface HydrateTimelineOptions {
  force?: boolean;
  broadcast?: boolean | (() => boolean);
  broadcastTimeline?: boolean;
}

export type ImportablePersistedAgentQueryOptions = Omit<ListImportableSessionsOptions, "signal"> & {
  /**
   * When set, only providers in this set are scanned, in addition to the
   * built-in importable allowlist + enabled + non-derived rules.
   */
  providerFilter?: Set<string>;
};

export interface ManagedImportableProviderSession extends ImportableProviderSession {
  provider: AgentProvider;
}

export interface ImportableSessionProviderError {
  provider: AgentProvider;
  message: string;
}

export interface ManagedImportableSessionsResult {
  sessions: ManagedImportableProviderSession[];
  providerErrors: ImportableSessionProviderError[];
}

export type AgentAttentionCallback = (params: {
  agentId: string;
  provider: AgentProvider;
  reason: "finished" | "error" | "permission";
  /** When the agent's current unread attention started; null when the agent is read. */
  attentionTimestamp: Date | null;
}) => void;

export type AgentArchivedCallback = (agentId: string) => Promise<void> | void;

export interface ProviderAvailability {
  provider: AgentProvider;
  available: boolean;
  error: string | null;
}

interface AgentManagerRescueTimeouts {
  reloadSessionCloseMs?: number;
  interruptSessionMs?: number;
}

interface ProviderEnabledFlag {
  enabled: boolean;
  derivedFromProviderId?: string | null;
  applyToolPolicy?: (
    config: AgentSessionConfig,
    toolPolicy: ToolPolicy | undefined,
  ) => AgentSessionConfig;
}

type ProviderEnabledMap = Partial<Record<AgentProvider, ProviderEnabledFlag>>;

type ProviderClientMap = Partial<Record<AgentProvider, AgentClient>>;

export interface CreateAgentOptions {
  labels?: Record<string, string>;
  metadata?: AgentMetadata;
  initialPrompt?: string;
  env?: Record<string, string>;
  persistSession?: boolean;
  initialTitle?: string | null;
  // undefined is an explicit decision: the agent never appears in the sidebar.
  workspaceId: string | undefined;
  owner?: AgentOwner;
  /** Background agents stay out of discovery, tabs, tracks and attention. Fixed at creation. */
  background?: boolean;
}

export interface AgentManagerOptions {
  pluginLifecycle?: PluginLifecycle;
  clients?: ProviderClientMap;
  providerDefinitions?: ProviderEnabledMap;
  idFactory?: () => string;
  registry?: AgentStorage;
  onAgentAttention?: AgentAttentionCallback;
  /** Fired once per billed turn (completed or stopped) so a usage time-series can be recorded. */
  onUsageBilled?: (input: {
    timestampMs: number;
    provider: string;
    model: string;
    usage: AgentUsage;
  }) => void;
  onWorkspaceStateMayHaveChanged?: (params: { cwd: string }) => void;
  timelineStore?: InMemoryAgentTimelineStore;
  durableTimelineStore?: AgentTimelineStore;
  /** Projected-timeline snapshots that let a reopened agent skip its provider replay. */
  timelineSnapshots?: AgentTimelineSnapshots;
  terminalManager?: TerminalManager | null;
  mcpBaseUrl?: string;
  mcpAuthToken?: string;
  pluginAgentTools?: PluginAgentToolsRuntime;
  resolveJAgentDeskToolPolicy?: (
    provider: AgentProvider,
  ) => ProviderJAgentDeskToolsPolicy | undefined;
  jagentdeskToolsEnabled?: boolean;
  jagentdeskToolCatalogFactory?: JAgentDeskToolCatalogFactory;
  /** Built-in tool groups the host has on; compared at the start of every turn (spec 04 §27b.1). */
  hostToolSet?: HostToolSetSource;
  /** Display name of a provider, for timeline rows. */
  providerLabel?: (provider: AgentProvider) => string;
  appendSystemPrompt?: string;
  operatorContext?: string;
  /** Session ledgers (spec 40 §2); provider switches hand off through them. */
  sessionLedger?: SessionLedgerStore;
  resolveProviderLabel?: (provider: AgentProvider) => string;
  /** Host failover and child-provider settings (spec 40 §4–§5); agent overrides win. */
  resolveContinuityConfig?: () => {
    failover: FailoverConfig;
    crossProviderChildren: CrossProviderChildrenConfig;
  };
  /** True when Usage reports the provider out of quota. */
  isProviderUsageExhausted?: (provider: AgentProvider) => boolean;
  /** Remaining quota per provider from Usage, for list_child_providers. */
  resolveProviderQuota?: (provider: AgentProvider) => Promise<ProviderQuota>;
  /** Context window of a model from the provider catalog, used to size handoffs. */
  resolveModelContextWindow?: (input: {
    provider: AgentProvider;
    model: string | null;
  }) => Promise<number | null>;
  agentStreamCoalesceWindowMs?: number;
  rescueTimeouts?: AgentManagerRescueTimeouts;
  beforeSteerUnavailableFallback?: (input: {
    agentId: string;
    expectedTurnId: string;
  }) => Promise<void>;
  logger: Logger;
}

export type ActiveTurnSteerDispatchResult =
  | { status: "inactive" | "steered" }
  | { status: "replaced"; iterator: AsyncGenerator<AgentStreamEvent> };

function prependTurnContext(
  prompt: AgentPromptInput,
  context: string | undefined,
): AgentPromptInput {
  if (!context) return prompt;
  if (typeof prompt === "string") return `${context}\n\n${prompt}`;
  return [{ type: "text", text: context }, ...prompt];
}

export interface SwitchAgentProviderOptions {
  /** A running turn is waited for by default; "interrupt" stops it first. */
  whenBusy?: "wait" | "interrupt";
  reason?: "manual" | "failover" | "rollover";
}

export interface SwitchAgentProviderResult {
  mode: "resume" | "handoff";
  fromProvider: AgentProvider;
  toProvider: AgentProvider;
  model: string | null;
  handoffId: string | null;
  sessionId: string | null;
}

export interface SessionLedgerProviderSession {
  provider: string;
  model: string | null;
  sessionId: string | null;
  turns: number;
  lastUsedAt: string;
  current: boolean;
}

export interface SessionLedgerView {
  agentId: string;
  markdown: string;
  goal: LedgerNote | null;
  decisions: LedgerNote[];
  openItems: LedgerOpenItem[];
  nextStep: LedgerNote | null;
  handoffs: LedgerHandoffRecord[];
  providerSessions: SessionLedgerProviderSession[];
  compactions: LedgerCompaction[];
  regroundings: LedgerRegrounding[];
}

/** Spec 42 §7: the one visible turn "Capture lessons" sends. */
export const CAPTURE_LESSONS_PROMPT = [
  "Capture lessons: look back over this session and list the lessons and working procedures a future agent in this project should know —",
  "corrections the user made, mistakes you made and then confirmed the right way for, conventions and commands you found.",
  'Save each one with the remember tool: kind "lesson", status "pending", one sentence written as the rule to follow, and citations',
  "(the file that shows it, and if you can a short exact excerpt from it). Skip anything you are not sure of and anything already",
  "in AGENTS.md or CLAUDE.md. Do not change files in this turn. End with a short list of what you saved; the user reviews them under",
  "Memory → Pending lessons.",
].join(" ");

function providerLabel(provider: string): string {
  try {
    return getAgentProviderDefinition(provider).label;
  } catch {
    return provider;
  }
}

function createSessionContinuity(options: AgentManagerOptions): SessionContinuity {
  if (options.sessionLedger) return new SessionContinuity(options.sessionLedger);
  const registry = options.registry;
  const resolvePath = registry
    ? (agentId: string) => registry.ledgerPathFor(agentId)
    : async () => null;
  return new SessionContinuity(new SessionLedgerStore(resolvePath, options.logger));
}

const DURABLE_CONTEXT_OFF: DurableContextSettings = {
  regroundAfterCompaction: false,
  recitation: false,
  ledgerNudge: false,
  learnFromCorrections: false,
  lessonExpiry: false,
};

function durableLedgerFields(ledger: {
  durable?: { compactions: LedgerCompaction[]; regroundings: LedgerRegrounding[] };
}): { compactions: LedgerCompaction[]; regroundings: LedgerRegrounding[] } {
  return {
    compactions: ledger.durable?.compactions ?? [],
    regroundings: ledger.durable?.regroundings ?? [],
  };
}

function switchRowMessage(input: {
  reason: "manual" | "failover" | "rollover";
  from: string;
  target: string;
}): string {
  if (input.reason === "failover")
    return `${input.from} hit its usage limit — switched to ${input.target}`;
  if (input.reason === "rollover") return `Rolled over to a fresh session · ${input.target}`;
  return `Switched to ${input.target}`;
}

function countUserTurns(rows: readonly LedgerTimelineRow[], afterSeq: number): number {
  return rows.filter((row) => row.seq > afterSeq && row.item.type === "user_message").length;
}

function stripSteerOptions(options?: AgentSteerOptions): AgentRunOptions | undefined {
  if (!options) return undefined;
  const { clearPendingPermissions: _, ...runOptions } = options;
  return runOptions;
}

export interface WaitForAgentOptions {
  signal?: AbortSignal;
  waitForActive?: boolean;
}

export interface WaitForAgentResult {
  status: AgentLifecycleStatus;
  permission: AgentPermissionRequest | null;
  lastMessage: string | null;
}

export interface WaitForAgentStartOptions {
  signal?: AbortSignal;
}

export type AttentionState =
  | { requiresAttention: false }
  | {
      requiresAttention: true;
      attentionReason: "finished" | "error" | "permission";
      attentionTimestamp: Date;
    };

/** Private helpers and background agents report to their creator, never to the user. */
function raisesAttention(agent: Pick<ManagedAgent, "internal" | "background">): boolean {
  return !agent.internal && !agent.background;
}

function resolveInitialAttention(input: AttentionState | undefined): AttentionState {
  if (input == null || !input.requiresAttention) {
    return { requiresAttention: false };
  }
  return {
    requiresAttention: true,
    attentionReason: input.attentionReason,
    attentionTimestamp: new Date(input.attentionTimestamp),
  };
}

interface StreamEventFlags {
  shouldDispatchEvent: boolean;
  shouldNotifyWaiters: boolean;
}

type ActiveTurnTerminalDisposition = "closed_current" | "stale" | "untracked";

interface HandleStreamEventOptions {
  fromHistory?: boolean;
}

interface ManagedAgentBase {
  id: string;

  provider: AgentProvider;

  cwd: string;

  /**
   * Workspace this agent belongs to, stamped at creation. Independent of cwd:
   * cwd answers "where does it run", workspaceId answers "which workspace owns it".
   * Null/undefined for legacy agents created before ownership stamping.
   */
  workspaceId?: string;

  owner?: AgentOwner;

  capabilities: AgentCapabilityFlags;

  config: AgentSessionConfig;

  /** Explicit launch overrides, before per-opening hooks and daemon-owned variables. */
  launchEnv?: Record<string, string>;

  runtimeInfo?: AgentRuntimeInfo;

  createdAt: Date;

  updatedAt: Date;

  availableModes: AgentMode[];

  controls?: AgentOptionControl[];

  /** `config.json` defaults deep-merged with `config.providerOptions`; refreshed on every state emit. */
  effectiveOptions?: ProviderOptions;

  currentModeId: string | null;

  pendingPermissions: Map<string, AgentPermissionRequest>;

  bufferedPermissionResolutions: Map<
    string,
    Extract<AgentStreamEvent, { type: "permission_resolved" }>
  >;

  inFlightPermissionResponses: Set<string>;

  pendingReplacement: boolean;

  persistence: AgentPersistenceHandle | null;

  historyPrimed: boolean;

  lastUserMessageAt: Date | null;

  activeTurnId: string | null;

  activeTurnStartedAt: Date | null;

  lastUsage?: AgentUsage;

  /**
   * Cumulative usage accumulated across every completed turn. Persisted, unlike
   * {@link lastUsage} (a per-turn snapshot). Feeds the Usage & Cost insights.
   */
  usageTotals?: AgentUsageTotals;

  /**
   * Usage reported by `usage_updated` events during the CURRENT turn. Reset when
   * a turn starts. Used to bill into {@link usageTotals} when a turn ends without
   * a `turn_completed` event (i.e. it was interrupted/stopped -> `turn_canceled`,
   * or errored -> `turn_failed`), so a stopped turn's tokens are not lost. Never
   * persisted; purely per-turn bookkeeping.
   */
  currentTurnUsage?: AgentUsage;
  /** Provider-owned session metrics, replaced whole on every provider update. */
  sessionMetrics?: AgentMetric[];
  lastError?: string;

  attention: AttentionState;

  foregroundTurnWaiters: Set<ForegroundTurnWaiter>;

  finalizedForegroundTurnIds: Set<string>;

  unsubscribeSession: (() => void) | null;

  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   */
  internal?: boolean;

  /**
   * Background agents are durable but hidden from default discovery and never raise attention.
   * Fixed at creation.
   */
  background?: boolean;

  /**
   * User-defined labels for categorizing agents (e.g., { surface: "workspace" }).
   */
  labels: Record<string, string>;

  /** Plugin-owned data. JAgentDesk persists and forwards it and never reads a key. */
  metadata: AgentMetadata;
}

type ManagedAgentWithSession = ManagedAgentBase & {
  session: AgentSession;
};

type ManagedAgentInitializing = ManagedAgentWithSession & {
  lifecycle: "initializing";
  activeForegroundTurnId: null;
};

type ManagedAgentIdle = ManagedAgentWithSession & {
  lifecycle: "idle";
  activeForegroundTurnId: null;
};

type ManagedAgentRunning = ManagedAgentWithSession & {
  lifecycle: "running";
  activeForegroundTurnId: string | null;
};

type ManagedAgentError = ManagedAgentWithSession & {
  lifecycle: "error";
  activeForegroundTurnId: null;
  lastError: string;
};

type ManagedAgentClosed = ManagedAgentBase & {
  lifecycle: "closed";
  session: null;
  activeForegroundTurnId: null;
};

export type ManagedAgent =
  | ManagedAgentInitializing
  | ManagedAgentIdle
  | ManagedAgentRunning
  | ManagedAgentError
  | ManagedAgentClosed;

export interface AgentMetricsSnapshot {
  total: number;
  subscriptionCount: number;
  byLifecycle: Record<string, number>;
  withActiveForegroundTurn: number;
  timelineStats: {
    totalItems: number;
    maxItemsPerAgent: number;
  };
}

type ActiveManagedAgent =
  | ManagedAgentInitializing
  | ManagedAgentIdle
  | ManagedAgentRunning
  | ManagedAgentError;

type LiveManagedAgent = ActiveManagedAgent;

type AgentLabelPatch = Record<string, string | null>;

/**
 * What a provider replay contributes: timeline rows, the metrics of the turn that
 * wrote the rows before them, and the session's metrics as they stood at that point.
 */
type ProviderHistoryEntry =
  | { type: "row"; event: Extract<AgentStreamEvent, { type: "timeline" }> }
  | { type: "turn_metrics"; metrics: AgentMetric[] }
  | { type: "session_metrics"; metrics: AgentMetric[] };

interface ReplayedTimelineRow {
  event: Extract<AgentStreamEvent, { type: "timeline" }>;
  row: AgentTimelineRow;
}

function readSessionMetrics(
  agent?: { sessionMetrics?: AgentMetric[] } | null,
): AgentMetric[] | undefined {
  return agent?.sessionMetrics;
}

function providerHistoryEntries(event: AgentStreamEvent): ProviderHistoryEntry[] {
  if (event.type === "timeline") {
    return projectAgentMessages(event.item).map((item) => ({
      type: "row",
      event: { ...event, item },
    }));
  }
  if (event.type === "turn_completed") {
    const metrics = sanitizeAgentMetrics(event.metrics);
    return metrics.length > 0 ? [{ type: "turn_metrics", metrics }] : [];
  }
  if (event.type === "session_metrics_updated") {
    return [{ type: "session_metrics", metrics: sanitizeAgentMetrics(event.metrics) }];
  }
  return [];
}
type AgentMetadata = Record<string, JsonValue>;

function attachManagedTurnIdentity(
  agent: ActiveManagedAgent,
  event: AgentStreamEvent,
  fromHistory: boolean,
): { event: AgentStreamEvent; turnId: string | undefined } {
  const existingTurnId = getAgentStreamEventTurnId(event);
  if (fromHistory || existingTurnId !== undefined) {
    return { event, turnId: existingTurnId };
  }
  switch (event.type) {
    case "turn_started": {
      const turnId =
        agent.activeForegroundTurnId ?? agent.activeTurnId ?? `autonomous-${randomUUID()}`;
      return { event: { ...event, turnId }, turnId };
    }
    case "turn_completed":
    case "turn_failed":
    case "turn_canceled": {
      const turnId = agent.activeForegroundTurnId ?? agent.activeTurnId ?? undefined;
      return turnId ? { event: { ...event, turnId }, turnId } : { event, turnId };
    }
    case "timeline": {
      // Live provider items belong to the foreground turn that owns their dispatch.
      // Provider history deliberately keeps absent IDs because it has no daemon turn identity.
      const turnId = agent.activeForegroundTurnId ?? agent.activeTurnId ?? undefined;
      return turnId ? { event: { ...event, turnId }, turnId } : { event, turnId };
    }
    default:
      return { event, turnId: undefined };
  }
}

function limitAgentStreamEventContent(event: AgentStreamEvent): AgentStreamEvent {
  return event.type === "timeline"
    ? { ...event, item: limitAgentTimelineItemContent(event.item) }
    : event;
}

interface WriteLabelsResult {
  record: StoredAgentRecord | null;
  live: boolean;
}

interface AgentMetadataPatch {
  title?: string;
  labels?: AgentLabelPatch;
  metadata?: Record<string, JsonValue | null>;
}

const SYSTEM_ERROR_PREFIX = "[System Error]";
/** How long a provider switch waits for a running turn before giving up. */
const SWITCH_WAIT_FOR_RUN_MS = 10 * 60 * 1000;

function normalizePersistenceForConfig(
  handle: AgentPersistenceHandle | null,
  config: AgentSessionConfig,
): AgentPersistenceHandle | null {
  if (!handle) {
    return null;
  }
  const {
    mcpServers: _launchMcpServers,
    pluginAppendSystemPrompt: _pluginAppendSystemPrompt,
    daemonAppendSystemPrompt: _daemonAppendSystemPrompt,
    ...metadata
  } = handle.metadata ?? {};
  return {
    ...handle,
    metadata: {
      ...metadata,
      cwd: config.cwd,
      ...(config.mcpServers ? { mcpServers: config.mcpServers } : {}),
    },
  };
}

interface SubscriptionRecord {
  callback: AgentSubscriber;
  agentId: string | null;
}

interface SteerEventBarrier {
  events: AgentStreamEvent[];
}

const BUSY_STATUSES: Set<AgentLifecycleStatus> = new Set(["initializing", "running"]);

const AgentIdSchema = z.guid();

function isAgentBusy(status: AgentLifecycleStatus): boolean {
  return BUSY_STATUSES.has(status);
}

function isTurnTerminalEvent(event: AgentStreamEvent): boolean {
  return (
    event.type === "turn_completed" ||
    event.type === "turn_failed" ||
    event.type === "turn_canceled"
  );
}

function abortMessage(reason: unknown, fallbackMessage: string): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) return reason.message;
  return fallbackMessage;
}

function createAbortError(signal: AbortSignal | undefined, fallbackMessage: string): Error {
  const message = abortMessage(signal?.reason, fallbackMessage);
  return Object.assign(new Error(message), { name: "AbortError" });
}

/** The user labels and plugin metadata an agent carries; both default to empty. */
function agentEntityData(source?: { labels?: Record<string, string>; metadata?: AgentMetadata }) {
  return { labels: source?.labels ?? {}, metadata: source?.metadata ?? {} };
}

// JAGENTDESK_WORKSPACE_ID lets an agent rename or archive its own workspace; several workspaces can
// share one cwd, so the agent can't work it out from JAGENTDESK_AGENT_CWD.
function agentIdentityEnv({
  agentId,
  cwd,
  opening,
}: {
  agentId: string;
  cwd: string;
  opening: { workspaceId?: string | null } | undefined;
}): Record<string, string> {
  const workspaceId = opening?.workspaceId;
  return {
    JAGENTDESK_AGENT_ID: agentId,
    JAGENTDESK_AGENT_CWD: cwd,
    ...(workspaceId ? { JAGENTDESK_WORKSPACE_ID: workspaceId } : {}),
  };
}

// Launch env and the registered agent must agree, or the next snapshot erases the stored workspace.
function resolveResumeWorkspaceId({
  options,
  record,
}: {
  options: { workspaceId?: string } | undefined;
  record: Pick<StoredAgentRecord, "workspaceId"> | null;
}): string | undefined {
  return options?.workspaceId ?? record?.workspaceId;
}

function validateAgentId(agentId: string, source: string): string {
  const result = AgentIdSchema.safeParse(agentId);
  if (!result.success) {
    throw new Error(`${source}: agentId must be a UUID`);
  }
  return result.data;
}

function buildExplicitTimelineSeedForRegister(
  now: Date,
  options:
    | {
        timeline?: AgentTimelineItem[];
        timelineRows?: AgentTimelineRow[];
        timelineNextSeq?: number;
        createdAt?: Date;
        updatedAt?: Date;
      }
    | undefined,
): SeedAgentTimelineOptions | null {
  const hasTimeline = Boolean(options?.timeline?.length);
  const hasTimelineRows = Boolean(options?.timelineRows?.length);
  const hasTimelineNextSeq = options?.timelineNextSeq !== undefined;
  if (!hasTimeline && !hasTimelineRows && !hasTimelineNextSeq) {
    return null;
  }
  return {
    items: options?.timeline,
    rows: options?.timelineRows,
    nextSeq: options?.timelineNextSeq,
    timestamp: (options?.updatedAt ?? options?.createdAt ?? now).toISOString(),
  };
}

function buildImportedTimelineRows(entries: readonly ImportedTimelineEntry[]): AgentTimelineRow[] {
  const rows: AgentTimelineRow[] = [];
  // Finds the footer row a turn's stats belong on, by the same rule live turns use.
  const projection = new TimelineProjection();
  for (const entry of entries) {
    for (const item of projectAgentMessages(entry.item)) {
      const row: AgentTimelineRow = {
        seq: rows.length + 1,
        timestamp: entry.timestamp ?? new Date().toISOString(),
        item: limitAgentTimelineItemContent(item),
      };
      rows.push(row);
      projection.append(row);
    }
    if (entry.turnMetrics) {
      const footer = projection.stampTurnMetrics(entry.turnMetrics);
      if (footer)
        rows[footer.seq - 1] = { ...rows[footer.seq - 1], turnMetrics: entry.turnMetrics };
    }
  }
  return rows;
}

function resolveImportedAgentTitle(
  config: AgentSessionConfig,
  timelineRows: readonly AgentTimelineRow[],
): string | null {
  const initialPrompt = getFirstUserMessageTextFromRows(timelineRows);
  if (!initialPrompt) {
    return null;
  }
  const { explicitTitle, provisionalTitle } = resolveCreateAgentTitles({
    configTitle: config.title,
    initialPrompt,
  });
  return explicitTitle ?? provisionalTitle ?? null;
}

function getFirstUserMessageTextFromRows(rows: readonly AgentTimelineRow[]): string | null {
  for (const row of rows) {
    const item = row.item;
    if (item.type !== "user_message") {
      continue;
    }
    const text = item.text.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function shouldDetachFromArchivedParent(
  parent: StoredAgentRecord,
  child: StoredAgentRecord,
): boolean {
  const isCrossWorkspace =
    parent.workspaceId !== undefined &&
    child.workspaceId !== undefined &&
    parent.workspaceId !== child.workspaceId;
  return isCrossWorkspace || hasOpenAgentTab(child.labels);
}

function detachedAgentLabelPatch(labels: Record<string, string>): AgentLabelPatch {
  const patch: AgentLabelPatch = { [PARENT_AGENT_ID_LABEL]: null };
  for (const label of Object.keys(labels)) {
    if (isOpenAgentTabLabel(label)) {
      patch[label] = null;
    }
  }
  return patch;
}

export class AgentManager {
  private readonly pluginLifecycle: PluginLifecycle | undefined;

  private readonly clients = new Map<AgentProvider, AgentClient>();

  private readonly providerEnabled = new Map<AgentProvider, boolean>();

  private readonly providerDefinitions = new Map<AgentProvider, ProviderEnabledFlag>();

  private readonly agents = new Map<string, LiveManagedAgent>();

  private readonly timelineStore: InMemoryAgentTimelineStore;

  private readonly providerSubagents = new ProviderSubagentStore();

  private readonly backgroundWork = new AgentBackgroundWorkStore();
  private readonly backgroundWorkTimeline = new BackgroundWorkTimeline();

  private readonly agentsAwaitingInitialSnapshotPersist = new Set<string>();

  private readonly sessionEventTails = new Map<string, Promise<void>>();

  private readonly steerEventBarriers = new Map<string, SteerEventBarrier>();

  private readonly foregroundMutationTails = new Map<string, Promise<void>>();

  private readonly replacementMutationTails = new Map<string, Promise<void>>();

  private readonly runs = new AgentRunState();

  private readonly subscribers = new Set<SubscriptionRecord>();

  private readonly stopListeners = new Set<(agentId: string) => void>();

  private readonly idFactory: () => string;

  private readonly registry?: AgentStorage;

  private readonly durableTimelineStore?: AgentTimelineStore;

  private readonly timelineSnapshots?: AgentTimelineSnapshots;

  private readonly previousStatuses = new Map<string, AgentLifecycleStatus>();

  private readonly backgroundTasks = new Set<Promise<void>>();

  private readonly agentRegistrationTasks = new Set<Promise<void>>();

  private readonly inFlightAgentCloses = new Map<string, Promise<void>>();

  private readonly reloadedSessionCloses = new WeakMap<AgentSession, Promise<void>>();

  private readonly historySessions = new WeakSet<AgentSession>();

  private readonly runtimeCleanupIdentities = new WeakMap<
    AgentSession,
    { readonly openedAt: number }
  >();

  private readonly collectingRuntimes = new Set<string>();

  private readonly lifecycleMutationTails = new Map<string, Promise<void>>();

  private readonly pendingCancellations = new Map<string, Promise<unknown>>();

  private readonly agentStreamCoalescer: AgentStreamCoalescer;

  private mcpBaseUrl: string | null;

  private readonly mcpAuthToken: string | null;

  private sessionOpenGeneration = 0;

  private readonly sessionOpenGenerations = new Map<string, number>();

  private hostToolSet: HostToolSetSource | null = null;

  private providerLabel: (provider: AgentProvider) => string = (provider) => provider;

  /** Tool-group instructions of the agent's latest launch; joined into the daemon prompt. */
  private readonly hostToolInstructions = new Map<string, string[]>();

  /** Last tool-set change a non-resumable session was told about, so the row is written once. */
  private readonly unappliedHostToolSets = new Map<string, string>();
  /** What the agent's runtime launched with from the host: instructions and hidden connectors. */
  private readonly launchedHostHints = new Map<string, string>();
  /** Last "JAgentDesk tools are unavailable" reason written to an agent's timeline. */
  private readonly unavailableJAgentDeskTools = new Map<string, string>();

  private readonly attachedPluginTools = new Map<string, AttachedAgentTool[]>();

  private readonly pluginAgentTools: PluginAgentToolsRuntime | undefined;

  private jagentdeskToolsEnabled = true;

  private readonly resolveJAgentDeskToolPolicy: NonNullable<
    AgentManagerOptions["resolveJAgentDeskToolPolicy"]
  >;

  private readonly jagentdeskToolPolicies = new Map<
    string,
    ProviderJAgentDeskToolsPolicy | undefined
  >();

  private jagentdeskToolCatalogFactory: JAgentDeskToolCatalogFactory | null = null;

  private appendSystemPrompt: string;

  private operatorContext = "";

  private launchEnvProvider: AgentLaunchEnvProvider | null = null;
  private agentShimDir: string | null = null;

  private onAgentAttention?: AgentAttentionCallback;

  private onAgentArchived?: AgentArchivedCallback;

  private onWorkspaceStateMayHaveChanged?: (params: { cwd: string }) => void;

  private logger: Logger;

  private readonly rescueTimeouts: Required<AgentManagerRescueTimeouts>;

  private readonly beforeSteerUnavailableFallback?: AgentManagerOptions["beforeSteerUnavailableFallback"];

  private readonly onUsageBilled?: AgentManagerOptions["onUsageBilled"];

  private readonly continuity: SessionContinuity;
  private readonly durable: DurableContext;
  /**
   * Spec 42 switches and the Memory port. The daemon wires them at startup (defaults on); an
   * AgentManager nobody wired (embedders, unit tests) runs with durable context off.
   */
  private durablePorts: {
    settings(): DurableContextSettings | undefined;
    memory(): MemoryPort | undefined;
  } | null = null;
  private readonly resolveModelContextWindow?: AgentManagerOptions["resolveModelContextWindow"];
  private readonly resolveProviderLabel?: AgentManagerOptions["resolveProviderLabel"];
  private readonly resolveContinuityConfig?: AgentManagerOptions["resolveContinuityConfig"];
  private readonly failover: FailoverCoordinator;
  private readonly resolveProviderQuota?: AgentManagerOptions["resolveProviderQuota"];
  private failoverResend: ((agentId: string, prompt: AgentPromptInput) => Promise<void>) | null =
    null;

  /**
   * In-flight host tool permission requests, keyed by requestId. Resolved when
   * the client answers via {@link respondToPermission}.
   */
  private readonly hostToolPermissions = new Map<
    string,
    (response: AgentPermissionResponse) => void
  >();

  private acceptingAgentRegistrations = true;

  constructor(options: AgentManagerOptions) {
    this.pluginLifecycle = options.pluginLifecycle;
    this.resolveJAgentDeskToolPolicy = options.resolveJAgentDeskToolPolicy ?? (() => undefined);
    this.pluginAgentTools = options.pluginAgentTools;
    this.timelineStore = options.timelineStore ?? new InMemoryAgentTimelineStore();
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.registry = options.registry;
    this.durableTimelineStore = options?.durableTimelineStore;
    this.timelineSnapshots = this.attachTimelineSnapshots(options.timelineSnapshots);
    this.onAgentAttention = options?.onAgentAttention;
    this.onUsageBilled = options?.onUsageBilled;
    this.onWorkspaceStateMayHaveChanged = options?.onWorkspaceStateMayHaveChanged;
    this.mcpBaseUrl = options?.mcpBaseUrl ?? null;
    this.mcpAuthToken = options?.mcpAuthToken ?? null;
    this.configureJAgentDeskTools(options);
    this.appendSystemPrompt = options.appendSystemPrompt ?? "";
    this.setOperatorContext(options.operatorContext);
    this.logger = options.logger.child({ module: "agent", component: "agent-manager" });
    this.continuity = createSessionContinuity(options);
    this.durable = new DurableContext({
      store: this.continuity.store,
      settings: () =>
        this.durablePorts?.settings() ?? (this.durablePorts ? undefined : DURABLE_CONTEXT_OFF),
      memory: () => this.durablePorts?.memory(),
      rows: (agentId) => this.timelineStore.fetch(agentId, { direction: "tail", limit: 0 }).rows,
      appendTimelineItem: (agentId, item) => this.appendTimelineItem(agentId, item),
      labelFor: (provider) => this.labelFor(provider),
      logger: this.logger,
    });
    this.resolveModelContextWindow = options.resolveModelContextWindow;
    this.resolveProviderLabel = options.resolveProviderLabel;
    this.resolveContinuityConfig = options.resolveContinuityConfig;
    this.failover = this.createFailoverCoordinator(options);
    this.resolveProviderQuota = options.resolveProviderQuota;
    this.rescueTimeouts = {
      reloadSessionCloseMs:
        options.rescueTimeouts?.reloadSessionCloseMs ?? RELOAD_SESSION_CLOSE_TIMEOUT_MS,
      interruptSessionMs:
        options.rescueTimeouts?.interruptSessionMs ?? INTERRUPT_SESSION_TIMEOUT_MS,
    };
    this.beforeSteerUnavailableFallback = options.beforeSteerUnavailableFallback;
    this.agentStreamCoalescer = new AgentStreamCoalescer({
      windowMs: options.agentStreamCoalesceWindowMs ?? AGENT_STREAM_COALESCE_DEFAULT_WINDOW_MS,
      timers: { setTimeout, clearTimeout },
      onFlush: ({ agentId, item, provider, turnId }) => {
        const event = this.recordAndDispatchTimelineItem(agentId, item, provider, turnId);
        this.notifyForegroundTurnWaiters(agentId, event);
      },
    });
    this.updateProviderRegistry({
      providerDefinitions: options.providerDefinitions ?? {},
      clients: options.clients ?? {},
    });
  }

  private configureJAgentDeskTools(options: AgentManagerOptions): void {
    this.jagentdeskToolsEnabled = options.jagentdeskToolsEnabled ?? true;
    this.jagentdeskToolCatalogFactory = options.jagentdeskToolCatalogFactory ?? null;
    this.hostToolSet = options.hostToolSet ?? null;
    if (options.providerLabel) this.providerLabel = options.providerLabel;
  }

  /** Spec 29.4 host setting: hide provider connectors that JAgentDesk tools replace. */
  setHideProviderConnectors(read: () => boolean): void {
    this.hideProviderConnectors = read;
  }

  private hideProviderConnectors: () => boolean = () => true;

  setHostToolSet(source: HostToolSetSource | null): void {
    this.hostToolSet = source;
  }

  setProviderLabel(label: (provider: AgentProvider) => string): void {
    this.providerLabel = label;
  }

  registerClient(provider: AgentProvider, client: AgentClient): void {
    this.clients.set(provider, client);
  }

  updateProviderRegistry(input: {
    providerDefinitions: ProviderEnabledMap;
    clients: ProviderClientMap;
  }): void {
    this.providerEnabled.clear();
    this.providerDefinitions.clear();
    for (const [provider, definition] of Object.entries(input.providerDefinitions)) {
      if (definition) {
        this.providerEnabled.set(provider, definition.enabled);
        this.providerDefinitions.set(provider, definition);
      }
    }

    this.clients.clear();
    for (const [provider, client] of Object.entries(input.clients)) {
      if (client) {
        this.clients.set(provider, client);
      }
    }
  }

  getRegisteredProviderIds(): AgentProvider[] {
    return Array.from(this.clients.keys());
  }

  setAgentAttentionCallback(callback: AgentAttentionCallback): void {
    this.onAgentAttention = callback;
  }

  setAgentArchivedCallback(callback: AgentArchivedCallback): void {
    this.onAgentArchived = callback;
  }

  setMcpBaseUrl(url: string | null): void {
    this.mcpBaseUrl = url;
  }

  prepareForShutdown(): void {
    this.acceptingAgentRegistrations = false;
  }

  setJAgentDeskToolsEnabled(enabled: boolean): void {
    this.jagentdeskToolsEnabled = enabled;
  }

  invalidatePluginSessions(): void {
    this.sessionOpenGeneration++;
  }

  /**
   * Runs before every foreground turn. A plugin that changed what agents open with, or a
   * built-in tool group turned on or off for the host (spec 04 §27b.1), restarts the runtime
   * on the same native session so this turn already has the host's current tools.
   */
  async reloadStalePluginSession(agentId: string): Promise<void> {
    if (!this.needsPluginSessionReload(agentId) && !this.pendingHostToolSetDiff(agentId)) return;
    await this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(agentId, async () => {
        const pluginStale = this.needsPluginSessionReload(agentId);
        const toolDiff = this.pendingHostToolSetDiff(agentId);
        if (!pluginStale && !toolDiff) return;
        if (toolDiff && !this.canResumeNativeSession(agentId)) {
          // A fresh provider session would drop the conversation; keep the old tools.
          await this.noteUnappliedHostToolSet(agentId, toolDiff);
          if (!pluginStale) return;
        }
        if (toolDiff) {
          this.logger.info(
            { agentId, added: toolDiff.added, removed: toolDiff.removed },
            "Host tool groups changed; resuming the agent's session with the new tools",
          );
        }
        await this.reloadAgentSessionInternal(agentId);
      }),
    );
  }

  /**
   * Spec 04 §27b.0, runs before every foreground turn after `reloadStalePluginSession`. Asks the
   * provider whether the JAgentDesk tools reached its runtime; when they did not, restarts the
   * runtime on the same native session with a fresh MCP config once, then writes one timeline
   * row with the reason instead of letting the agent tell the user its tools are gone.
   */
  async ensureJAgentDeskTools(agentId: string): Promise<void> {
    const first = await this.checkJAgentDeskTools(agentId);
    if (!first) return;
    const agent = this.requireAgent(agentId);
    let reason = first.reason;
    if (this.canResumeNativeSession(agentId)) {
      this.logger.warn(
        { agentId, provider: agent.provider, reason },
        "JAgentDesk tools are missing from the agent's runtime; restarting it with a fresh MCP config",
      );
      await this.trackAgentRegistrationOperation(
        this.runLifecycleMutation(agentId, () => this.reloadAgentSessionInternal(agentId)),
      );
      const second = await this.checkJAgentDeskTools(agentId);
      if (!second) {
        this.logger.info({ agentId, provider: agent.provider }, "JAgentDesk tools restored");
        return;
      }
      reason = second.reason;
    }
    this.logger.warn(
      { agentId, provider: agent.provider, reason },
      "JAgentDesk tools are unavailable for this agent",
    );
    if (this.unavailableJAgentDeskTools.get(agentId) === reason) return;
    this.unavailableJAgentDeskTools.set(agentId, reason);
    await this.appendTimelineItem(agentId, {
      type: "notification",
      level: "warning",
      message: `JAgentDesk tools are unavailable for ${this.providerLabel(agent.provider)}: ${reason}`,
    });
  }

  /** The missing-tools reason, or null when the tools are there or the provider cannot tell. */
  private async checkJAgentDeskTools(agentId: string): Promise<{ reason: string } | null> {
    const agent = this.agents.get(agentId);
    if (
      !agent ||
      agent.internal ||
      !agent.session.checkJAgentDeskTools ||
      this.hasInFlightRun(agentId) ||
      !this.jagentdeskToolsEnabled ||
      !isJAgentDeskToolPolicyEnabled(this.jagentdeskToolPolicies.get(agentId))
    ) {
      return null;
    }
    try {
      const health = await agent.session.checkJAgentDeskTools({
        signal: AbortSignal.timeout(JAGENTDESK_TOOLS_CHECK_TIMEOUT_MS),
      });
      this.logger.debug({ agentId, health }, "JAgentDesk tools check");
      if (health.status !== "missing") {
        this.unavailableJAgentDeskTools.delete(agentId);
        return null;
      }
      return { reason: health.reason };
    } catch (error) {
      // An unanswered check is not proof of missing tools; the turn surfaces real failures.
      this.logger.warn({ err: error, agentId }, "JAgentDesk tools check failed");
      return null;
    }
  }

  /** The host's tool groups differ from the ones the agent's live runtime was opened with. */
  private pendingHostToolSetDiff(agentId: string): HostToolSetDiff | null {
    if (!this.hostToolSet) return null;
    const agent = this.getAgent(agentId);
    if (!agent || agent.lifecycle === "closed" || agent.internal || this.hasInFlightRun(agentId)) {
      return null;
    }
    // Without the JAgentDesk tools the host's tool groups never reach this runtime.
    if (
      !this.jagentdeskToolsEnabled ||
      !isJAgentDeskToolPolicyEnabled(this.jagentdeskToolPolicies.get(agentId))
    ) {
      return null;
    }
    const diff = diffHostToolSets(this.hostToolSet.launched(agentId), this.hostToolSet.current());
    if (diff) return diff;
    // Spec 29.4: a Jira connection added mid-session changes the launch instructions and the
    // connectors to hide without changing any tool group.
    return this.hostHintsChanged(agentId) ? { added: [], removed: [] } : null;
  }

  private hostHintsChanged(agentId: string): boolean {
    const launched = this.launchedHostHints.get(agentId);
    // Launches without instructions (internal or history purposes) never carried hints.
    if (!launched || launched === hostHintsSignature([], []) || !this.hostToolSet) return false;
    const hidden = this.hideProviderConnectors()
      ? (this.hostToolSet.replacedProviderConnectors?.(agentId) ?? [])
      : [];
    return launched !== hostHintsSignature(this.hostToolSet.instructions(agentId), hidden);
  }

  /**
   * Reloading keeps the conversation: the native session resumes, or there is no conversation
   * yet (Codex starts its thread with the first turn), so a fresh session loses nothing.
   */
  private canResumeNativeSession(agentId: string): boolean {
    if (this.agents.get(agentId)?.persistence?.sessionId) return true;
    return !this.getTimeline(agentId).some((item) => item.type === "user_message");
  }

  private async noteUnappliedHostToolSet(agentId: string, diff: HostToolSetDiff): Promise<void> {
    const signature = hostToolSetSignature(diff);
    if (this.unappliedHostToolSets.get(agentId) === signature) return;
    this.unappliedHostToolSets.set(agentId, signature);
    const agent = this.requireAgent(agentId);
    await this.appendTimelineItem(agentId, {
      type: "notification",
      level: "info",
      message: `New tools apply from a new session for ${this.providerLabel(agent.provider)}`,
    });
  }

  private needsPluginSessionReload(agentId: string): boolean {
    const agent = this.getAgent(agentId);
    return (
      agent !== null &&
      agent.lifecycle !== "closed" &&
      this.sessionOpenGenerations.get(agentId) !== this.sessionOpenGeneration &&
      !this.hasInFlightRun(agentId)
    );
  }

  getJAgentDeskToolPolicy(agentId: string): ProviderJAgentDeskToolsPolicy | undefined {
    return this.jagentdeskToolPolicies.get(agentId);
  }

  getPluginTools(agentId: string): readonly AttachedAgentTool[] {
    return (this.attachedPluginTools.get(agentId) ?? []).filter((tool) =>
      this.pluginAgentTools?.isToolPluginAvailable(tool.pluginId, tool.pluginInstanceId),
    );
  }

  async executePluginTool(
    tool: AttachedAgentTool,
    agentId: string,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    const agent = this.getAgent(agentId);
    if (!agent || agent.lifecycle === "closed") throw new Error(`Agent is not live: ${agentId}`);
    if (!this.pluginAgentTools) throw new Error("Plugin tools are unavailable");
    const record = await this.registry?.get(agentId);
    return this.pluginAgentTools.callTool(
      tool.pluginId,
      tool.pluginInstanceId,
      describeHookAgent({ ...agent, title: record?.title ?? agent.config.title }),
      tool.name,
      input,
      signal,
    );
  }

  private detachPluginTools(agentId: string): void {
    this.attachedPluginTools.delete(agentId);
    this.sessionOpenGenerations.delete(agentId);
    this.pluginAgentTools?.detachTools(agentId);
  }

  setJAgentDeskToolCatalogFactory(factory: JAgentDeskToolCatalogFactory | null): void {
    this.jagentdeskToolCatalogFactory = factory;
  }

  /**
   * Capability token the daemon's own MCP clients must present to the Agent MCP
   * endpoint when a daemon password is configured. Read by the per-client
   * session to authenticate its own MCP connection. Stays in the daemon — never
   * sent to remote clients.
   */
  getMcpAuthToken(): string | null {
    return this.mcpAuthToken;
  }

  private turnContextProvider?: (
    agentId: string,
  ) => Promise<{ text: string; accepted: () => void } | null>;

  setTurnContextProvider(provider: AgentManager["turnContextProvider"]): void {
    this.turnContextProvider = provider;
  }

  /** Spec 42: where the durable-context switches and the Memory port come from (bootstrap). */
  setDurableContextPorts(ports: {
    settings(): DurableContextSettings | undefined;
    memory(): MemoryPort | undefined;
  }): void {
    this.durablePorts = ports;
  }

  setAppendSystemPrompt(prompt: string | null | undefined): void {
    this.appendSystemPrompt = prompt ?? "";
  }

  setOperatorContext(context: string | null | undefined): void {
    this.operatorContext = context ?? "";
  }

  /**
   * Extra environment for an agent's provider process, read at every launch, resume and
   * reload. Spec mode uses it for per-agent spec-kit variables (spec 28.3 step 5).
   */
  setLaunchEnvProvider(provider: AgentLaunchEnvProvider | null): void {
    this.launchEnvProvider = provider;
  }

  /**
   * Spec 04 §27b item 3b: the directory with the `open` / `xdg-open` / BROWSER shims. Every
   * agent launch puts it first on PATH and points BROWSER at it, so pages an agent or its dev
   * server opens land in the in-app browser.
   */
  setAgentShimDir(dir: string | null): void {
    this.agentShimDir = dir;
  }

  public getMetricsSnapshot(): AgentMetricsSnapshot {
    const byLifecycle: Record<string, number> = {};
    let withActiveForegroundTurn = 0;
    let totalItems = 0;
    let maxItemsPerAgent = 0;

    for (const agent of this.agents.values()) {
      byLifecycle[agent.lifecycle] = (byLifecycle[agent.lifecycle] ?? 0) + 1;

      if (agent.activeForegroundTurnId !== null) {
        withActiveForegroundTurn++;
      }

      if (!this.timelineStore.has(agent.id)) {
        continue;
      }

      const len = this.timelineStore.getItems(agent.id).length;
      totalItems += len;
      if (len > maxItemsPerAgent) {
        maxItemsPerAgent = len;
      }
    }

    return {
      total: this.agents.size,
      subscriptionCount: this.subscribers.size,
      byLifecycle,
      withActiveForegroundTurn,
      timelineStats: {
        totalItems,
        maxItemsPerAgent,
      },
    };
  }

  private touchUpdatedAt(agent: ManagedAgent): Date {
    const nowMs = Date.now();
    const previousMs = agent.updatedAt.getTime();
    const nextMs = nowMs > previousMs ? nowMs : previousMs + 1;
    const next = new Date(nextMs);
    agent.updatedAt = next;
    return next;
  }

  private nextStoredUpdatedAt(record: StoredAgentRecord): string {
    const previousMs = Date.parse(record.updatedAt);
    const nowMs = Date.now();
    const nextMs = nowMs > previousMs ? nowMs : previousMs + 1;
    return new Date(nextMs).toISOString();
  }

  hasPendingPermissions(agentId: string): boolean {
    return (this.agents.get(agentId)?.pendingPermissions.size ?? 0) > 0;
  }

  /**
   * The agent's session can take a prompt into a running turn. A session declares it by offering
   * steerActiveTurn. A provider can still refuse one steer; the prompt then replaces the turn.
   */
  canSteer(agentId: string): boolean {
    return Boolean(this.agents.get(agentId)?.session?.steerActiveTurn);
  }

  hasInFlightRun(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return false;
    }

    return (
      agent.lifecycle === "running" ||
      Boolean(agent.activeForegroundTurnId) ||
      this.runs.hasRun(agentId)
    );
  }

  /**
   * Notify before a running turn is stopped with no prompt replacing it: Stop and `cancel_agent`,
   * not a replacing prompt, a reload, or a rewind. Listeners run before the agent settles.
   */
  onStop(listener: (agentId: string) => void): () => void {
    this.stopListeners.add(listener);
    return () => this.stopListeners.delete(listener);
  }

  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void {
    const targetAgentId =
      options?.agentId == null ? null : validateAgentId(options.agentId, "subscribe");
    const record: SubscriptionRecord = {
      callback,
      agentId: targetAgentId,
    };
    this.subscribers.add(record);

    if (options?.replayState !== false) {
      if (record.agentId) {
        const agent = this.agents.get(record.agentId);
        if (agent) {
          callback({
            type: "agent_state",
            agent: { ...agent },
          });
        }
      } else {
        // For global subscribers, skip internal agents during replay
        for (const agent of this.agents.values()) {
          if (agent.internal) {
            continue;
          }
          callback({
            type: "agent_state",
            agent: { ...agent },
          });
        }
      }
    }

    return () => {
      this.subscribers.delete(record);
    };
  }

  subscriptionCount(): number {
    return this.subscribers.size;
  }

  listAgents(): ManagedAgent[] {
    return Array.from(this.agents.values())
      .filter((agent) => !agent.internal)
      .map((agent) => Object.assign({}, agent));
  }

  async listImportableSessions(
    options?: ImportablePersistedAgentQueryOptions,
  ): Promise<ManagedImportableSessionsResult> {
    const providerEntries = Array.from(this.clients.entries()).filter(
      ([provider, client]) =>
        client.capabilities.supportsSessionListing &&
        !!client.listImportableSessions &&
        this.isProviderImportable(provider, options?.providerFilter),
    );
    const providerResults = await Promise.all(
      providerEntries.map(async ([provider, client]) => {
        const cancellation = new AbortController();
        try {
          const sessions = await withTimeout(
            client.listImportableSessions!({
              signal: cancellation.signal,
              limit: options?.limit,
              query: options?.query,
              scanLimit: options?.scanLimit,
              cwd: options?.cwd,
            }),
            IMPORTABLE_SESSION_LIST_TIMEOUT_MS,
            `Timed out listing importable sessions for provider '${provider}' after ${IMPORTABLE_SESSION_LIST_TIMEOUT_MS}ms`,
          );
          return {
            sessions: sessions
              .filter((session) => matchesImportableSessionQuery(session, options?.query))
              .map((session) => Object.assign(session, { provider })),
            error: null,
          };
        } catch (error) {
          cancellation.abort(error);
          this.logger.warn(
            { err: error, provider },
            "Failed to list importable sessions for provider",
          );
          return {
            sessions: [],
            error: {
              provider,
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }),
    );
    const sessions = providerResults.flatMap((result) => result.sessions);

    const limit = options?.limit ?? 20;
    return {
      sessions: sessions
        .sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime())
        .slice(0, limit),
      providerErrors: providerResults.flatMap((result) => (result.error ? [result.error] : [])),
    };
  }

  private isProviderImportable(
    provider: AgentProvider,
    providerFilter: Set<string> | undefined,
  ): boolean {
    if (this.providerEnabled.get(provider) === false) {
      return false;
    }
    if (providerFilter && !providerFilter.has(provider)) {
      return false;
    }
    return true;
  }

  async listProviderAvailability(): Promise<ProviderAvailability[]> {
    return Promise.all(
      Array.from(this.clients.keys()).map((provider) => this.getProviderAvailability(provider)),
    );
  }

  async getProviderAvailability(provider: AgentProvider): Promise<ProviderAvailability> {
    const client = this.clients.get(provider);
    if (!client) {
      return {
        provider,
        available: false,
        error: `No client registered for provider '${provider}'`,
      };
    }

    try {
      const available = await client.isAvailable();
      return {
        provider,
        available,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, provider }, "Failed to check provider availability");
      return {
        provider,
        available: false,
        error: message,
      };
    }
  }

  async listDraftCommands(config: AgentSessionConfig): Promise<AgentSlashCommand[]> {
    const normalizedConfig = await this.normalizeConfig(config, { resolveDefaultModel: false });
    const client = this.requireClient(normalizedConfig.provider);
    if (!normalizedConfig.model) {
      return [];
    }
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }

    if (client.listCommands) {
      return await client.listCommands(normalizedConfig);
    }

    const session = await client.createSession(normalizedConfig);
    try {
      if (!session.listCommands) {
        throw new Error(
          `Provider '${normalizedConfig.provider}' does not support listing commands`,
        );
      }
      return await session.listCommands();
    } finally {
      try {
        await session.close();
      } catch (error) {
        this.logger.warn(
          { err: error, provider: normalizedConfig.provider },
          "Failed to close draft command listing session",
        );
      }
    }
  }

  async listDraftControls(config: AgentSessionConfig): Promise<AgentDraftControls> {
    const normalizedConfig = await this.normalizeConfig(config, { resolveDefaultModel: false });
    const client = this.requireClient(normalizedConfig.provider);
    const options = this.effectiveOptionsFor(
      normalizedConfig.provider,
      normalizedConfig.providerOptions,
    );
    if (!normalizedConfig.model && !client.listControls) {
      return { controls: [], options };
    }
    const available = await client.isAvailable();
    if (!available) {
      throw new Error(
        `Provider '${normalizedConfig.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }

    if (client.listControls) {
      return await client.listControls(normalizedConfig);
    }

    const session = await client.createSession(normalizedConfig);
    try {
      // The options a session opens with, as create would report them, so the controls'
      // selection matches what the first turn runs with.
      return {
        controls: session.controls ?? [],
        options: this.openedEffectiveOptions({ session, launchedOptions: options }),
      };
    } finally {
      try {
        await session.close();
      } catch (error) {
        this.logger.warn(
          { err: error, provider: normalizedConfig.provider },
          "Failed to close draft feature listing session",
        );
      }
    }
  }

  /** Built-in provider a custom provider derives from (itself when not derived). */
  getBaseProviderId(provider: AgentProvider): AgentProvider {
    return this.providerDefinitions.get(provider)?.derivedFromProviderId ?? provider;
  }

  usageSession(id: string) {
    const agent = this.agents.get(id);
    return agent?.session?.usageSession?.() ?? null;
  }

  getAgent(id: string): ManagedAgent | null {
    const agent = this.agents.get(id);
    return agent ? { ...agent } : null;
  }

  async waitForAgentClose(agentId: string): Promise<void> {
    // Loading during a reload must wait for the replacement, not resume another writer.
    await this.lifecycleMutationTails.get(agentId)?.catch(() => undefined);
    await this.inFlightAgentCloses?.get(agentId)?.catch(() => undefined);
    if (this.collectingRuntimes.has(agentId))
      await this.lifecycleMutationTails.get(agentId)?.catch(() => undefined);
  }

  getTimeline(id: string): AgentTimelineItem[] {
    this.requireAgent(id);
    return this.timelineStore.getItems(id);
  }

  async getTimelineRows(id: string): Promise<AgentTimelineRow[]> {
    this.requireAgent(id);
    if (this.durableTimelineStore) {
      return projectTimelineRows({
        rows: await this.durableTimelineStore.getCommittedRows(id),
        mode: "projected",
      }).map((entry) => Object.assign({ seq: entry.seqEnd }, entry));
    }
    return this.timelineStore.getRows(id);
  }

  /**
   * Committed timeline rows of any stored agent — loaded or not, archived, on any provider —
   * without loading or resuming it (spec 42 §2b: agents read each other's history). Null when
   * the agent is not loaded and the daemon keeps no durable timeline.
   */
  async readAgentTimelineRows(id: string): Promise<AgentTimelineRow[] | null> {
    const normalizedId = validateAgentId(id, "readAgentTimelineRows");
    if (this.agents.has(normalizedId)) return this.getTimelineRows(normalizedId);
    if (!this.durableTimelineStore) return null;
    return projectTimelineRows({
      rows: await this.durableTimelineStore.getCommittedRows(normalizedId),
      mode: "projected",
    }).map((entry) => Object.assign({ seq: entry.seqEnd }, entry));
  }

  /** The timeline head of a loaded agent, or null when this agent is not loaded. Never loads. */
  getLoadedTimelineHead(id: string): { epoch: string; seq: number } | null {
    return this.getAgent(id) ? this.timelineStore.getHead(id) : null;
  }

  fetchTimeline(id: string, options?: AgentTimelineFetchOptions): AgentTimelineFetchResult {
    this.requireAgent(id);
    return this.timelineStore.fetch(id, options);
  }

  listProviderSubagents(parentAgentId: string): ProviderSubagentDescriptor[] {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.list(parentAgentId);
  }

  listAgentBackgroundWork(agentId: string): AgentBackgroundWorkItem[] {
    const agent = this.agents.get(agentId);
    if (agent?.internal || (!agent && !this.backgroundWork.summary(agentId))) {
      throw new Error(`Unknown agent '${agentId}'`);
    }
    return this.backgroundWork.list(agentId);
  }

  setDaemonBackgroundWork(input: DaemonBackgroundWorkInput): void {
    this.publishBackgroundWork(input.agentId, this.backgroundWork.setDaemonBackgroundWork(input));
  }

  removeDaemonBackgroundWork(key: DaemonBackgroundWorkKey): void {
    this.publishBackgroundWork(key.agentId, this.backgroundWork.removeDaemonBackgroundWork(key));
  }

  async stopAgentBackgroundWork({
    agentId,
    itemId,
    stopToken,
    canManageAutomation,
  }: StopAgentBackgroundWorkOptions): Promise<void> {
    if (isDaemonBackgroundWorkItem({ id: itemId })) {
      if (this.agents.get(agentId)?.internal) throw new Error(`Unknown agent '${agentId}'`);
      if (!canManageAutomation)
        throw new Error("Managing automation is required to stop daemon background work");
      await this.backgroundWork.stopDaemon(agentId, itemId, stopToken);
      return;
    }
    this.requirePublicAgent(agentId);
    // Inventory events share the session queue; drain events already received before
    // authorizing the token, including a reconnect's ownership revocation.
    await this.sessionEventTails.get(agentId)?.catch(() => undefined);
    const { session } = this.requirePublicAgent(agentId);
    if (!session?.stopBackgroundWork) throw new Error("Background work cannot be stopped");
    const providerItemId = this.backgroundWork.authorizeProviderStop(agentId, itemId, stopToken);
    await session.stopBackgroundWork(providerItemId);
  }

  getAgentBackgroundWorkSummary(agentId: string) {
    return this.backgroundWork.summary(agentId);
  }

  /** The live session started work that will start another turn by itself. */
  hasPendingWakeup(agentId: string): boolean {
    return this.agents.get(agentId)?.session.hasPendingWakeup?.() ?? false;
  }

  private publishBackgroundWork(agentId: string, items: AgentBackgroundWorkItem[] | null): void {
    if (items) this.dispatch({ type: "background_work", agentId, items });
  }

  private clearProviderBackgroundWork(agentId: string): void {
    this.backgroundWorkTimeline.forget(agentId);
    this.publishBackgroundWork(agentId, this.backgroundWork.clear(agentId));
  }

  listProviderSubagentActivity(): ProviderSubagentDescriptor[] {
    const publicParentIds = new Set(
      Array.from(this.agents.values())
        .filter((agent) => !agent.internal)
        .map((agent) => agent.id),
    );
    return this.providerSubagents
      .listAll()
      .filter((subagent) => publicParentIds.has(subagent.parentAgentId));
  }

  getProviderSubagent(
    parentAgentId: string,
    subagentId: string,
  ): ProviderSubagentDescriptor | null {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.get(parentAgentId, subagentId);
  }

  fetchProviderSubagentTimeline(
    parentAgentId: string,
    subagentId: string,
    options?: AgentTimelineFetchOptions,
  ): AgentTimelineFetchResult {
    this.requirePublicAgent(parentAgentId);
    return this.providerSubagents.fetchTimeline(parentAgentId, subagentId, options);
  }

  async createAgent(
    config: AgentSessionConfig,
    agentId: string | undefined,
    options: CreateAgentOptions,
  ): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(agentId ?? this.idFactory(), "createAgent");
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(resolvedAgentId, () =>
        this.createAgentInternal(config, resolvedAgentId, options),
      ),
    );
  }

  /**
   * Opens a stored agent whose provider left no session to resume: its first session, created
   * from the record as it is when the lane reaches it. A write queued ahead (`setMetadata`,
   * `setLabels`) is in that record; one queued behind applies to the live agent.
   */
  createAgentFromRecord(agentId: string): Promise<ManagedAgent> {
    const resolvedAgentId = validateAgentId(agentId, "createAgentFromRecord");
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(resolvedAgentId, async () => {
        const record = await this.requireRegistry().get(resolvedAgentId);
        if (!record) throw new AgentNotFoundError(resolvedAgentId);
        const config = buildSessionConfig(record, {
          validProviders: this.getRegisteredProviderIds(),
        });
        if (!config) {
          throw new Error(
            `Agent ${resolvedAgentId} references unavailable provider '${record.provider}'`,
          );
        }
        return this.createAgentInternal(config, resolvedAgentId, {
          labels: record.labels,
          metadata: record.metadata,
          workspaceId: record.workspaceId,
          owner: record.owner,
          background: record.background,
          env: record.launchEnv,
        });
      }),
    );
  }

  private async createAgentInternal(
    config: AgentSessionConfig,
    resolvedAgentId: string,
    options: CreateAgentOptions,
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    config = this.withConvertedOptions(config);
    if (this.pluginLifecycle && !config.internal) {
      const sent = exposeFeatureValuesToHook(config);
      const request = await this.pluginLifecycle.before("agent.create.before", {
        config: sent,
        env: options.env,
        metadata: options.metadata ?? {},
      });
      // COMPAT(featureValues): added in v0.15.0, remove after 2027-05-01. A plugin written
      // against the previous SDK edits `config.featureValues`.
      config = {
        ...foldHookFeatureValues({
          returned: request.config,
          sent,
          convert: (values) => this.convertLegacyOptions(request.config.provider, values),
        }),
        internal: config.internal,
      };
      options = { ...options, env: request.env, metadata: request.metadata ?? options.metadata };
    }
    await this.deleteAgentState(resolvedAgentId);
    const { storedConfig, launchConfig } = await this.prepareSessionConfig(
      config,
      resolvedAgentId,
      { env: options?.env },
    );
    this.requireEnabledProvider(storedConfig.provider);
    const client = await this.requireAvailableClient({
      provider: storedConfig.provider,
    });
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      options?.env,
      {
        workspaceId: options.workspaceId,
        reason: "create",
        title: options.initialTitle ?? storedConfig.title ?? null,
        background: options.background,
        labels: options.labels ?? {},
        metadata: options.metadata ?? {},
      },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const createOptions = this.buildCreateSessionOptions(options);
    const launchedOptions = this.launchOptionsFor({ client, own: storedConfig.providerOptions });
    const session = await client.createSession(providerLaunchConfig, launchContext, createOptions);
    await this.requireExternalMcpSupport(session, providerLaunchConfig, launchContext);
    const agent = await this.registerSession(session, storedConfig, resolvedAgentId, {
      launchedOptions,
      labels: options.labels,
      metadata: options.metadata,
      initialTitle: options.initialTitle,
      workspaceId: options.workspaceId,
      owner: options.owner,
      background: options.background,
      launchEnv: options.env ? { ...options.env } : undefined,
      historyPrimed: true,
    });
    if (!agent.internal)
      this.pluginLifecycle?.emit("agent.create.after", {
        agent: describeHookAgent({ ...agent, title: agent.config.title }),
      });
    return agent;
  }

  private buildCreateSessionOptions(options?: {
    persistSession?: boolean;
  }): AgentCreateSessionOptions | undefined {
    return options?.persistSession === undefined
      ? undefined
      : { persistSession: options.persistSession };
  }

  // Reconstruct an agent from provider persistence. Callers should explicitly
  // hydrate timeline history after resume.
  resumeAgentFromPersistence(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      metadata?: AgentMetadata;
      workspaceId?: string;
      owner?: AgentOwner;
      background?: boolean;
      attention?: AttentionState;
      /** Skip replaying provider history into the timeline (a fast fork shows its parent's). */
      historyPrimed?: boolean;
    },
    resumeOptions?: AgentResumeSessionOptions,
  ): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(
      this.resumeAgentFromPersistenceInternal(handle, overrides, agentId, options, resumeOptions),
    );
  }

  private async resumeAgentFromPersistenceInternal(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    agentId?: string,
    options?: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      metadata?: AgentMetadata;
      workspaceId?: string;
      owner?: AgentOwner;
      background?: boolean;
      attention?: AttentionState;
      /** Skip replaying provider history into the timeline (a fast fork shows its parent's). */
      historyPrimed?: boolean;
    },
    resumeOptions?: AgentResumeSessionOptions,
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    const resolvedAgentId = validateAgentId(
      agentId ?? this.idFactory(),
      "resumeAgentFromPersistence",
    );
    const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const mergedConfig = {
      ...metadata,
      ...overrides,
      provider: handle.provider,
    } as AgentSessionConfig;
    // A history load reads an archived agent whose working directory may be gone, so only
    // an interactive resume requires the directory to exist.
    const startedAt = performance.now();
    const phases: Record<string, number> = {};
    const mark = (phase: string) => {
      phases[phase] = Math.round(performance.now() - startedAt);
    };
    const record = this.registry ? await this.registry.get(resolvedAgentId) : null;
    const purpose = await resolveResumePurpose(record, resumeOptions?.purpose, mergedConfig.cwd);
    const currentResumeOptions = { purpose } satisfies AgentResumeSessionOptions;
    const workspaceId = resolveResumeWorkspaceId({ options, record });
    const launchEnv = record?.launchEnv;
    const { storedConfig, launchConfig } = await this.prepareSessionConfig(
      mergedConfig,
      resolvedAgentId,
      { purpose, env: launchEnv },
    );
    mark("config");

    const client = this.requireClient(handle.provider);
    const available = await client.isAvailable();
    mark("available");
    if (!available) {
      throw new Error(
        `Provider '${handle.provider}' is not available. Please ensure the CLI is installed.`,
      );
    }
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      launchEnv,
      {
        reason: "resume",
        purpose,
        workspaceId,
        ...resumeLaunchIdentity(record, mergedConfig, options),
      },
    );
    mark("launchContext");
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const launchedOptions = this.launchOptionsFor({ client, own: storedConfig.providerOptions });
    const session = await client.resumeSession(
      handle,
      providerLaunchConfig,
      launchContext,
      currentResumeOptions,
    );
    mark("providerResume");
    if (purpose === "history") this.historySessions.add(session);
    await this.requireExternalMcpSupport(session, providerLaunchConfig, launchContext);
    const timelineSnapshot = await this.readValidTimelineSnapshot(resolvedAgentId, handle, session);
    mark("timelineSnapshot");
    this.logger.debug(
      { agentId: resolvedAgentId, provider: handle.provider, purpose, phases },
      "agent.resume.phases",
    );
    return this.registerSession(session, storedConfig, resolvedAgentId, {
      launchedOptions,
      timelineSnapshot,
      ...options,
      // The caller read its metadata before this turn in the lane; a setMetadata queued ahead of
      // it has saved a newer record, the one the open hooks saw.
      ...(record ? { metadata: record.metadata } : {}),
      restoring: true,
      sessionMetrics: readSessionMetrics(record),
      launchEnv,
      workspaceId,
      persistence:
        purpose === "interactive" && session.persistenceUpdatedOnResume
          ? (session.describePersistence() ?? handle)
          : handle,
    });
  }

  importProviderSession(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels?: Record<string, string>;
  }): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(this.importProviderSessionInternal(input));
  }

  private async importProviderSessionInternal(input: {
    provider: AgentProvider;
    providerHandleId: string;
    cwd: string;
    workspaceId: string;
    labels?: Record<string, string>;
  }): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    const resolvedAgentId = validateAgentId(this.idFactory(), "importProviderSession");
    this.requireEnabledProvider(input.provider);

    const client = await this.requireAvailableClient({ provider: input.provider });
    if (!client.importSession) {
      throw new Error(`Provider '${input.provider}' does not support importing sessions`);
    }

    const { storedConfig, launchConfig } = await this.prepareSessionConfig(
      {
        provider: input.provider,
        cwd: input.cwd,
      },
      resolvedAgentId,
      { resolveDefaultModel: false },
    );
    const launchContext = await this.buildLaunchContext(
      resolvedAgentId,
      client,
      storedConfig.cwd,
      undefined,
      {
        reason: "import",
        purpose: "interactive",
        workspaceId: input.workspaceId,
        labels: input.labels ?? {},
      },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const launchedOptions = this.launchOptionsFor({ client, own: storedConfig.providerOptions });
    const imported = await client.importSession(
      {
        providerHandleId: input.providerHandleId,
        cwd: input.cwd,
      },
      { config: providerLaunchConfig, storedConfig, launchContext },
    );
    await this.requireExternalMcpSupport(imported.session, providerLaunchConfig, launchContext);
    let handedToRegistration = false;
    try {
      const runtimeInfo = await imported.session.getRuntimeInfo();
      const importedConfig = await this.normalizeConfig(
        stripInternalJAgentDeskMcpServer({
          ...imported.config,
          model: runtimeInfo.model ?? imported.config.model,
        }),
        { resolveDefaultModel: false },
      );
      const timelineRows = buildImportedTimelineRows(imported.timeline);
      const initialTitle = resolveImportedAgentTitle(importedConfig, timelineRows);

      handedToRegistration = true;
      const agent = await this.registerSession(imported.session, importedConfig, resolvedAgentId, {
        launchedOptions,
        labels: input.labels,
        workspaceId: input.workspaceId,
        timelineRows,
        timelineNextSeq: timelineRows.length + 1,
        sessionMetrics: imported.sessionMetrics,
        persistence: imported.persistence,
        historyPrimed: true,
        initialTitle,
        publishWhenReady: true,
      });
      for (const event of imported.providerSubagentEvents ?? []) {
        const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
        this.timelineSnapshots?.markChanged(agent.id);
        this.dispatch({ type: "provider_subagent", event: update });
      }
      return agent;
    } finally {
      if (!handedToRegistration) {
        this.detachPluginTools(resolvedAgentId);
        await this.closeUnregisteredSession(imported.session);
      }
    }
  }

  // Hot-reload an active agent session with config overrides. By default the
  // in-memory timeline is preserved (used for voice-mode toggles and similar
  // config swaps). When `rehydrateFromDisk` is set, the timeline is wiped so a
  // new epoch is minted and provider history is re-streamed — this is what the
  // user-facing "Reload agent" action wants when the on-disk session was
  // mutated outside JAgentDesk.
  reloadAgentSession(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
    options?: { rehydrateFromDisk?: boolean },
  ): Promise<ManagedAgent> {
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(agentId, () =>
        this.reloadAgentSessionInternal(agentId, overrides, options),
      ),
    );
  }

  private async reloadAgentSessionInternal(
    agentId: string,
    overrides?: Partial<AgentSessionConfig>,
    options?: { rehydrateFromDisk?: boolean },
  ): Promise<ManagedAgent> {
    this.assertAcceptingAgentRegistrations();
    let existing = this.requireSessionAgent(agentId);
    if (this.hasInFlightRun(agentId)) {
      await this.cancelAgentRunBefore(agentId, "reload");
      existing = this.requireSessionAgent(agentId);
    }
    const rehydrateFromDisk = options?.rehydrateFromDisk ?? false;
    const preservedHistoryPrimed = existing.historyPrimed;
    const preservedLastUsage = existing.lastUsage;
    const preservedUsageTotals = existing.usageTotals;
    const preservedSessionMetrics = existing.sessionMetrics;
    const preservedLastError = existing.lastError;
    const preservedAttention = existing.attention;
    const handle = existing.persistence;
    const provider = handle?.provider ?? existing.provider;
    const client = this.requireClient(provider);
    const refreshConfig = {
      ...existing.config,
      ...overrides,
      provider,
    } as AgentSessionConfig;
    const { storedConfig, launchConfig } = await this.prepareSessionConfig(refreshConfig, agentId, {
      env: existing.launchEnv,
    });
    const launchContext = await this.buildLaunchContext(
      agentId,
      client,
      storedConfig.cwd,
      existing.launchEnv,
      {
        reason: "refresh",
        purpose: "interactive",
        workspaceId: existing.workspaceId,
        title: await this.resolveInitialPersistedTitle(agentId, existing.config, null),
        background: existing.background,
        labels: existing.labels,
        metadata: existing.metadata,
      },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);

    // Refuse before releasing the live runtime: the replacement would be refused anyway.
    if (
      Object.keys(stripInternalJAgentDeskMcpServer(providerLaunchConfig).mcpServers ?? {}).length >
        0 &&
      existing.session.capabilities.supportsMcpServers !== true
    ) {
      this.detachPluginTools(agentId);
      throw this.unsupportedMcpError(providerLaunchConfig, launchContext);
    }

    const launchedOptions = this.launchOptionsFor({ client, own: storedConfig.providerOptions });
    let session: AgentSession | undefined;
    let closedExisting: ManagedAgentClosed | undefined;
    let handedToRegistration = false;
    try {
      // Paseo #4353: a persisted thread has one writer even while its turn is idle (Codex
      // refuses a second one with "thread … already has an active writer"), so the old
      // runtime is released before the same session is resumed.
      await this.closeReloadedSession(existing.session, agentId);
      await this.drainSessionEvents(agentId);
      this.cancelRunningProviderSubagents(agentId);
      this.clearProviderBackgroundWork(agentId);
      closedExisting = this.prepareAgentForClosure(existing, "agent reloaded");
      await this.persistSnapshot(closedExisting);
      this.assertAcceptingAgentRegistrations();

      session = handle
        ? await client.resumeSession(handle, providerLaunchConfig, launchContext)
        : await client.createSession(providerLaunchConfig, launchContext);
      await this.requireExternalMcpSupport(session, providerLaunchConfig, launchContext);
      this.assertAcceptingAgentRegistrations();

      if (rehydrateFromDisk) {
        // Wipe the in-memory timeline so registerSession mints a new epoch and
        // hydrateTimelineFromProvider re-streams the freshly read provider history.
        this.timelineStore.delete(agentId);
        for (const event of this.providerSubagents.deleteParent(agentId)) {
          this.dispatch({ type: "provider_subagent", event });
        }
      }

      // Preserve existing labels and timeline during reload.
      handedToRegistration = true;
      return this.registerSession(session, storedConfig, agentId, {
        launchedOptions,
        labels: existing.labels,
        metadata: existing.metadata,
        workspaceId: existing.workspaceId,
        owner: existing.owner,
        background: existing.background,
        launchEnv: existing.launchEnv,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        lastUserMessageAt: existing.lastUserMessageAt,
        historyPrimed: rehydrateFromDisk ? false : preservedHistoryPrimed,
        lastUsage: preservedLastUsage,
        usageTotals: preservedUsageTotals,
        sessionMetrics: preservedSessionMetrics,
        lastError: preservedLastError,
        attention: preservedAttention,
        restoring: true,
      });
    } catch (error) {
      if (closedExisting) {
        this.emitClosedAgent(closedExisting, { persist: false });
      } else if (this.agents.get(agentId) === existing) {
        existing.lifecycle = "error";
        existing.lastError = error instanceof Error ? error.message : String(error);
        this.emitState(existing);
      }
      throw error;
    } finally {
      if (!handedToRegistration) {
        this.detachPluginTools(agentId);
        if (session) await this.closeUnregisteredSession(session);
      }
    }
  }

  private async closeReloadedSession(session: AgentSession, agentId: string): Promise<void> {
    let operation = this.reloadedSessionCloses.get(session);
    if (!operation) {
      operation = session.close();
      this.reloadedSessionCloses.set(session, operation);
      // Keep pending closes across request timeouts; a retry must await the same release.
      void operation.catch(() => this.reloadedSessionCloses.delete(session));
    }
    const result = await this.waitWithTimeout({
      operation,
      timeoutMs: this.rescueTimeouts.reloadSessionCloseMs,
      onLateError: (error) => {
        this.logger.warn(
          { err: error, agentId },
          "Previous session close failed after refresh timeout",
        );
      },
    });
    // A timeout must not authorize a second writer on the same session.
    if (result === "timed_out") {
      throw new Error("Timed out closing previous session during refresh");
    }
  }

  private async waitWithTimeout(options: TimeoutOptions): Promise<TimeoutResult> {
    let didTimeOut = false;
    let timer: NodeJS.Timeout | null = null;
    const operation = options.operation
      .then((): TimeoutResult => "completed")
      .catch((error) => {
        if (didTimeOut) {
          options.onLateError?.(error);
          return "timed_out" as const;
        }
        throw error;
      });

    try {
      return await Promise.race([
        operation,
        new Promise<TimeoutResult>((resolvePromise) => {
          timer = setTimeout(() => {
            didTimeOut = true;
            resolvePromise("timed_out");
          }, options.timeoutMs);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /** Capture runtime capabilities without handing lifecycle ownership to the collector. */
  getRuntimeCleanupCandidates(): RuntimeCleanupCandidate[] {
    if (!this.registry) return [];
    const candidates: RuntimeCleanupCandidate[] = [];
    for (const agent of this.agents.values()) {
      const updatedAt = agent.updatedAt;
      let identity = this.runtimeCleanupIdentities.get(agent.session);
      if (!identity) {
        identity = Object.freeze({ openedAt: Date.now() });
        this.runtimeCleanupIdentities.set(agent.session, identity);
      }
      const isEligible = () =>
        this.agents.get(agent.id) === agent &&
        agent.updatedAt === updatedAt &&
        this.runtimeHasNoPendingWork(agent);
      candidates.push({
        identity,
        agentId: agent.id,
        parentAgentId: getParentAgentIdFromLabels(agent.labels) ?? undefined,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? null,
        lastActivityAt: Math.max(updatedAt.getTime(), identity.openedAt),
        isEligible,
        canStopRuntime: agent.session.canStopRuntime?.bind(agent.session),
        closeIfEligible: async (revalidate) => {
          if (!agent.persistence?.sessionId) return false;
          // Block prompt admission before entering the close lane. A skipped close also
          // releases this barrier, so the waiting prompt keeps the existing runtime.
          this.collectingRuntimes.add(agent.id);
          try {
            return await this.runLifecycleMutation(agent.id, () =>
              this.closeAgentRuntime(agent.id, () => isEligible() && revalidate()),
            );
          } finally {
            this.collectingRuntimes.delete(agent.id);
          }
        },
      });
    }
    return candidates;
  }

  private runtimeHasNoPendingWork(agent: LiveManagedAgent): boolean {
    return (
      agent.lifecycle === "idle" &&
      !agent.internal &&
      !this.backgroundWork.summary(agent.id)?.count &&
      agent.activeForegroundTurnId === null &&
      !this.runs.hasRun(agent.id) &&
      !agent.pendingReplacement &&
      agent.pendingPermissions.size === 0 &&
      agent.inFlightPermissionResponses.size === 0 &&
      (this.collectingRuntimes.has(agent.id) || !this.lifecycleMutationTails.has(agent.id)) &&
      !this.foregroundMutationTails.has(agent.id) &&
      !this.sessionEventTails.has(agent.id) &&
      !this.providerSubagents.list(agent.id).some((child) => child.status === "running")
    );
  }

  closeAgent(agentId: string): Promise<void> {
    const existing = this.inFlightAgentCloses.get(agentId);
    if (existing) {
      return existing;
    }

    const close = this.closeAgentRuntime(agentId).then(() => undefined);
    this.inFlightAgentCloses.set(agentId, close);
    const clearClose = () => {
      if (this.inFlightAgentCloses.get(agentId) === close) {
        this.inFlightAgentCloses.delete(agentId);
      }
    };
    void close.then(clearClose, clearClose);
    return close;
  }

  private async closeAgentRuntime(agentId: string, canClose?: () => boolean): Promise<boolean> {
    const live = this.agents.get(agentId);
    if (!live && (await this.registry?.get(agentId))) return false;
    const agent = this.requireAgent(agentId);
    this.logger.trace(
      {
        agentId,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: agent.activeForegroundTurnId ?? undefined,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        pendingPermissions: agent.pendingPermissions.size,
      },
      "agent.manager.close.start",
    );
    await this.drainSessionEvents(agentId);
    if (canClose && !canClose()) return false;
    // The snapshot needs the live session to name the history the timeline came from.
    await this.timelineSnapshots?.flush(agentId);
    let closeError: unknown;
    try {
      await agent.session.close();
    } catch (error) {
      closeError = error;
    }

    await this.drainSessionEvents(agentId);
    this.cancelRunningProviderSubagents(agentId);
    // close() drops the session's subscribers before the provider could report an empty list.
    this.clearProviderBackgroundWork(agentId);
    const closedAgent = this.prepareAgentForClosure(agent, "agent closed");
    let persistError: unknown;
    try {
      await this.persistSnapshot(closedAgent);
    } catch (error) {
      persistError = error;
    }
    this.detachPluginTools(agentId);
    this.emitClosedAgent(closedAgent, { persist: false });
    this.logger.trace(
      {
        agentId,
        provider: closedAgent.provider,
        sessionId: closedAgent.persistence?.sessionId ?? undefined,
      },
      "agent.manager.close.complete",
    );

    if (closeError !== undefined) {
      throw closeError;
    }
    if (persistError !== undefined) {
      throw persistError;
    }
    return true;
  }

  private cancelRunningProviderSubagents(parentAgentId: string): void {
    for (const subagent of this.providerSubagents.list(parentAgentId)) {
      if (subagent.status !== "running") {
        continue;
      }
      const event = this.providerSubagents.apply(parentAgentId, subagent.provider, {
        type: "upsert",
        id: subagent.id,
        status: "canceled",
      });
      this.timelineSnapshots?.markChanged(parentAgentId);
      this.dispatch({ type: "provider_subagent", event });
    }
  }

  async archiveAgent(agentId: string, archivedAt?: string): Promise<{ archivedAt: string }> {
    return this.runLifecycleMutation(agentId, () => this.archiveAgentUnlocked(agentId, archivedAt));
  }

  private async archiveAgentUnlocked(
    agentId: string,
    requestedArchivedAt?: string,
  ): Promise<{ archivedAt: string }> {
    const agent = this.requireAgent(agentId);
    if (!this.registry) {
      throw new Error("Agent storage is not configured");
    }

    await this.registry.applySnapshot(agent, {
      internal: agent.internal,
    });
    const stored = await this.registry.get(agentId);
    if (!stored) {
      throw new Error(`Agent ${agentId} not found in storage after snapshot`);
    }

    const archivedRecord = await this.markRecordArchived(stored, requestedArchivedAt);
    const { archivedAt } = archivedRecord;
    agent.updatedAt = new Date(archivedRecord.updatedAt);
    await this.closeAgent(agentId);
    this.discardRetainedAgentState(agentId);

    await this.cascadeArchiveChildren(agentId);

    return { archivedAt };
  }

  // Children created via the MCP `create_agent` tool carry the parent-agent-id
  // label pointing back at the caller. Archiving the parent cascades to those
  // children so subagent fleets don't outlive their orchestrator. Detached
  // handoff agents omit this label, so they stand outside the cascade.
  private async cascadeArchiveChildren(parentAgentId: string): Promise<void> {
    const registry = this.registry;
    if (!registry) {
      return;
    }
    const records = await registry.list();
    const parent = records.find((record) => record.id === parentAgentId);
    if (!parent) {
      throw new Error(`Archived parent ${parentAgentId} not found in storage`);
    }
    for (const record of records) {
      if (record.archivedAt) {
        continue;
      }
      if (record.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId) {
        continue;
      }
      const child = await registry.get(record.id);
      if (!child || child.archivedAt || child.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId) {
        continue;
      }
      await this.runLifecycleMutation(child.id, async () => {
        const currentChild = await registry.get(child.id);
        if (
          !currentChild ||
          currentChild.archivedAt ||
          currentChild.labels?.[PARENT_AGENT_ID_LABEL] !== parentAgentId
        ) {
          return;
        }
        if (shouldDetachFromArchivedParent(parent, currentChild)) {
          const detached = await this.detachAgentUnlocked(currentChild.id);
          if (!detached.live) this.dispatchStoredAgentState(detached.record);
        } else if (this.agents.has(currentChild.id)) {
          await this.archiveAgentUnlocked(currentChild.id, parent.archivedAt ?? undefined);
        } else {
          await this.archiveSnapshot(
            currentChild.id,
            parent.archivedAt ?? new Date().toISOString(),
          );
        }
      });
    }
  }

  private async markRecordArchived(
    record: StoredAgentRecord,
    archivedAt = new Date().toISOString(),
  ): Promise<ArchivedStoredAgentRecord> {
    const registry = this.requireRegistry();
    const archivedRecord = buildArchivedAgentRecord(record, {
      archivedAt: record.archivedAt ?? archivedAt,
      updatedAt: archivedAt,
    });

    await registry.upsert(archivedRecord);
    if (!record.archivedAt && !record.internal)
      this.pluginLifecycle?.emit("agent.archive.after", {
        agent: describeHookAgent(archivedRecord),
        archivedAt: archivedRecord.archivedAt,
      });

    await this.syncNativeArchiveState(record.provider, record.persistence, "archive");

    if (this.agents.has(record.id)) {
      this.notifyAgentState(record.id);
    } else if (!archivedRecord.internal) {
      this.dispatchStoredAgentState(archivedRecord);
    }

    await this.fireAgentArchived(record.id);

    return archivedRecord;
  }

  private async fireAgentArchived(agentId: string): Promise<void> {
    const callback = this.onAgentArchived;
    if (!callback) {
      return;
    }
    try {
      await callback(agentId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "onAgentArchived callback failed");
    }
  }

  private dispatchStoredAgentState(record: StoredAgentRecord): void {
    const updatedAt = new Date(record.updatedAt);
    this.dispatch({
      type: "agent_state",
      agent: {
        id: record.id,
        provider: record.provider,
        cwd: record.cwd,
        workspaceId: record.workspaceId,
        owner: record.owner,
        session: null,
        capabilities: STORED_AGENT_CAPABILITIES,
        config: buildStoredAgentConfig(record),
        runtimeInfo: record.runtimeInfo,
        lifecycle: "closed",
        createdAt: new Date(record.createdAt),
        updatedAt,
        availableModes: [],
        controls: record.controls,
        effectiveOptions: this.effectiveOptionsFor(
          record.provider,
          record.config?.providerOptions ?? undefined,
        ),
        currentModeId: record.lastModeId ?? null,
        pendingPermissions: new Map(),
        bufferedPermissionResolutions: new Map(),
        inFlightPermissionResponses: new Set(),
        pendingReplacement: false,
        activeForegroundTurnId: null,
        activeTurnId: null,
        activeTurnStartedAt: null,
        foregroundTurnWaiters: new Set(),
        finalizedForegroundTurnIds: new Set(),
        unsubscribeSession: null,
        persistence: record.persistence ?? null,
        historyPrimed: true,
        lastUserMessageAt: record.lastUserMessageAt ? new Date(record.lastUserMessageAt) : null,
        lastUsage: undefined,
        usageTotals: record.usageTotals,
        sessionMetrics: record.sessionMetrics,
        lastError: record.lastError ?? undefined,
        attention: extractAttention(record),
        internal: record.internal,
        background: record.background,
        labels: record.labels,
        metadata: record.metadata,
      },
    });
  }

  // Mode, model, thinking and options change inside the agent's lifecycle lane, like every other
  // mutation of one agent. A provider session therefore never has two of `setMode`, `setModel`,
  // `setThinkingOption` and `applyOptions` in flight at once, and none of them overlaps an open,
  // reload or close; providers do no sequencing of their own.

  async setAgentMode(agentId: string, modeId: string): Promise<AgentProviderNotice | null> {
    return this.runLifecycleMutation(agentId, () =>
      this.withLiveInteractiveSessionUnlocked(agentId, async (agent) => {
        const notice = (await agent.session.setMode(modeId)) ?? null;
        await this.drainSessionEvents(agentId);
        const currentMode = (await agent.session.getCurrentMode()) ?? modeId;
        agent.config.modeId = currentMode ?? undefined;
        agent.currentModeId = currentMode;
        // Update runtimeInfo to reflect the new mode
        if (agent.runtimeInfo) {
          agent.runtimeInfo = { ...agent.runtimeInfo, modeId: currentMode };
        }
        this.touchUpdatedAt(agent);
        this.emitState(agent);
        return notice;
      }),
    );
  }

  /**
   * Switch a live agent to a different provider mid-conversation (spec 40 §3). The agent keeps its
   * id, timeline and workspace. A provider that ran this agent before resumes its own native
   * session and gets only what changed since it left; a new provider gets a fresh session and the
   * session ledger plus the last turns, fitted to 60 % of its model's context window. Either text
   * is staged and rides on the next turn. A same-provider call is a model change.
   */
  async switchAgentProvider(
    agentId: string,
    provider: AgentProvider,
    modelId: string | null,
    options: SwitchAgentProviderOptions = {},
  ): Promise<SwitchAgentProviderResult | null> {
    if (this.requireSessionAgent(agentId).provider === provider && options.reason !== "rollover") {
      await this.setAgentModel(agentId, modelId);
      return null;
    }
    if (this.hasInFlightRun(agentId)) {
      if (options.whenBusy === "interrupt") {
        await this.cancelAgentRunBefore(agentId, "reload");
      } else {
        await this.waitForRunToSettle(agentId);
      }
    }
    return this.trackAgentRegistrationOperation(
      this.switchAgentProviderInternal(agentId, provider, modelId, options),
    );
  }

  /** Waits for the running turn to end; a pending permission must be answered first. */
  private async waitForRunToSettle(agentId: string): Promise<void> {
    const deadline = Date.now() + SWITCH_WAIT_FOR_RUN_MS;
    while (this.hasInFlightRun(agentId)) {
      if (Date.now() > deadline) {
        throw new Error(`Agent ${agentId} is still running; switch with whenBusy "interrupt"`);
      }
      const result = await this.waitForAgentEvent(agentId, {
        signal: AbortSignal.timeout(1_000),
      }).catch(() => null);
      if (result?.permission) {
        throw new Error(
          `Agent ${agentId} is waiting for a permission; answer it or switch with whenBusy "interrupt"`,
        );
      }
      // A run can stay tracked for a moment after its turn ended; let it settle.
      await new Promise((settled) => setTimeout(settled, 50));
    }
  }

  private async switchAgentProviderInternal(
    agentId: string,
    provider: AgentProvider,
    modelId: string | null,
    options: SwitchAgentProviderOptions,
  ): Promise<SwitchAgentProviderResult> {
    this.assertAcceptingAgentRegistrations();
    const existing = this.requireSessionAgent(agentId);
    const rows = this.fetchTimeline(agentId, { direction: "tail", limit: 0 }).rows;
    const record = await this.registry?.get(agentId);
    const providerSessions = this.captureOutgoingProviderSession(existing, rows, record ?? null);
    // A rollover (spec 42 §6) always opens a fresh native session on the same provider.
    const target = options.reason === "rollover" ? null : (providerSessions[provider] ?? null);

    // Provider-specific selections (mode/thinking/options/extra) do not map across providers;
    // the new provider starts from its defaults.
    const normalizedModelId = modelId?.trim() ? modelId : undefined;
    const newConfig = {
      ...existing.config,
      provider,
      model: normalizedModelId ?? target?.model ?? undefined,
      modeId: undefined,
      thinkingOptionId: undefined,
      providerOptions: undefined,
      extra: undefined,
    } as AgentSessionConfig;

    const client = this.requireClient(provider);
    const { storedConfig, launchConfig } = await this.prepareSessionConfig(newConfig, agentId);
    const launchContext = await this.buildLaunchContext(
      agentId,
      client,
      storedConfig.cwd,
      undefined,
      { workspaceId: existing.workspaceId },
    );
    const providerLaunchConfig = this.resolveProviderLaunchConfig(launchConfig, launchContext);
    const opened = await this.openSwitchedSession({
      agentId,
      client,
      target,
      config: providerLaunchConfig,
      launchContext,
    });
    const session = opened.session;
    await this.requireExternalMcpSupport(session, providerLaunchConfig, launchContext);

    let handedToRegistration = false;
    try {
      this.assertAcceptingAgentRegistrations();
      const closedExisting = this.prepareAgentForClosure(existing, "provider switched");
      try {
        await this.persistSnapshot(closedExisting);
      } finally {
        await this.closeReloadedSession(existing.session, agentId);
      }

      handedToRegistration = true;
      const resumedPersistence =
        opened.mode === "resume" && target
          ? { persistence: session.describePersistence() ?? target.persistence }
          : {};
      const registered = await this.registerSession(session, storedConfig, agentId, {
        launchedOptions: this.launchOptionsFor({ client, own: storedConfig.providerOptions }),
        metadata: existing.metadata,
        labels: existing.labels,
        workspaceId: existing.workspaceId,
        owner: existing.owner,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        lastUserMessageAt: existing.lastUserMessageAt,
        // Keep the existing timeline; the provider's own history is not replayed into it.
        historyPrimed: true,
        ...resumedPersistence,
        lastUsage: existing.lastUsage,
        usageTotals: existing.usageTotals,
        lastError: existing.lastError,
        attention: existing.attention,
      });
      return await this.completeProviderSwitch({
        registered,
        rows,
        fromProvider: existing.provider,
        mode: opened.mode,
        target,
        providerSessions,
        reason: options.reason ?? "manual",
      });
    } finally {
      if (!handedToRegistration) {
        await this.closeUnregisteredSession(session);
      }
    }
  }

  /** Records the outgoing provider's native session so a later switch back can resume it. */
  private captureOutgoingProviderSession(
    existing: ManagedAgent,
    rows: readonly LedgerTimelineRow[],
    record: StoredAgentRecord | null,
  ): Record<string, StoredProviderSession> {
    const providerSessions: Record<string, StoredProviderSession> = {
      ...record?.providerSessions,
    };
    if (!existing.persistence) return providerSessions;
    const enteredAtSeq = record?.providerEnteredAtSeq ?? 0;
    const previous = providerSessions[existing.provider];
    providerSessions[existing.provider] = {
      persistence: existing.persistence,
      model: existing.config.model ?? existing.runtimeInfo?.model ?? null,
      lastTimelineSeq: this.timelineStore.getHead(existing.id).seq,
      enteredAtSeq,
      turns: (previous?.turns ?? 0) + countUserTurns(rows, enteredAtSeq),
      lastUsedAt: new Date().toISOString(),
    };
    return providerSessions;
  }

  /** Resumes the target provider's own session when it has one, otherwise starts a new one. */
  private async openSwitchedSession(input: {
    agentId: string;
    client: AgentClient;
    target: StoredProviderSession | null;
    config: AgentSessionConfig;
    launchContext: AgentLaunchContext;
  }): Promise<{ session: AgentSession; mode: "resume" | "handoff" }> {
    const { client, target, config, launchContext } = input;
    if (target) {
      try {
        const session = await client.resumeSession(target.persistence, config, launchContext);
        return { session, mode: "resume" };
      } catch (error) {
        this.logger.warn(
          { err: error, agentId: input.agentId, sessionId: target.persistence.sessionId },
          "Provider session could not be resumed; starting a new one with a full handoff",
        );
      }
    }
    return { session: await client.createSession(config, launchContext), mode: "handoff" };
  }

  private async completeProviderSwitch(input: {
    registered: ManagedAgent;
    rows: readonly LedgerTimelineRow[];
    fromProvider: AgentProvider;
    mode: "resume" | "handoff";
    target: StoredProviderSession | null;
    providerSessions: Record<string, StoredProviderSession>;
    reason: "manual" | "failover" | "rollover";
  }): Promise<SwitchAgentProviderResult> {
    const { registered, fromProvider, mode, reason } = input;
    const agentId = registered.id;
    await this.durable
      .onFreshSession(agentId)
      .catch((error: unknown) =>
        this.logger.warn({ err: error, agentId }, "Durable context reset after switch failed"),
      );
    const toProvider = registered.provider;
    const model = registered.config.model ?? registered.runtimeInfo?.model ?? null;
    const handoff = await this.stageProviderHandoff({
      agentId,
      cwd: registered.cwd,
      rows: input.rows,
      fromProvider,
      toProvider,
      model,
      mode: mode === "resume" ? "delta" : "handoff",
      sinceSeq: mode === "resume" ? input.target?.lastTimelineSeq : undefined,
      reason,
    });
    const target = `${this.labelFor(toProvider)}${model ? ` · ${model}` : ""}`;
    const appended = await this.appendTimelineItem(agentId, {
      type: "notification",
      level: "info",
      message: switchRowMessage({
        reason,
        from: this.labelFor(fromProvider),
        target,
      }),
      providerSwitch: {
        fromProvider,
        toProvider,
        model,
        reason,
        mode,
        handoffId: handoff?.id ?? null,
      },
    });
    await this.registry?.patchRecordFields(agentId, () => ({
      providerSessions: input.providerSessions,
      providerEnteredAtSeq: appended.seq,
    }));
    this.touchUpdatedAt(registered);
    this.emitState(registered);
    return {
      mode,
      fromProvider,
      toProvider,
      model,
      handoffId: handoff?.id ?? null,
      sessionId: registered.persistence?.sessionId ?? null,
    };
  }

  /** Sends a prompt the way a user send does; wired by the daemon (it records the message). */
  setFailoverResend(resend: (agentId: string, prompt: AgentPromptInput) => Promise<void>): void {
    this.failoverResend = resend;
  }

  private createFailoverCoordinator(options: AgentManagerOptions): FailoverCoordinator {
    return new FailoverCoordinator({
      resolveConfig: async (agentId) => (await this.resolveAgentContinuity(agentId)).failover,
      listEnabledProviders: () =>
        Array.from(this.providerDefinitions.entries())
          .filter(([provider, definition]) => definition.enabled && this.clients.has(provider))
          .map(([provider]) => provider),
      isExhausted: (provider) => options.isProviderUsageExhausted?.(provider) ?? false,
      switchProvider: async (agentId, target) => {
        await this.switchAgentProvider(agentId, target.provider, target.model, {
          reason: "failover",
        });
      },
      resend: async (agentId, prompt) => {
        if (!this.failoverResend) throw new Error("Failover resend is not wired");
        await this.failoverResend(agentId, prompt);
      },
      readLastUserMessage: async (agentId) => {
        const rows = this.fetchTimeline(agentId, { direction: "tail", limit: 0 }).rows;
        const last = rows.findLast((row) => row.item.type === "user_message");
        return last?.item.type === "user_message" ? last.item.text : null;
      },
      appendUsageLimitNotice: async (agentId, notice) => {
        await this.appendTimelineItem(agentId, {
          type: "notification",
          level: "warning",
          message: `${this.labelFor(notice.provider)} usage limit reached`,
          usageLimit: notice,
        });
      },
      logger: this.logger,
    });
  }

  /** The agent's failover and child-provider settings: its own override, else the host's. */
  async resolveAgentContinuity(agentId: string): Promise<{
    failover: FailoverConfig;
    crossProviderChildren: CrossProviderChildrenConfig;
  }> {
    const host = this.resolveContinuityConfig?.();
    const record = await this.registry?.get(agentId);
    return {
      failover: record?.continuity?.failover ?? host?.failover ?? FAILOVER_DISABLED,
      crossProviderChildren:
        record?.continuity?.crossProviderChildren ??
        host?.crossProviderChildren ??
        CROSS_PROVIDER_CHILDREN_DISABLED,
    };
  }

  getHostContinuityConfig(): {
    failover: FailoverConfig;
    crossProviderChildren: CrossProviderChildrenConfig;
  } {
    const host = this.resolveContinuityConfig?.();
    return {
      failover: host?.failover ?? FAILOVER_DISABLED,
      crossProviderChildren: host?.crossProviderChildren ?? CROSS_PROVIDER_CHILDREN_DISABLED,
    };
  }

  async getAgentContinuityOverrides(agentId: string): Promise<AgentContinuityOverrides> {
    return (await this.registry?.get(agentId))?.continuity ?? {};
  }

  async setAgentContinuityOverrides(
    agentId: string,
    patch: AgentContinuityOverrides,
  ): Promise<void> {
    this.requireAgent(agentId);
    const registry = this.requireRegistry();
    await registry.patchRecordFields(agentId, (record) => {
      const next: AgentContinuityOverrides = { ...record.continuity };
      if (patch.failover !== undefined) next.failover = patch.failover;
      if (patch.crossProviderChildren !== undefined) {
        next.crossProviderChildren = patch.crossProviderChildren;
      }
      return { continuity: next };
    });
  }

  /** Spec 40 §5: the caller's allowed child providers, with Usage quota and a suggestion. */
  async listChildProviders(agentId: string): Promise<{
    enabled: boolean;
    parentProvider: AgentProvider;
    entries: ChildProviderEntry[];
  }> {
    const agent = this.requireAgent(agentId);
    const { crossProviderChildren } = await this.resolveAgentContinuity(agentId);
    const quotas = new Map<string, ProviderQuota>();
    for (const entry of crossProviderChildren.allowed) {
      if (quotas.has(entry.provider)) continue;
      quotas.set(
        entry.provider,
        (await this.resolveProviderQuota?.(entry.provider)) ?? {
          remainingPercent: null,
          resetsAt: null,
        },
      );
    }
    return {
      enabled: crossProviderChildren.enabled,
      parentProvider: agent.provider,
      entries: crossProviderChildren.enabled
        ? rankChildProviders({
            allowed: crossProviderChildren.allowed,
            quota: (provider) => quotas.get(provider) ?? { remainingPercent: null, resetsAt: null },
          })
        : [],
    };
  }

  /**
   * Checks a create_agent provider request from an agent against spec 40 §5 and returns the
   * compact handoff a child on another provider starts with (null for a same-provider child).
   */
  async prepareChildProvider(
    parentId: string,
    requested: ProviderModelRef | null,
  ): Promise<{ handoff: string | null }> {
    const parent = this.requireAgent(parentId);
    const { crossProviderChildren } = await this.resolveAgentContinuity(parentId);
    const rows = this.fetchTimeline(parentId, { direction: "tail", limit: 0 }).rows;
    const lastUser = rows.findLast((row) => row.item.type === "user_message");
    const decision = checkChildProvider({
      config: crossProviderChildren,
      parentProvider: parent.provider,
      requested,
      lastUserMessage: lastUser?.item.type === "user_message" ? lastUser.item.text : null,
      providerLabel: (provider) => this.labelFor(provider),
    });
    if (!decision.ok) throw new Error(decision.error);
    if (!requested || requested.provider === parent.provider) return { handoff: null };
    const contextWindow = await this.resolveModelContextWindow?.({
      provider: requested.provider,
      model: requested.model,
    });
    const handoff = await this.continuity.renderChildHandoff({
      parentId,
      cwd: parent.cwd,
      rows,
      fromProvider: this.labelFor(parent.provider),
      toProvider: this.labelFor(requested.provider),
      budgetTokens: handoffBudgetTokens(contextWindow),
    });
    return { handoff };
  }

  /**
   * Spec 42 §6 "Rollover to a fresh session": ends the current native session and opens a new one
   * on the same provider and model, staging the ledger handoff (ledger, artifact index, last three
   * turns verbatim) for the next turn. Same agent id and timeline. Only on the user's request.
   */
  async rolloverAgent(agentId: string): Promise<SwitchAgentProviderResult> {
    const agent = this.requireSessionAgent(agentId);
    const model = agent.config.model ?? agent.runtimeInfo?.model ?? null;
    const result = await this.switchAgentProvider(agentId, agent.provider, model, {
      reason: "rollover",
    });
    if (!result) throw new Error(`Rollover of ${agentId} did not open a new session`);
    return result;
  }

  /**
   * Spec 42 §7 "Capture lessons": one visible turn, sent the way a user message is, asking the
   * agent to save pending lessons. Exactly one model turn; nothing hidden.
   */
  async captureLessons(agentId: string): Promise<void> {
    this.requireAgent(agentId);
    if (!this.failoverResend) throw new Error("Capture lessons is not wired");
    await this.failoverResend(agentId, CAPTURE_LESSONS_PROMPT);
  }

  /** "Continue with …" on a usage-limit row: switch and resend the failed turn's message. */
  async continueAfterUsageLimit(agentId: string, target: ProviderModelRef): Promise<void> {
    this.requireAgent(agentId);
    await this.failover.continueWith(agentId, target);
  }

  private labelFor(provider: AgentProvider): string {
    return this.resolveProviderLabel?.(provider) ?? providerLabel(provider);
  }

  private async stageProviderHandoff(input: {
    agentId: string;
    cwd: string;
    rows: readonly LedgerTimelineRow[];
    fromProvider: AgentProvider;
    toProvider: AgentProvider;
    model: string | null;
    mode: "handoff" | "delta";
    sinceSeq?: number;
    reason: HandoffReason;
  }): Promise<LedgerHandoffRecord | null> {
    try {
      const contextWindow = await this.resolveModelContextWindow?.({
        provider: input.toProvider,
        model: input.model,
      });
      return await this.continuity.stageHandoff({
        ...input,
        fromProvider: this.labelFor(input.fromProvider),
        toProvider: this.labelFor(input.toProvider),
        budgetTokens: handoffBudgetTokens(contextWindow),
      });
    } catch (error) {
      this.logger.error({ err: error, agentId: input.agentId }, "Failed to stage provider handoff");
      return null;
    }
  }

  /** Merges notes the agent wrote with `update_session_ledger`, anchored to its latest seq. */
  async updateSessionLedger(
    agentId: string,
    update: SessionLedgerUpdateInput,
  ): Promise<LedgerMergeResult> {
    this.requireAgent(agentId);
    return this.continuity.updateNotes({
      agentId,
      update,
      seq: this.timelineStore.getHead(agentId).seq,
    });
  }

  async getSessionLedger(agentId: string): Promise<SessionLedgerView> {
    const agent = this.requireAgent(agentId);
    const rows = this.fetchTimeline(agentId, { direction: "tail", limit: 0 }).rows;
    const [ledger, markdown, record] = await Promise.all([
      this.continuity.read(agentId),
      this.continuity.renderMarkdown({
        agentId,
        cwd: agent.cwd,
        rows,
        title: agent.config.title ?? null,
      }),
      this.registry?.get(agentId),
    ]);
    const enteredAtSeq = record?.providerEnteredAtSeq ?? 0;
    const sessions: SessionLedgerProviderSession[] = Object.entries(record?.providerSessions ?? {})
      .filter(([provider]) => provider !== agent.provider)
      .map(([provider, entry]) => ({
        provider,
        model: entry.model ?? null,
        sessionId: entry.persistence.sessionId,
        turns: entry.turns ?? 0,
        lastUsedAt: entry.lastUsedAt,
        current: false,
      }));
    const previousCurrent = record?.providerSessions?.[agent.provider];
    sessions.unshift({
      provider: agent.provider,
      model: agent.config.model ?? agent.runtimeInfo?.model ?? null,
      sessionId: agent.persistence?.sessionId ?? null,
      turns: (previousCurrent?.turns ?? 0) + countUserTurns(rows, enteredAtSeq),
      lastUsedAt: (agent.lastUserMessageAt ?? agent.updatedAt).toISOString(),
      current: true,
    });
    return {
      agentId,
      markdown,
      goal: ledger.goal ?? null,
      decisions: ledger.decisions,
      openItems: ledger.openItems,
      nextStep: ledger.nextStep,
      handoffs: ledger.handoffs,
      providerSessions: sessions,
      ...durableLedgerFields(ledger),
    };
  }

  async setAgentModel(agentId: string, modelId: string | null): Promise<void> {
    return this.runLifecycleMutation(agentId, () =>
      this.withLiveInteractiveSessionUnlocked(agentId, async (agent) => {
        const normalizedModelId =
          typeof modelId === "string" && modelId.trim().length > 0 ? modelId : null;

        const selection = await agent.session.setModel?.(normalizedModelId);
        await this.drainSessionEvents(agentId);

        // A reset clears the preference even when the provider retains its active model.
        let effectiveModelId = normalizedModelId;
        if (normalizedModelId !== null && selection) effectiveModelId = selection.model;

        agent.config.model = effectiveModelId ?? undefined;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = { ...agent.runtimeInfo, model: effectiveModelId };
        }
        this.refreshSessionPersistence(agent);
        this.touchUpdatedAt(agent);
        this.emitState(agent);
      }),
    );
  }

  async setAgentThinkingOption(
    agentId: string,
    thinkingOptionId: string | null,
  ): Promise<AgentProviderNotice | null> {
    return this.runLifecycleMutation(agentId, () =>
      this.withLiveInteractiveSessionUnlocked(agentId, async (agent) => {
        const normalizedThinkingOptionId =
          typeof thinkingOptionId === "string" && thinkingOptionId.trim().length > 0
            ? thinkingOptionId
            : null;

        let notice: AgentProviderNotice | null = null;
        if (agent.session.setThinkingOption) {
          notice = (await agent.session.setThinkingOption(normalizedThinkingOptionId)) ?? null;
        }
        await this.drainSessionEvents(agentId);

        let effectiveThinkingOptionId = normalizedThinkingOptionId;
        const runtimeInfo = await agent.session.getRuntimeInfo();
        if (runtimeInfo.thinkingOptionId !== undefined) {
          effectiveThinkingOptionId = runtimeInfo.thinkingOptionId;
        }

        agent.config.thinkingOptionId = effectiveThinkingOptionId ?? undefined;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = {
            ...agent.runtimeInfo,
            thinkingOptionId: effectiveThinkingOptionId,
          };
        }
        this.touchUpdatedAt(agent);
        this.emitState(agent);
        return notice;
      }),
    );
  }

  /**
   * Applies an options patch to a running agent (see `AgentSession.applyOptions`). The provider
   * gets each key the patch touches, resolved against the `config.json` defaults, with `null`
   * where nothing is set. The patch and whatever the provider says it ended up with are stored in
   * one step once the provider accepts. Patches to one agent run one at a time, in arrival order.
   */
  async setAgentOptions(agentId: string, requested: ProviderOptionsPatch): Promise<void> {
    return this.runLifecycleMutation(agentId, async () => {
      const agent = await this.ensureInteractiveSessionUnlocked(agentId);
      const patch = this.convertLegacyOptions(agent.provider, requested);
      let ended: ProviderOptionsPatch = {};
      let sent: ProviderOptionsPatch = {};
      if (Object.keys(patch).length > 0) {
        // A provider that cannot apply options to a running agent must not store them either.
        if (!agent.session.applyOptions) {
          throw new ProviderOptionsValidationError(
            agent.provider,
            Object.keys(patch).map((key) => ({
              path: [key],
              message: "cannot change on a running session; it applies when the agent is opened",
            })),
          );
        }
        const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value != null));
        const resolved = this.effectiveOptionsFor(agent.provider, set);
        sent = Object.fromEntries(Object.keys(patch).map((key) => [key, resolved[key] ?? null]));
        ended = (await agent.session.applyOptions(sent)) ?? {};
        // Changes the provider made on its own while applying are older than its final answer.
        await this.drainSessionEvents(agentId);
      }
      this.storeOptionsPatch({ agent, patch: { ...patch, ...ended } });
      this.updateEffectiveOptions({ agent, sent, reported: ended });
      this.touchUpdatedAt(agent);
      this.emitState(agent);
    });
  }

  /** The config as the opened session left it: its own difference from the options it was given. */
  private withOpenedOptions(input: {
    config: AgentSessionConfig;
    session: AgentSession;
  }): AgentSessionConfig {
    const { config } = input;
    const opened = input.session.openOptionsPatch;
    if (!opened || Object.keys(opened).length === 0) return config;
    const own = applyProviderOptionsPatch({ options: config.providerOptions, patch: opened });
    return { ...config, providerOptions: Object.keys(own).length > 0 ? own : undefined };
  }

  private storeOptionsPatch(input: { agent: ManagedAgent; patch: ProviderOptionsPatch }): void {
    const { agent } = input;
    const own = applyProviderOptionsPatch({
      options: agent.config.providerOptions,
      patch: input.patch,
    });
    agent.config.providerOptions = Object.keys(own).length > 0 ? own : undefined;
  }

  /**
   * What the running session has: the options it opened with, moved only by what an apply sent
   * it (defaults merged in, `null` where a removal left nothing) and by what the provider reports
   * back. The agent's own stored options keep only the raw patch.
   */
  private updateEffectiveOptions(input: {
    agent: ManagedAgent;
    sent: ProviderOptionsPatch;
    reported: ProviderOptionsPatch;
  }): void {
    input.agent.effectiveOptions = applyProviderOptionsPatch({
      options: input.agent.effectiveOptions,
      patch: { ...input.sent, ...input.reported },
    });
  }

  /**
   * Defaults merge into what the session was given; what it reports it ended up with comes
   * after, so an option it dropped does not come back from a default.
   */
  private openedEffectiveOptions(input: {
    session: AgentSession;
    launchedOptions: ProviderOptions;
  }): ProviderOptions {
    return applyProviderOptionsPatch({
      options: input.launchedOptions,
      patch: input.session.openOptionsPatch ?? {},
    });
  }

  /** The options a client opens with: its own defaults merged under the agent's. */
  private launchOptionsFor(input: {
    client: AgentClient;
    own: ProviderOptions | undefined;
  }): ProviderOptions {
    return input.client.effectiveOptions?.(input.own) ?? input.own ?? {};
  }

  /**
   * What an agent of this provider runs with, given its own options: the defaults under them.
   * Stored records are read through here before they are reopened, so the legacy conversion
   * runs here too; a record converted on open passes through unchanged. A legacy value the
   * conversion cannot read stays as stored: this describes the record, and opening or changing
   * the agent is what rejects the value.
   */
  effectiveOptionsFor(provider: AgentProvider, own: ProviderOptions | undefined): ProviderOptions {
    const client = this.clients.get(provider);
    const converted = this.convertStoredOptions(provider, own);
    return client ? this.launchOptionsFor({ client, own: converted }) : (converted ?? {});
  }

  private convertStoredOptions(
    provider: AgentProvider,
    own: ProviderOptions | undefined,
  ): ProviderOptions | undefined {
    try {
      return this.convertLegacyOptions(provider, own);
    } catch (error) {
      if (error instanceof MalformedLegacyOptionError) return own;
      throw error;
    }
  }

  // COMPAT(featureValues): added in v0.9.59, remove after 2027-05-25 once legacy callers use options.
  async setAgentFeature(agentId: string, featureId: string, value: unknown): Promise<void> {
    await this.setAgentOptions(agentId, { [featureId]: value });
  }

  async setTitle(agentId: string, title: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return;
    }
    if (
      this.agentsAwaitingInitialSnapshotPersist.has(agent.id) &&
      this.registry &&
      (await this.registry.get(agent.id)) === null
    ) {
      return;
    }
    this.touchUpdatedAt(agent);
    await this.persistSnapshot(agent, { title: normalizedTitle });
    this.emitState(agent, { persist: false });
  }

  async setLabels(agentId: string, labels: Record<string, string>): Promise<void> {
    await this.runLifecycleMutation(agentId, async () => {
      const agent = this.requireAgent(agentId);
      await this.writeLabels(agent.id, labels);
    });
  }

  /** Applies a plugin-metadata patch (null removes a key) and returns the stored result. */
  async setMetadata(
    agentId: string,
    patch: Record<string, JsonValue | null>,
  ): Promise<AgentMetadata> {
    return this.runLifecycleMutation(agentId, async () => {
      const liveAgent = this.agents.get(agentId);
      if (liveAgent) {
        liveAgent.metadata = applyRecordPatch<JsonValue>(liveAgent.metadata, patch);
        this.touchUpdatedAt(liveAgent);
        await this.persistSnapshot(liveAgent);
        this.emitState(liveAgent, { persist: false });
        return liveAgent.metadata;
      }
      const record = await this.writeStoredMetadata(agentId, { metadata: patch });
      if (!record.internal) this.dispatchStoredAgentState(record);
      return record.metadata;
    });
  }

  private async writeLabels(agentId: string, patch: AgentLabelPatch): Promise<WriteLabelsResult> {
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      liveAgent.labels = applyRecordPatch(liveAgent.labels, patch);
      this.touchUpdatedAt(liveAgent);
      await this.persistSnapshot(liveAgent);
      this.emitState(liveAgent, { persist: false });
      const record = this.registry ? await this.registry.get(agentId) : null;
      return { record, live: true };
    }

    const nextRecord = await this.writeStoredMetadata(agentId, { labels: patch });
    return { record: nextRecord, live: false };
  }

  private async writeStoredMetadata(
    agentId: string,
    patch: AgentMetadataPatch,
  ): Promise<StoredAgentRecord> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const nextRecord = {
      ...record,
      ...(patch.title ? { title: patch.title } : {}),
      ...(patch.labels ? { labels: applyRecordPatch(record.labels, patch.labels) } : {}),
      ...(patch.metadata ? { metadata: applyRecordPatch(record.metadata, patch.metadata) } : {}),
      updatedAt: this.nextStoredUpdatedAt(record),
    };
    await registry.upsert(nextRecord);
    return nextRecord;
  }

  async detachAgent(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    return this.runLifecycleMutation(agentId, () => this.detachAgentUnlocked(agentId));
  }

  private async detachAgentUnlocked(agentId: string): Promise<{
    record: StoredAgentRecord;
    live: boolean;
    previousParentAgentId: string | null;
  }> {
    const registry = this.requireRegistry();
    const liveAgent = this.agents.get(agentId);
    if (liveAgent) {
      const previousParentAgentId = getParentAgentIdFromLabels(liveAgent.labels);
      if (!previousParentAgentId) {
        await this.persistSnapshot(liveAgent);
        const record = await registry.get(agentId);
        if (!record) {
          throw new Error(`Agent not found in storage after detach: ${agentId}`);
        }
        return { record, live: true, previousParentAgentId: null };
      }

      const { record } = await this.writeLabels(agentId, detachedAgentLabelPatch(liveAgent.labels));
      if (!record) {
        throw new Error(`Agent not found in storage after detach: ${agentId}`);
      }
      return { record, live: true, previousParentAgentId };
    }

    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }
    const previousParentAgentId = getParentAgentIdFromLabels(record.labels);
    if (!previousParentAgentId) {
      return { record, live: false, previousParentAgentId: null };
    }

    const result = await this.writeLabels(agentId, detachedAgentLabelPatch(record.labels));
    if (!result.record) {
      throw new Error(`Agent not found in storage after detach: ${agentId}`);
    }
    return { record: result.record, live: false, previousParentAgentId };
  }

  notifyAgentState(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.internal) {
      return;
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  async clearAgentAttention(agentId: string): Promise<void> {
    const agent = this.requireAgent(agentId);
    if (agent.attention.requiresAttention) {
      agent.attention = { requiresAttention: false };
      await this.persistSnapshot(agent);
      this.emitState(agent, { persist: false });
    }
  }

  async archiveSnapshot(agentId: string, archivedAt: string): Promise<StoredAgentRecord> {
    const registry = this.requireRegistry();
    const liveAgent = this.getAgent(agentId);
    if (liveAgent) {
      await this.persistSnapshot(liveAgent, {
        internal: liveAgent.internal,
      });
    }

    const record = await registry.get(agentId);
    if (!record) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const nextRecord = buildArchivedAgentRecord(record, { archivedAt });
    await registry.upsert(nextRecord);
    if (!record.archivedAt && !record.internal)
      this.pluginLifecycle?.emit("agent.archive.after", {
        agent: describeHookAgent(nextRecord),
        archivedAt,
      });

    await this.syncNativeArchiveState(record.provider, record.persistence, "archive");

    if (this.agents.has(agentId)) {
      this.notifyAgentState(agentId);
    } else {
      this.discardRetainedAgentState(agentId);
      if (!nextRecord.internal) {
        this.dispatchStoredAgentState(nextRecord);
      }
    }

    await this.fireAgentArchived(agentId);
    await this.cascadeArchiveChildren(agentId);

    return nextRecord;
  }

  async unarchiveSnapshot(
    agentId: string,
    updates?: { workspaceId?: string; labels?: AgentLabelPatch },
  ): Promise<boolean> {
    return this.runLifecycleMutation(agentId, () =>
      this.unarchiveSnapshotUnlocked(agentId, updates),
    );
  }

  private async unarchiveSnapshotUnlocked(
    agentId: string,
    updates?: { workspaceId?: string; labels?: AgentLabelPatch },
  ): Promise<boolean> {
    const registry = this.requireRegistry();
    const record = await registry.get(agentId);
    if (!record || !record.archivedAt) {
      return false;
    }

    // Close and native restore share the lifecycle lane with persisted resume.
    // No new history or interactive runtime can acquire the writer between them.
    if (this.agents.has(agentId)) await this.closeAgentRuntime(agentId);
    await this.syncNativeArchiveState(record.provider, record.persistence, "restore");

    const nextRecord: StoredAgentRecord = {
      ...record,
      ...(updates?.workspaceId ? { workspaceId: updates.workspaceId } : {}),
      ...(updates?.labels ? { labels: applyRecordPatch(record.labels, updates.labels) } : {}),
      archivedAt: null,
      updatedAt: new Date().toISOString(),
    };
    await registry.upsert(nextRecord);

    if (this.getAgent(agentId)) {
      this.notifyAgentState(agentId);
    } else if (!nextRecord.internal) {
      // Same publication archiveSnapshot makes, so a stored-only agent reappears for every client.
      this.dispatchStoredAgentState(nextRecord);
    }
    return true;
  }

  async unarchiveSnapshotByHandle(handle: AgentPersistenceHandle): Promise<void> {
    const registry = this.requireRegistry();
    const records = await registry.list();
    const matched = records.find(
      (record) =>
        record.persistence?.provider === handle.provider &&
        record.persistence?.sessionId === handle.sessionId,
    );
    if (!matched) {
      return;
    }

    await this.unarchiveSnapshot(matched.id);
  }

  async updateAgentMetadata(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void> {
    await this.runLifecycleMutation(agentId, () =>
      this.updateAgentMetadataUnlocked(agentId, updates),
    );
  }

  private async updateAgentMetadataUnlocked(
    agentId: string,
    updates: {
      title?: string;
      labels?: Record<string, string>;
    },
  ): Promise<void> {
    const liveAgent = this.getAgent(agentId);
    if (liveAgent) {
      if (updates.title) {
        await this.setTitle(agentId, updates.title);
      }
      if (updates.labels) {
        await this.writeLabels(agentId, updates.labels);
      }
      return;
    }

    await this.writeStoredMetadata(agentId, updates);
  }

  private async runLifecycleMutation<T>(agentId: string, mutation: () => Promise<T>): Promise<T> {
    // Parent cascade classifies a child inside the same lane used by open-tab
    // label writes, so a received ownership update cannot be overtaken.
    const previous = this.lifecycleMutationTails.get(agentId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(mutation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.lifecycleMutationTails.set(agentId, tail);
    void tail.finally(() => {
      if (this.lifecycleMutationTails.get(agentId) === tail) {
        this.lifecycleMutationTails.delete(agentId);
      }
    });
    return result;
  }

  async runAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const events = this.streamAgent(agentId, prompt, options);
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;
    let canceled = false;

    for await (const event of events) {
      if (event.type === "timeline") {
        timeline.push(event.item);
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(this.formatTurnFailedMessage(event));
      } else if (event.type === "turn_canceled") {
        canceled = true;
      }
    }

    finalText = this.getLastAssistantMessageFromTimeline(timeline) ?? "";

    const agent = this.requireAgent(agentId);
    const sessionId = agent.persistence?.sessionId;
    if (!sessionId) {
      throw new Error(`Agent ${agentId} has no persistence.sessionId after run completed`);
    }
    return {
      sessionId,
      finalText,
      usage,
      timeline,
      canceled,
    };
  }

  /**
   * Try to run a prompt out-of-band — i.e. without allocating a foreground turn
   * and without canceling any active turn. Returns true when the session
   * accepted the prompt as a side-effect command (e.g. /goal pause). Events
   * emitted by the handler flow through dispatchStream so they persist and
   * broadcast like normal timeline events.
   */
  async tryRunOutOfBand(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    onAccepted?: () => void,
  ): Promise<boolean> {
    const agent = await this.findOutOfBandRecipient(agentId);
    if (!agent) return false;
    const handler = agent.session.tryHandleOutOfBand?.(prompt);
    if (!handler) {
      return false;
    }
    this.touchUpdatedAt(agent);
    onAccepted?.();
    if (options?.clientMessageId) {
      this.recordSubmittedPrompt(agent, prompt, options.clientMessageId);
      this.emitState(agent);
    }
    const dispatch = (event: AgentStreamEvent): void => {
      // Persist timeline items so they show up in fetchAgentTimeline; broadcast
      // for live subscribers. Other event types are broadcast only.
      if (event.type === "timeline") {
        this.touchUpdatedAt(agent);
        const row = this.recordTimeline(agent.id, event.item);
        this.dispatchStream(agent.id, event, {
          seq: row.seq,
          epoch: this.timelineStore.getEpoch(agent.id),
          timestamp: row.timestamp,
        });
        return;
      }
      this.dispatchStream(agent.id, event, { timestamp: new Date().toISOString() });
    };
    void this.runForegroundMutation(agentId, async () => {
      try {
        await handler.run({ emit: dispatch });
      } catch (error) {
        const text = error instanceof Error ? error.message : "Out-of-band command failed";
        dispatch({
          type: "timeline",
          provider: agent.provider,
          item: { type: "assistant_message", text: `[Error] ${text}` },
        });
      }
    });
    return true;
  }

  private async findOutOfBandRecipient(agentId: string): Promise<ActiveManagedAgent | null> {
    const live = this.agents.get(agentId);
    const collecting =
      this.collectingRuntimes.has(agentId) || this.inFlightAgentCloses.has(agentId);
    if (live?.session && !collecting && !this.historySessions.has(live.session)) {
      return live;
    }
    if (collecting || !live) {
      await this.waitForAgentClose(agentId);
      const storage = this.requireRegistry();
      // Normal dispatch owns unarchiving. Decline without loading archived history.
      if ((await storage.get(agentId))?.archivedAt) return null;
      await ensureAgentLoaded(agentId, {
        agentManager: this,
        agentStorage: storage,
        logger: this.logger,
      });
    }
    return this.trackAgentRegistrationOperation(
      this.runLifecycleMutation(agentId, async () => {
        const record = await this.registry?.get(agentId);
        // Restore closes any history session. Normal dispatch can reopen the stored agent.
        if (record && (record.archivedAt || !this.agents.get(agentId)?.session)) return null;
        return this.upgradeHistorySessionUnlocked(this.requireSessionAgent(agentId));
      }),
    );
  }

  async appendTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
  ): Promise<{ seq: number; epoch: string }> {
    const agent = this.requireAgent(agentId);
    item = limitAgentTimelineItemContent(item);
    this.touchUpdatedAt(agent);
    const row = this.recordTimeline(agentId, item);
    this.dispatchStream(
      agentId,
      {
        type: "timeline",
        item,
        provider: agent.provider,
      },
      {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agentId),
        timestamp: row.timestamp,
      },
    );
    await this.persistSnapshot(agent);
    return { seq: row.seq, epoch: this.timelineStore.getEpoch(agentId) };
  }

  async emitLiveTimelineItem(agentId: string, item: AgentTimelineItem): Promise<void> {
    const agent = this.requireAgent(agentId);
    this.touchUpdatedAt(agent);
    this.dispatchStream(agentId, {
      type: "timeline",
      item,
      provider: agent.provider,
    });
  }

  private async startPendingForegroundTurn(params: {
    agent: ActiveManagedAgent;
    agentId: string;
    pendingRun: PendingForegroundRun;
    prompt: AgentPromptInput;
    options?: AgentRunOptions;
    promptStart?: ForegroundPromptStart;
  }): Promise<string | null> {
    const { agent, agentId, pendingRun, prompt, options, promptStart } = params;
    try {
      const { enriched, context, handoff, durable } = await this.buildTurnPrompt(agent, prompt);
      this.failover.rememberPrompt(agentId, prompt);
      if (promptStart?.admit?.() === false) {
        this.runs.settleForegroundRun(agentId, pendingRun.token);
        return null;
      }
      const result = await agent.session.startTurn(enriched, options);
      context?.accepted();
      if (handoff) await this.clearPendingHandoff(agentId, handoff.id);
      await this.acceptDurableTurn(agentId, durable, options?.clientMessageId);
      if (pendingRun.settled) {
        throw new Error(`Agent ${agentId} run was canceled before its turn started`);
      }
      return result.turnId;
    } catch (error) {
      if (error instanceof AgentTurnStartCanceledError) {
        if (!pendingRun.settled) {
          if (options?.clientMessageId) {
            this.recordSubmittedPrompt(agent, prompt, options.clientMessageId, {
              messageId: options.clientMessageId,
            });
          }
          await this.handleStreamEvent(agent, {
            type: "turn_canceled",
            provider: agent.provider,
            reason: "interrupted",
          });
          this.finalizeForegroundTurn(agent);
          this.runs.settleForegroundRun(agentId, pendingRun.token);
        }
        return null;
      }
      if (pendingRun.settled) {
        throw error;
      }
      if (isStaleProviderSessionError(error)) {
        this.runs.settleForegroundStart(pendingRun, {
          status: "failed",
          error: error.message,
          stale: true,
        });
        agent.pendingReplacement = false;
        if (!agent.activeForegroundTurnId) agent.lifecycle = "idle";
        this.runs.settleForegroundRun(agentId, pendingRun.token);
        throw error;
      }
      agent.pendingReplacement = false;
      const errorMsg = error instanceof Error ? error.message : "Failed to start turn";
      this.runs.settleForegroundStart(pendingRun, { status: "failed", error: errorMsg });
      try {
        // A terminal rejection belongs after the submitted prompt even though no provider turn exists.
        if (options?.clientMessageId) {
          this.recordSubmittedPrompt(agent, prompt, options.clientMessageId, {
            messageId: options.clientMessageId,
          });
        }
        await this.handleStreamEvent(agent, {
          type: "turn_failed",
          provider: agent.provider,
          error: errorMsg,
        });
        this.finalizeForegroundTurn(agent);
      } finally {
        // A steer waiting on this start is released only once the run is cleared.
        this.runs.settleForegroundRun(agentId, pendingRun.token);
      }
      throw error;
    }
  }

  private async buildTurnPrompt(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
  ): Promise<{
    enriched: AgentPromptInput;
    context: { text: string; accepted: () => void } | null | undefined;
    handoff: { id: string; text: string } | null;
    durable: Awaited<ReturnType<DurableContext["prepareTurn"]>>;
  }> {
    const context = await this.turnContextProvider?.(agent.id);
    const handoff = await this.preparePendingHandoff(agent);
    const durable = await this.prepareDurableTurn(agent, prompt);
    const enriched = prependTurnContext(
      prependTurnContext(durable?.prompt ?? prompt, handoff?.text),
      context?.text,
    );
    return { enriched, context, handoff, durable };
  }

  private async acceptDurableTurn(
    agentId: string,
    durable: Awaited<ReturnType<DurableContext["prepareTurn"]>>,
    messageId: string | undefined,
  ): Promise<void> {
    if (!durable) return;
    try {
      await durable.accepted({ messageId: messageId ?? null });
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Durable context record failed");
    }
  }

  /** Spec 42 §2–§3 additions to this turn's message. Durable-context trouble never blocks a turn. */
  private async prepareDurableTurn(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
  ): Promise<Awaited<ReturnType<DurableContext["prepareTurn"]>>> {
    try {
      return await this.durable.prepareTurn(this.durableView(agent), prompt);
    } catch (error) {
      this.logger.warn({ err: error, agentId: agent.id }, "Durable context unavailable for turn");
      return null;
    }
  }

  private durableView(agent: ManagedAgent) {
    return {
      id: agent.id,
      provider: agent.provider,
      cwd: agent.cwd,
      sessionId: agent.persistence?.sessionId ?? null,
      lastUsage: agent.lastUsage,
    };
  }

  /**
   * The handoff a provider switch staged for this turn, if any. Also records the ledger's git base
   * the first time an agent runs. Ledger trouble never blocks a turn.
   */
  private async preparePendingHandoff(
    agent: ActiveManagedAgent,
  ): Promise<{ id: string; text: string } | null> {
    try {
      await this.continuity.ensureGitBase(agent.id, agent.cwd);
      return await this.continuity.peekPendingHandoff(agent.id);
    } catch (error) {
      this.logger.warn({ err: error, agentId: agent.id }, "Session ledger unavailable for turn");
      return null;
    }
  }

  private async clearPendingHandoff(agentId: string, handoffId: string): Promise<void> {
    try {
      await this.continuity.clearPendingHandoff(agentId, handoffId);
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Failed to clear staged handoff");
    }
  }

  private async ensureInteractiveSession(agentId: string): Promise<ActiveManagedAgent> {
    const agent = this.requireSessionAgent(agentId);
    if (this.historySessions.has(agent.session))
      await this.trackAgentRegistrationOperation(
        this.runLifecycleMutation(agentId, () => this.ensureInteractiveSessionUnlocked(agentId)),
      );
    return this.requireSessionAgent(agentId);
  }

  private async ensureInteractiveSessionUnlocked(agentId: string): Promise<ActiveManagedAgent> {
    const record = await this.registry?.get(agentId);
    if (record?.archivedAt) throw new Error(`Agent is archived: ${agentId}`);
    return this.upgradeHistorySessionUnlocked(this.requireSessionAgent(agentId));
  }

  private async upgradeHistorySessionUnlocked(
    agent: ActiveManagedAgent,
  ): Promise<ActiveManagedAgent> {
    if (!this.historySessions.has(agent.session)) return agent;
    // Reload validates the directory before releasing readable history.
    await this.reloadAgentSessionInternal(agent.id);
    return this.requireSessionAgent(agent.id);
  }

  /** Inside the agent's lane: transparently reopens a retired plugin session before applying config. */
  private async withLiveInteractiveSessionUnlocked<T>(
    agentId: string,
    operation: (agent: ActiveManagedAgent) => Promise<T>,
  ): Promise<T> {
    const pendingCancellation = this.pendingCancellations.get(agentId);
    if (pendingCancellation) {
      await this.waitWithTimeout({
        operation: pendingCancellation.then(
          () => undefined,
          () => undefined,
        ),
        timeoutMs: this.rescueTimeouts.interruptSessionMs,
      });
    }
    const agent = await this.ensureInteractiveSessionUnlocked(agentId);
    try {
      return await operation(agent);
    } catch (error) {
      if (!isStaleProviderSessionError(error)) throw error;
      await this.runs.getPendingRun(agentId)?.settledPromise.catch(() => undefined);
      if (this.hasInFlightRun(agentId)) throw error;
      await this.trackAgentRegistrationOperation(this.reloadAgentSessionInternal(agentId));
      return await operation(this.requireSessionAgent(agentId));
    }
  }

  private async *streamAfterHistoryLoad(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): AsyncGenerator<AgentStreamEvent> {
    await this.ensureInteractiveSession(agentId);
    yield* this.streamAgent(agentId, prompt, options, promptStart);
  }

  private async *streamAfterRuntimeCollection(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): AsyncGenerator<AgentStreamEvent> {
    await this.waitForAgentClose(agentId);
    await ensureAgentLoaded(agentId, {
      agentManager: this,
      agentStorage: this.requireRegistry(),
      logger: this.logger,
    });
    yield* this.streamAgent(agentId, prompt, options, promptStart);
  }

  streamAgent(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): AsyncGenerator<AgentStreamEvent> {
    if (this.collectingRuntimes.has(agentId) || (!this.agents.has(agentId) && this.registry))
      return this.streamAfterRuntimeCollection(agentId, prompt, options, promptStart);
    const existingAgent = this.requireSessionAgent(agentId);
    if (this.historySessions.has(existingAgent.session))
      return this.streamAfterHistoryLoad(agentId, prompt, options, promptStart);
    this.logger.trace(
      {
        agentId,
        provider: existingAgent.provider,
        sessionId: existingAgent.persistence?.sessionId ?? undefined,
        turnId: existingAgent.activeForegroundTurnId ?? undefined,
        lifecycle: existingAgent.lifecycle,
        activeForegroundTurnId: existingAgent.activeForegroundTurnId,
        hasTrackedRun: this.runs.hasRun(agentId),
        promptType: typeof prompt === "string" ? "string" : "structured",
        hasRunOptions: Boolean(options),
      },
      "agent.manager.stream.request",
    );
    if (existingAgent.activeForegroundTurnId || this.runs.hasRun(agentId)) {
      this.logger.trace(
        {
          agentId,
          provider: existingAgent.provider,
          sessionId: existingAgent.persistence?.sessionId ?? undefined,
          turnId: existingAgent.activeForegroundTurnId ?? undefined,
          lifecycle: existingAgent.lifecycle,
          hasTrackedRun: this.runs.hasRun(agentId),
        },
        "agent.manager.stream.reject",
      );
      throw new Error(`Agent ${agentId} already has an active run`);
    }

    const agent = existingAgent;
    const isReplacement = agent.pendingReplacement;
    agent.lastError = undefined;

    const pendingRun = this.runs.createPendingRun(agentId);
    promptStart?.bind(pendingRun);

    const streamForwarder = async function* streamForwarder(this: AgentManager) {
      let turnId: string | null;
      let turnStream: ReturnType<AgentRunState["createTurnStream"]> | null = null;
      turnId = await this.startPendingForegroundTurn({
        agent,
        agentId,
        pendingRun,
        prompt,
        options,
        promptStart,
      });
      if (turnId === null) {
        const canceledEvent: AgentStreamEvent = {
          type: "turn_canceled",
          provider: agent.provider,
          reason: "interrupted",
        };
        yield canceledEvent;
        return;
      }

      if (isReplacement) {
        agent.pendingReplacement = false;
      }
      const turnStartedAt = new Date();
      this.runs.settleForegroundStart(pendingRun, { status: "started", turnId });
      agent.activeForegroundTurnId = turnId;
      this.openActiveTurn(agent, turnId, turnStartedAt);
      agent.attention = { requiresAttention: false };
      agent.lifecycle = "running";
      this.touchUpdatedAt(agent);
      // AgentManager owns the accepted-turn boundary. Publish liveness before the canonical
      // prompt so clients can retire optimistic activity without painting an idle frame.
      // The provider's duplicate start for this turn is suppressed at the ingestion boundary.
      this.dispatchStream(
        agent.id,
        { type: "turn_started", provider: agent.provider, turnId },
        { timestamp: turnStartedAt.toISOString() },
      );
      const stagedSubmittedPromptEcho = options?.clientMessageId
        ? pendingRun.stagedEvents.find(
            (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
              event.type === "timeline" &&
              event.item.type === "user_message" &&
              event.item.clientMessageId === options.clientMessageId,
          )
        : undefined;
      if (options?.clientMessageId) {
        this.recordSubmittedPrompt(agent, prompt, options.clientMessageId, {
          messageId: options.clientMessageId,
          turnId,
          providerMessageId:
            stagedSubmittedPromptEcho?.item.type === "user_message"
              ? stagedSubmittedPromptEcho.item.messageId
              : undefined,
        });
      }
      for (const stagedEvent of pendingRun.stagedEvents.splice(0)) {
        const isAcceptedTurnStart =
          stagedEvent.type === "turn_started" && getAgentStreamEventTurnId(stagedEvent) === turnId;
        if (isAcceptedTurnStart || stagedEvent === stagedSubmittedPromptEcho) {
          continue;
        }
        this.enqueueSessionEvent(agent.id, stagedEvent);
      }
      this.emitState(agent);
      this.logger.trace(
        {
          agentId,
          provider: agent.provider,
          sessionId: agent.persistence?.sessionId ?? undefined,
          turnId,
          lifecycle: agent.lifecycle,
          activeForegroundTurnId: agent.activeForegroundTurnId,
        },
        "agent.manager.stream.start",
      );

      turnStream = this.runs.createTurnStream(turnId);
      this.runs.addWaiter(agent, turnStream.waiter);

      try {
        const acceptedTurnStartedEvent: AgentStreamEvent = {
          type: "turn_started",
          provider: agent.provider,
          turnId,
        };
        yield acceptedTurnStartedEvent;
        for await (const event of turnStream.events(isTurnTerminalEvent)) {
          yield event;
        }
      } finally {
        if (turnStream) {
          this.runs.deleteWaiter(agent, turnStream.waiter);
        }
        this.runs.settleForegroundRun(agentId, pendingRun.token);
        if (!agent.activeForegroundTurnId) {
          await this.refreshRuntimeInfo(agent);
        }
      }
    }.call(this);

    return streamForwarder;
  }

  private finalizeForegroundTurn(agent: ActiveManagedAgent, turnId?: string): void {
    const mutableAgent = agent;
    if (turnId) {
      this.runs.rememberFinalizedTurn(mutableAgent, turnId);
    }
    mutableAgent.activeForegroundTurnId = null;
    this.applyActiveTurnTerminal(mutableAgent, turnId);
    const terminalError = mutableAgent.lastError;
    const shouldHoldBusyForReplacement = mutableAgent.pendingReplacement && !terminalError;
    let nextLifecycle: "running" | "error" | "idle";
    if (shouldHoldBusyForReplacement) {
      nextLifecycle = "running";
    } else if (terminalError) {
      nextLifecycle = "error";
    } else {
      nextLifecycle = "idle";
    }
    mutableAgent.lifecycle = nextLifecycle;
    const persistenceHandle =
      mutableAgent.session.describePersistence() ??
      (mutableAgent.runtimeInfo?.sessionId
        ? { provider: mutableAgent.provider, sessionId: mutableAgent.runtimeInfo.sessionId }
        : null);
    if (persistenceHandle) {
      mutableAgent.persistence = normalizePersistenceForConfig(
        persistenceHandle,
        mutableAgent.config,
      );
    }
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: mutableAgent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: mutableAgent.lifecycle,
        terminalError,
        pendingReplacement: mutableAgent.pendingReplacement,
      },
      "agent.manager.finalize",
    );
    if (!shouldHoldBusyForReplacement) {
      this.touchUpdatedAt(mutableAgent);
      this.emitState(mutableAgent);
    }
  }

  private openActiveTurn(agent: ActiveManagedAgent, turnId: string, startedAt: Date): void {
    agent.activeTurnId = turnId;
    agent.activeTurnStartedAt = startedAt;
  }

  private applyActiveTurnTerminal(
    agent: ActiveManagedAgent,
    turnId?: string,
    fromHistory = false,
  ): ActiveTurnTerminalDisposition {
    if (fromHistory) return "stale";
    if (!agent.activeTurnId) return "untracked";
    if (turnId && agent.activeTurnId !== turnId) return "stale";
    agent.activeTurnId = null;
    agent.activeTurnStartedAt = null;
    return "closed_current";
  }

  async replaceAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    this.requireSessionAgent(agentId);
    return this.replaceRunInForegroundLane(agentId, prompt, options, promptStart);
  }

  async steerAgentRun(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentSteerOptions,
  ): Promise<SteerResult> {
    const agent = this.requireSessionAgent(agentId);
    const expectedTurnId = agent.activeForegroundTurnId ?? agent.activeTurnId;
    if (!expectedTurnId || !agent.session.steerActiveTurn) {
      return { status: "unavailable" };
    }
    const result = await this.runSteerAdmission(agent, expectedTurnId, async () => {
      const admission = await agent.session.steerActiveTurn!(prompt, {
        ...options,
        expectedTurnId,
      });
      if (admission.status === "accepted") {
        await this.recordAcceptedSteer(
          agent,
          prompt,
          options?.clientMessageId,
          expectedTurnId,
          admission.providerMessageId,
        );
      }
      return admission;
    });
    // An unavailable answer is only safe to fall back from while this admission
    // still owns the active turn. Never let an A admission replace a later B.
    if (result.status === "unavailable" && agent.activeTurnId !== expectedTurnId) {
      throw new AgentTurnChangedError("Active turn changed before steering could be delivered");
    }
    return result;
  }

  async steerOrReplaceActiveTurn(
    agentId: string,
    prompt: AgentPromptInput,
    options?: AgentSteerOptions,
    promptStart?: ForegroundPromptStart,
  ): Promise<ActiveTurnSteerDispatchResult> {
    // A turn that is still starting has no id to steer yet. Replacing it would drop its
    // prompt, so wait until it is accepted (or fails) and steer the turn it became.
    await this.runs.waitForForegroundStart(agentId);
    const agent = this.requireSessionAgent(agentId);
    const expectedTurnId = agent.activeForegroundTurnId ?? agent.activeTurnId;
    if (!expectedTurnId) {
      return { status: "inactive" };
    }

    const result = agent.session.steerActiveTurn
      ? await this.runSteerAdmission(agent, expectedTurnId, async () => {
          const admission = await agent.session.steerActiveTurn!(prompt, {
            ...options,
            expectedTurnId,
          });
          if (admission.status === "accepted") {
            await this.recordAcceptedSteer(
              agent,
              prompt,
              options?.clientMessageId,
              expectedTurnId,
              admission.providerMessageId,
            );
          }
          return admission;
        })
      : { status: "unavailable" as const };
    if (result.status === "accepted") {
      return { status: "steered" };
    }

    // Providers without autonomous steering keep their existing dispatch behavior. The shared
    // admission may recognize the turn, but only an accepted steer can own it without replacement.
    if (agent.activeForegroundTurnId === null && agent.activeTurnId === expectedTurnId) {
      return { status: "inactive" };
    }

    await this.beforeSteerUnavailableFallback?.({ agentId, expectedTurnId });
    this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
    return {
      status: "replaced",
      iterator: await this.replaceAdmittedForegroundTurn(
        agent,
        expectedTurnId,
        prompt,
        stripSteerOptions(options),
        promptStart,
      ),
    };
  }

  private assertSteerAdmissionOwnsTurn(agent: ActiveManagedAgent, expectedTurnId: string): void {
    if (agent.activeTurnId !== expectedTurnId) {
      throw new AgentTurnChangedError("Active turn changed before steering could be delivered");
    }
  }

  private async runSteerAdmission<T>(
    agent: ActiveManagedAgent,
    expectedTurnId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.runForegroundMutation(agent.id, async () => {
      await this.drainSessionEvents(agent.id);
      this.agentStreamCoalescer.flushFor(agent.id);
      this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
      const barrier: SteerEventBarrier = { events: [] };
      this.steerEventBarriers.set(agent.id, barrier);
      try {
        return await operation();
      } finally {
        if (this.steerEventBarriers.get(agent.id) === barrier) {
          this.steerEventBarriers.delete(agent.id);
        }
        for (const event of barrier.events) {
          this.enqueueSessionEvent(agent.id, event);
        }
        await this.drainSessionEvents(agent.id);
      }
    });
  }

  private async runForegroundMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    return this.runQueuedMutation(this.foregroundMutationTails, agentId, operation);
  }

  private async runQueuedMutation<T>(
    tails: Map<string, Promise<void>>,
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = tails.get(agentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(agentId, tail);
    try {
      return await run;
    } finally {
      if (tails.get(agentId) === tail) {
        tails.delete(agentId);
      }
    }
  }

  private async replaceAdmittedForegroundTurn(
    agent: ActiveManagedAgent,
    expectedTurnId: string,
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
    promptStart?: ForegroundPromptStart,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    this.assertSteerAdmissionOwnsTurn(agent, expectedTurnId);
    return this.replaceRunInForegroundLane(agent.id, prompt, options, promptStart, (live) =>
      this.assertSteerAdmissionOwnsTurn(live, expectedTurnId),
    );
  }

  /**
   * Cancels the current run and reserves its replacement in one foreground mutation, so a
   * concurrent replacement or Stop cannot land between the cancel and the new run's start.
   */
  private async replaceRunInForegroundLane(
    agentId: string,
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
    promptStart?: ForegroundPromptStart,
    assertAdmission?: (agent: ActiveManagedAgent) => void,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    // Replacements queue in arrival order; each one holds the foreground lane only while
    // it cancels and reserves, so Stop is never stuck behind a replacement that is waiting.
    return this.runQueuedMutation(this.replacementMutationTails, agentId, () =>
      this.replaceRunWhenAdmitted(agentId, prompt, options, promptStart, assertAdmission),
    );
  }

  private async replaceRunWhenAdmitted(
    agentId: string,
    prompt: AgentPromptInput,
    options: AgentRunOptions | undefined,
    promptStart?: ForegroundPromptStart,
    assertAdmission?: (agent: ActiveManagedAgent) => void,
  ): Promise<AsyncGenerator<AgentStreamEvent>> {
    let stalledStart: PendingForegroundRun | null = null;
    for (;;) {
      const admission = await this.runForegroundMutation(agentId, async () => {
        // Resolve the agent inside the lane: a reload while this send waited replaces it.
        const agent = this.requireSessionAgent(agentId);
        // A run that is still starting has no turn to interrupt yet. Canceling it would drop
        // its prompt, so wait for it outside the lane, where Stop can still reach it. A start
        // that outlasts the rescue timeout is canceled like any other run.
        const starting = this.runs.getPendingRun(agent.id);
        if (starting && starting.start.status !== "started" && starting !== stalledStart) {
          return { status: "starting" as const, run: starting };
        }
        assertAdmission?.(agent);
        if (!this.hasInFlightRun(agent.id)) {
          return {
            status: "reserved" as const,
            iterator: this.streamAgent(agent.id, prompt, options, promptStart),
          };
        }
        agent.pendingReplacement = true;
        agent.lifecycle = "running";
        this.touchUpdatedAt(agent);
        this.emitState(agent);
        try {
          const result = await this.cancelAgentRunNow(agent.id, "replace");
          if (result.status === "refused") {
            throw new AgentRunCancellationError(agent.id, "replace");
          }
          return {
            status: "reserved" as const,
            iterator: this.streamAgent(agent.id, prompt, options, promptStart),
          };
        } catch (error) {
          agent.pendingReplacement = false;
          throw error;
        }
      });
      if (admission.status === "reserved") {
        return admission.iterator;
      }
      const started = await this.waitWithTimeout({
        operation: Promise.race([admission.run.turnStartedPromise, admission.run.settledPromise]),
        timeoutMs: this.rescueTimeouts.interruptSessionMs,
      });
      if (started === "timed_out") {
        stalledStart = admission.run;
      }
    }
  }

  private async recordAcceptedSteer(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
    clientMessageId: string | undefined,
    expectedTurnId: string,
    providerMessageId: string | undefined,
  ): Promise<void> {
    if (!clientMessageId) {
      return;
    }
    this.recordSubmittedPrompt(agent, prompt, clientMessageId, {
      messageId: clientMessageId,
      turnId: expectedTurnId,
      ...(providerMessageId ? { providerMessageId } : {}),
    });
    this.emitState(agent);
  }

  async waitForAgentRunStart(agentId: string, options?: WaitForAgentStartOptions): Promise<void> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingRun = this.runs.getPendingRun(agentId);
    if (
      (snapshot.lifecycle === "running" || pendingRun?.start.status === "started") &&
      !snapshot.pendingReplacement
    ) {
      return;
    }

    if (!snapshot.activeForegroundTurnId && !pendingRun && !snapshot.pendingReplacement) {
      throw new Error(`Agent ${agentId} has no pending run`);
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent_start aborted");
    }

    await new Promise<void>((resolvePromise, reject) => {
      if (options?.signal?.aborted) {
        reject(createAbortError(options.signal, "wait_for_agent_start aborted"));
        return;
      }

      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // ignore cleanup errors
          }
          unsubscribe = null;
        }
        if (abortHandler && options?.signal) {
          try {
            options.signal.removeEventListener("abort", abortHandler);
          } catch {
            // ignore cleanup errors
          }
          abortHandler = null;
        }
      };

      const finishOk = () => {
        cleanup();
        resolvePromise();
      };

      const finishErr = (error: unknown) => {
        cleanup();
        reject(error);
      };

      if (options?.signal) {
        abortHandler = () =>
          finishErr(createAbortError(options.signal, "wait_for_agent_start aborted"));
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      const checkCurrentState = () => {
        const current = this.getAgent(agentId);
        if (!current) {
          finishErr(new Error(`Agent ${agentId} not found`));
          return true;
        }

        const currentPendingRun = this.runs.getPendingRun(agentId);
        if (
          (current.lifecycle === "running" || currentPendingRun?.start.status === "started") &&
          !current.pendingReplacement
        ) {
          finishOk();
          return true;
        }

        if (currentPendingRun?.start.status === "failed") {
          finishErr(new Error(currentPendingRun.start.error));
          return true;
        }

        if (current.lifecycle === "error" && !currentPendingRun) {
          finishErr(new Error(current.lastError ?? `Agent ${agentId} failed to start`));
          return true;
        }

        if (!currentPendingRun && !current.activeForegroundTurnId && !current.pendingReplacement) {
          finishErr(new Error(`Agent ${agentId} run finished before starting`));
          return true;
        }

        return false;
      };

      unsubscribe = this.subscribe(
        (event) => {
          if (event.type !== "agent_state" || event.agent.id !== agentId) {
            return;
          }
          checkCurrentState();
        },
        { agentId, replayState: false },
      );

      checkCurrentState();
    });
  }

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    const agent = this.requireAgent(agentId);

    // Intercept host tool permissions before forwarding to agent session.
    const hostResolve = this.hostToolPermissions.get(requestId);
    if (hostResolve) {
      this.hostToolPermissions.delete(requestId);
      agent.pendingPermissions.delete(requestId);
      this.dispatchStream(agentId, {
        type: "permission_resolved",
        provider: agent.session.provider,
        requestId,
        resolution: response,
      });
      this.emitState(agent);
      hostResolve(response);
      return;
    }

    agent.inFlightPermissionResponses.add(requestId);

    try {
      let result: AgentPermissionResult | void;
      try {
        result = await agent.session.respondToPermission(requestId, response);
      } catch (error) {
        if (!(error instanceof PermissionNotPendingError)) throw error;
        await this.dropUnanswerablePermission(agent, requestId, error);
        return;
      }
      agent.pendingPermissions.delete(requestId);

      try {
        await this.refreshSessionState(agent);
      } catch {
        // Ignore refresh errors - state sync after permission approval is best effort.
      }

      this.touchUpdatedAt(agent);
      await this.persistSnapshot(agent);
      this.emitState(agent);

      const bufferedResolution = agent.bufferedPermissionResolutions.get(requestId);
      if (bufferedResolution) {
        agent.bufferedPermissionResolutions.delete(requestId);
        this.dispatchStream(agent.id, bufferedResolution, { timestamp: new Date().toISOString() });
      }

      return result;
    } finally {
      agent.inFlightPermissionResponses.delete(requestId);
      agent.bufferedPermissionResolutions.delete(requestId);
    }
  }

  /**
   * The provider no longer has the request (answered elsewhere, cancelled, or lost with a
   * restarted provider server). Drop the card everywhere and tell clients it expired; a retry
   * could never succeed.
   */
  private async dropUnanswerablePermission(
    agent: ActiveManagedAgent,
    requestId: string,
    error: PermissionNotPendingError,
  ): Promise<void> {
    this.logger.info(
      { agentId: agent.id, requestId, err: error.cause },
      "Dropped a permission request the provider no longer has",
    );
    agent.pendingPermissions.delete(requestId);
    agent.inFlightPermissionResponses.delete(requestId);
    agent.bufferedPermissionResolutions.delete(requestId);
    this.dispatchStream(agent.id, {
      type: "permission_resolved",
      provider: agent.session.provider,
      requestId,
      resolution: { behavior: "deny", message: error.message },
      expired: true,
    });
    this.touchUpdatedAt(agent);
    await this.persistSnapshot(agent);
    this.emitState(agent);
  }

  async requestHostToolPermission(
    agentId: string,
    request: {
      name: string;
      kind: string;
      title?: string;
      description?: string;
      input?: Record<string, unknown>;
      actions?: AgentPermissionAction[];
      /** Host settings changes the user decides themselves, even in an unattended mode. */
      alwaysAsk?: boolean;
    },
  ): Promise<AgentPermissionResponse> {
    const agent = this.requireAgent(agentId);
    // Spec 33.7 ("Chế độ bypass được tôn trọng"): an unattended provider mode is the
    // operator's standing approval, so every JAgentDesk permission card is auto-approved —
    // no pending card, no permission_requested event. Attended modes keep the card.
    if (!request.alwaysAsk && this.isAgentSessionUnattended(agent)) {
      this.logger.debug(
        { agentId, tool: request.name, modeId: agent.currentModeId },
        "Auto-approved host tool permission: agent is in an unattended provider mode",
      );
      return { behavior: "allow" };
    }
    const id = randomUUID();
    const permissionRequest: AgentPermissionRequest = {
      id,
      provider: agent.session.provider,
      name: request.name,
      kind: "tool",
      title: request.title,
      description: request.description,
      input: request.input as Record<string, unknown>,
      ...(request.actions ? { actions: request.actions } : {}),
    };

    const promise = new Promise<AgentPermissionResponse>((resolvePermission) => {
      this.hostToolPermissions.set(id, resolvePermission);
    });

    agent.pendingPermissions.set(id, permissionRequest);
    if (!agent.internal) {
      this.broadcastAgentAttention(agent, "permission");
    }
    this.dispatchStream(agentId, {
      type: "permission_requested",
      provider: agent.session.provider,
      request: permissionRequest,
    });
    this.emitState(agent);

    return promise;
  }

  /**
   * Whether the agent's current provider mode is unattended (spec 33.7). Resolved per
   * request through the provider hook (`isCreateConfigUnattended`), so a mode switched
   * at runtime is respected on the next card. Providers without the hook fall back to
   * the shared default, which reads `isUnattended` off the available mode definitions.
   */
  private isAgentSessionUnattended(agent: LiveManagedAgent): boolean {
    const client = this.clients.get(agent.provider);
    const isCreateConfigUnattended =
      client?.isCreateConfigUnattended ?? isDefaultAgentCreateConfigUnattended;
    try {
      return isCreateConfigUnattended({
        modeId: agent.currentModeId,
        config: agent.config,
        controls: agent.controls,
        availableModes: agent.availableModes,
      });
    } catch (error) {
      this.logger.warn(
        { err: error, agentId: agent.id },
        "Failed to resolve unattended mode; showing the permission card",
      );
      return false;
    }
  }

  cancelAgentRun(agentId: string): Promise<AgentRunCancellationResult> {
    return this.cancelRun(agentId, "stop");
  }

  private async cancelRun(
    agentId: string,
    cause: RunCancellationCause,
  ): Promise<AgentRunCancellationResult> {
    const cancellation = this.runForegroundMutation(agentId, () => {
      this.requireSessionAgent(agentId).pendingReplacement = false;
      return this.cancelAgentRunNow(agentId, cause);
    });
    this.pendingCancellations.set(agentId, cancellation);
    try {
      return await cancellation;
    } finally {
      if (this.pendingCancellations.get(agentId) === cancellation)
        this.pendingCancellations.delete(agentId);
    }
  }

  private async cancelAgentRunNow(
    agentId: string,
    cause: RunCancellationCause,
  ): Promise<AgentRunCancellationResult> {
    const agent = this.requireSessionAgent(agentId);
    const run =
      this.runs.getRun(agentId) ??
      (agent.lifecycle === "running" ? this.runs.trackAutonomousRun(agentId, null) : null);
    if (!run) {
      return { status: "not_running" };
    }
    if (cause === "stop") {
      for (const listener of this.stopListeners) listener(agentId);
    }

    const interruptAcknowledged = await this.interruptSession(agent.session, agentId);
    const settlement = await this.waitWithTimeout({
      operation: run.settledPromise,
      timeoutMs: interruptAcknowledged
        ? INTERRUPT_SESSION_TIMEOUT_MS
        : this.rescueTimeouts.interruptSessionMs,
    });

    if (!interruptAcknowledged) {
      return { status: settlement === "completed" ? "settled" : "refused" };
    }

    const runTurnId = this.runs.getTurnId(agentId);
    if (settlement === "timed_out" && runTurnId) {
      this.logger.warn(
        { agentId, turnId: runTurnId, kind: run.kind },
        "cancelAgentRun: acknowledged turn still active after timeout, force-canceling",
      );
      await this.dispatchSessionEvent(agent, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
        turnId: runTurnId,
      });
      await run.settledPromise;
    } else if (settlement === "timed_out" && run.kind === "foreground") {
      this.logger.warn(
        { agentId, kind: run.kind },
        "cancelAgentRun: acknowledged pending turn still active after timeout, clearing it",
      );
      this.runs.settleForegroundRun(agentId, run.token);
      if (!agent.pendingReplacement) {
        agent.lifecycle = "idle";
        this.touchUpdatedAt(agent);
        this.emitState(agent);
      }
    } else if (settlement === "timed_out" && run.kind === "autonomous") {
      this.logger.warn(
        { agentId, kind: run.kind },
        "cancelAgentRun: acknowledged turn still active after timeout, force-canceling",
      );
      await this.dispatchSessionEvent(agent, {
        type: "turn_canceled",
        provider: agent.provider,
        reason: "interrupted",
      });
    }

    if (agent.pendingPermissions.size > 0) {
      this.resolvePendingPermissionsForAgent(agent, agent.provider, undefined, "Interrupted");
      this.touchUpdatedAt(agent);
      this.emitState(agent);
    }
    return { status: "settled" };
  }

  private async cancelAgentRunBefore(agentId: string, action: "reload" | "rewind"): Promise<void> {
    const result = await this.cancelRun(agentId, action);
    if (result.status === "refused") {
      throw new AgentRunCancellationError(agentId, action);
    }
  }

  private async interruptSession(session: AgentSession, agentId: string): Promise<boolean> {
    try {
      const result = await this.waitWithTimeout({
        operation: session.interrupt(),
        timeoutMs: this.rescueTimeouts.interruptSessionMs,
        onLateError: (error) => {
          this.logger.warn(
            { err: error, agentId },
            "Session interrupt failed after timeout during cancel",
          );
        },
      });

      if (result === "timed_out") {
        this.logger.warn(
          { agentId, timeoutMs: this.rescueTimeouts.interruptSessionMs },
          "Timed out interrupting session during cancel",
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error({ err: error, agentId }, "Failed to interrupt session");
      return false;
    }
  }

  getPendingPermissions(agentId: string): AgentPermissionRequest[] {
    const agent = this.requireSessionAgent(agentId);
    return Array.from(agent.pendingPermissions.values());
  }

  private peekPendingPermission(agent: ManagedAgent): AgentPermissionRequest | null {
    const iterator = agent.pendingPermissions.values().next();
    return iterator.done ? null : iterator.value;
  }

  /**
   * Hydrates the runtime timeline from provider history. No-ops if already hydrated.
   */
  async hydrateTimelineFromProvider(
    agentId: string,
    options?: HydrateTimelineOptions,
  ): Promise<void> {
    const agent = this.requireSessionAgent(agentId);
    await this.hydrateTimelineFromLegacyProviderHistory(agent, options);
  }

  /**
   * Fast fork (spec 41 §6, ADR-0058): the provider copies its own conversation up to `boundary`
   * and a new agent resumes that copy. Nothing is replayed into a prompt and the parent's
   * timeline is not copied: the fork's first row references it.
   */
  async forkAgent(
    parentId: string,
    options: {
      boundary: { epoch: string; seq: number } | null;
      agentId?: string;
      title?: string | null;
    },
  ): Promise<ManagedAgent> {
    const parent = this.requireSessionAgent(parentId);
    if (!parent.session.forkConversation) throw new NativeForkUnavailableError(parent.provider);
    const beforeUserMessageId = this.forkAnchorUserMessageId(parentId, options.boundary);
    const handle = await parent.session.forkConversation({ beforeUserMessageId });
    const storedParent = this.registry ? await this.registry.get(parentId) : null;
    const parentTitle = (storedParent?.title ?? parent.config.title)?.trim() || null;
    const agent = await this.resumeAgentFromPersistence(
      handle,
      { cwd: parent.cwd, title: options.title ?? (parentTitle ? `Fork: ${parentTitle}` : null) },
      options.agentId,
      { workspaceId: parent.workspaceId, historyPrimed: true },
    );
    const origin: AgentForkOrigin = {
      parentAgentId: parentId,
      parentTitle,
      provider: parent.provider,
      // A fork of the whole conversation still pins where it ended, so the parent's later turns
      // stay out of the fork's reference.
      boundary: options.boundary ?? this.timelineTail(parentId),
    };
    // Also a durable row, so a reload never hydrates the forked transcript into this timeline.
    await this.appendTimelineItem(agent.id, {
      type: "plugin",
      id: FORK_ORIGIN_ITEM_KIND,
      pluginId: FORK_ORIGIN_PLUGIN_ID,
      kind: FORK_ORIGIN_ITEM_KIND,
      version: 1,
      data: { ...origin },
    });
    return this.getAgent(agent.id) ?? agent;
  }

  private timelineTail(agentId: string): { epoch: string; seq: number } | null {
    const last = this.timelineStore.getRows(agentId).at(-1);
    return last ? { epoch: this.timelineStore.getEpoch(agentId), seq: last.seqEnd } : null;
  }

  /** The timeline position of an assistant message (older apps send only its id). */
  forkBoundaryForMessage(
    agentId: string,
    messageId: string | undefined,
  ): { epoch: string; seq: number } | null {
    if (!messageId) return null;
    const row = this.timelineStore
      .getRows(agentId)
      .findLast(
        (entry) => entry.item.type === "assistant_message" && entry.item.messageId === messageId,
      );
    if (!row) throw new Error("Selected assistant message is no longer available.");
    return { epoch: this.timelineStore.getEpoch(agentId), seq: row.seqEnd };
  }

  /** The provider id of the first user message after `boundary`; null forks everything. */
  private forkAnchorUserMessageId(
    agentId: string,
    boundary: { epoch: string; seq: number } | null,
  ): string | null {
    if (!boundary) return null;
    if (boundary.epoch !== this.timelineStore.getEpoch(agentId)) {
      throw new Error("Selected timeline position is no longer available.");
    }
    const next = this.timelineStore
      .getRows(agentId)
      .find((row) => row.seq > boundary.seq && row.item.type === "user_message");
    if (!next || next.item.type !== "user_message") return null;
    if (next.providerMessageId) return next.providerMessageId;
    if (next.item.clientMessageId) {
      throw new Error("Cannot fork before the provider acknowledges the next message");
    }
    return next.item.messageId ?? null;
  }

  async rewind(agentId: string, messageId: string, mode: RewindMode): Promise<void> {
    let agent = this.requireSessionAgent(agentId);
    if (this.historySessions.has(agent.session)) {
      agent = await this.ensureInteractiveSession(agentId);
    }
    // An interactive session must acquire its rewind lock without yielding.

    const submittedRow = this.timelineStore
      .getRows(agentId)
      .find(
        (row) =>
          row.item.type === "user_message" &&
          row.item.messageId === messageId &&
          row.item.clientMessageId === messageId,
      );
    if (submittedRow && !submittedRow.providerMessageId) {
      throw new Error("Cannot rewind before the provider acknowledges the submitted prompt");
    }
    const providerMessageId = submittedRow?.providerMessageId ?? messageId;

    if (this.hasInFlightRun(agentId)) {
      await this.cancelAgentRunBefore(agentId, "rewind");
    }

    const lock = this.runs.createPendingRun(agentId);
    try {
      this.logger.info(
        { agentId, provider: agent.provider, messageId, mode },
        "agent.rewind.start",
      );
      await invokeRewindCapability(agent.session, { messageId: providerMessageId, mode });
      if (mode !== "files") {
        await this.hydrateTimelineFromProvider(agentId, {
          force: true,
          broadcast: true,
          broadcastTimeline: false,
        });
        this.dispatch({
          type: "timeline_replacement",
          agentId,
          epoch: this.timelineStore.getEpoch(agentId),
        });
      }
      await this.refreshRuntimeInfo(agent);
      await this.persistSnapshot(agent);
      this.logger.info(
        { agentId, provider: agent.provider, messageId, mode },
        "agent.rewind.complete",
      );
    } catch (error) {
      // Native rewind can commit a fork before history refresh fails. Recovery
      // must resume that latest handle rather than the abandoned conversation.
      this.refreshSessionPersistence(agent);
      await this.persistSnapshot(agent);
      this.logger.warn(
        { err: error, agentId, provider: agent.provider, messageId, mode },
        "agent.rewind.failed",
      );
      throw error;
    } finally {
      this.runs.settleForegroundRun(agentId, lock.token);
    }
  }

  async deleteAgentState(agentId: string): Promise<void> {
    this.discardRetainedAgentState(agentId);
    await this.deleteCommittedTimeline(agentId);
  }

  notifyAgentRemoved(agent: Pick<StoredAgentRecord, "id" | "workspaceId" | "internal">): void {
    this.dispatch({
      type: "agent_removed",
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      internal: agent.internal === true,
    });
  }

  async deleteCommittedTimeline(agentId: string): Promise<void> {
    await this.timelineSnapshots?.delete(agentId);
    await this.durableTimelineStore?.deleteAgent(agentId);
  }

  /**
   * Reads the agent's timeline snapshot when the provider still reports the history it was
   * projected from. A retained timeline, a missing snapshot or a changed history returns null,
   * and the agent replays its provider history as before.
   */
  private async readValidTimelineSnapshot(
    agentId: string,
    handle: AgentPersistenceHandle,
    session: AgentSession,
  ): Promise<StoredAgentTimelineSnapshot | null> {
    if (!this.timelineSnapshots || !session.readHistoryVersion || this.timelineStore.has(agentId)) {
      return null;
    }
    const startedAt = performance.now();
    const [snapshot, historyVersion] = await Promise.all([
      this.timelineSnapshots.read(agentId),
      session.readHistoryVersion().catch((error: unknown) => {
        this.logger.warn({ err: error, agentId }, "Failed to read provider history version");
        return null;
      }),
    ]);
    if (!snapshot) return null;
    const current =
      historyVersion !== null &&
      snapshot.provider === handle.provider &&
      snapshot.sessionId === handle.sessionId &&
      snapshot.historyVersion === historyVersion;
    this.logger.info(
      {
        agentId,
        provider: handle.provider,
        rows: snapshot.timeline.rows.length,
        current,
        durationMs: Math.round(performance.now() - startedAt),
      },
      current
        ? "Restoring agent timeline from snapshot"
        : "Agent timeline snapshot is outdated; replaying provider history",
    );
    return current ? snapshot : null;
  }

  private attachTimelineSnapshots(
    snapshots: AgentTimelineSnapshots | undefined,
  ): AgentTimelineSnapshots | undefined {
    snapshots?.attach((agentId) => this.captureTimelineSnapshot(agentId));
    return snapshots;
  }

  private isTimelineSettled(agent: LiveManagedAgent): boolean {
    return (
      (agent.lifecycle === "idle" || agent.lifecycle === "error") &&
      agent.activeForegroundTurnId === null &&
      !this.runs.hasRun(agent.id) &&
      !agent.pendingReplacement &&
      !this.sessionEventTails.has(agent.id) &&
      !this.providerSubagents.list(agent.id).some((child) => child.status === "running")
    );
  }

  private async captureTimelineSnapshot(agentId: string): Promise<AgentTimelineSnapshotCapture> {
    const agent = this.agents.get(agentId);
    const sessionId = agent?.persistence?.sessionId;
    if (
      !agent ||
      !sessionId ||
      !agent.historyPrimed ||
      !agent.session.readHistoryVersion ||
      !this.timelineStore.has(agentId)
    ) {
      return { status: "skip" };
    }
    if (!this.isTimelineSettled(agent)) return { status: "busy" };
    const historyVersion = await agent.session.readHistoryVersion();
    if (historyVersion === null) return { status: "skip" };
    // Rows are captured after the version, so they hold at least the history it names.
    if (this.agents.get(agentId) !== agent || !this.isTimelineSettled(agent)) {
      return { status: "busy" };
    }
    return {
      status: "ready",
      snapshot: {
        version: 1,
        agentId,
        provider: agent.provider,
        sessionId,
        historyVersion,
        writtenAt: new Date().toISOString(),
        timeline: this.timelineStore.snapshot(agentId),
        subagents: this.providerSubagents.snapshotParent(agentId),
      },
    };
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return null;
    }

    return await this.getLastAssistantMessageFromStores(agentId);
  }

  private getLastAssistantMessageFromTimeline(
    timeline: readonly AgentTimelineItem[],
  ): string | null {
    return (
      this.getLastAssistantMessageSegmentFromTimeline(timeline.map((item) => ({ item })))?.text ??
      null
    );
  }

  private getLastAssistantMessageSegmentFromTimeline(
    timeline: readonly Pick<AgentTimelineRow, "item" | "turnId">[],
  ): { text: string; startsAtBeginning: boolean } | null {
    // Collect the chunks of the last assistant message (Claude streams chunks). A turn the
    // provider starts on its own has no user message before its reply.
    const chunks: string[] = [];
    let startsAtBeginning = false;
    for (let i = timeline.length - 1; i >= 0; i--) {
      const { item } = timeline[i];
      if (chunks.length > 0 && !continuesAssistantMessage(timeline[i], timeline[i + 1])) {
        break;
      }
      if (item.type !== "assistant_message") continue;
      chunks.push(item.text);
      startsAtBeginning = i === 0;
    }

    if (!chunks.length) {
      return null;
    }

    return {
      text: chunks.toReversed().join(""),
      startsAtBeginning,
    };
  }

  private async getLastAssistantMessageFromStores(agentId: string): Promise<string | null> {
    const liveSegment = this.getLastAssistantMessageSegmentFromTimeline(
      this.timelineStore.getRows(agentId),
    );
    if (!this.durableTimelineStore) {
      return liveSegment?.text ?? null;
    }
    if (!liveSegment) {
      return await this.durableTimelineStore.getLastAssistantMessage(agentId);
    }
    if (!liveSegment.startsAtBeginning) {
      return liveSegment.text;
    }
    const lastDurableItem = await this.durableTimelineStore.getLastItem(agentId);
    if (lastDurableItem?.type !== "assistant_message") {
      return liveSegment.text;
    }
    const durableMessage = await this.durableTimelineStore.getLastAssistantMessage(agentId);
    return durableMessage ? `${durableMessage}${liveSegment.text}` : liveSegment.text;
  }

  private async getLastItemFromStores(agentId: string): Promise<AgentTimelineItem | null> {
    const lastLiveItem = this.timelineStore.getLastItem(agentId);
    return lastLiveItem ?? (await this.durableTimelineStore?.getLastItem(agentId)) ?? null;
  }

  async waitForAgentEvent(
    agentId: string,
    options?: WaitForAgentOptions,
  ): Promise<WaitForAgentResult> {
    const snapshot = this.getAgent(agentId);
    if (!snapshot) {
      throw new Error(`Agent ${agentId} not found`);
    }

    const pendingForegroundRun = this.runs.getPendingRun(agentId);
    const hasForegroundTurn =
      Boolean(snapshot.activeForegroundTurnId) || Boolean(pendingForegroundRun);

    const immediatePermission = this.peekPendingPermission(snapshot);
    if (immediatePermission) {
      return {
        status: snapshot.lifecycle,
        permission: immediatePermission,
        lastMessage: await this.getLastAssistantMessage(agentId),
      };
    }

    const initialStatus = snapshot.lifecycle;
    const initialBusy = isAgentBusy(initialStatus) || hasForegroundTurn;
    const waitForActive = options?.waitForActive ?? false;
    if (!waitForActive && !initialBusy) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: await this.getLastAssistantMessage(agentId),
      };
    }
    if (waitForActive && !initialBusy && !hasForegroundTurn) {
      return {
        status: initialStatus,
        permission: null,
        lastMessage: await this.getLastAssistantMessage(agentId),
      };
    }

    if (options?.signal?.aborted) {
      throw createAbortError(options.signal, "wait_for_agent aborted");
    }

    return await new Promise<WaitForAgentResult>((resolvePromise, reject) => {
      // Bug #1 Fix: Check abort signal AGAIN inside Promise constructor
      // to avoid race condition between pre-Promise check and abort listener registration
      if (options?.signal?.aborted) {
        reject(createAbortError(options.signal, "wait_for_agent aborted"));
        return;
      }

      let currentStatus: AgentLifecycleStatus = initialStatus;
      let hasStarted =
        isAgentBusy(initialStatus) ||
        Boolean(snapshot.activeForegroundTurnId) ||
        pendingForegroundRun?.start.status === "started";
      let terminalStatusOverride: AgentLifecycleStatus | null = null;
      let finished = false;

      // Bug #3 Fix: Declare unsubscribe and abortHandler upfront so cleanup can reference them
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;

      const cleanup = () => {
        // Clean up subscription
        if (unsubscribe) {
          try {
            unsubscribe();
          } catch {
            // ignore cleanup errors
          }
          unsubscribe = null;
        }

        // Clean up abort listener
        if (abortHandler && options?.signal) {
          try {
            options.signal.removeEventListener("abort", abortHandler);
          } catch {
            // ignore cleanup errors
          }
          abortHandler = null;
        }
      };

      const finish = (permission: AgentPermissionRequest | null) => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        void this.getLastAssistantMessage(agentId)
          .then((lastMessage) => {
            resolvePromise({
              status: currentStatus,
              permission,
              lastMessage,
            });
            return;
          })
          .catch(reject);
      };

      // Bug #3 Fix: Set up abort handler BEFORE subscription
      // to ensure cleanup handlers exist before callback can fire
      if (options?.signal) {
        abortHandler = () => {
          cleanup();
          reject(createAbortError(options.signal, "wait_for_agent aborted"));
        };
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Bug #3 Fix: Now subscribe with cleanup handlers already in place
      // This prevents race condition if callback fires synchronously with replayState: true
      unsubscribe = this.subscribe(
        (event) => {
          if (event.type === "agent_state") {
            currentStatus = event.agent.lifecycle;
            const pending = this.peekPendingPermission(event.agent);
            if (pending) {
              finish(pending);
              return;
            }
            if (isAgentBusy(event.agent.lifecycle)) {
              hasStarted = true;
              return;
            }
            if (!waitForActive || hasStarted) {
              if (terminalStatusOverride) {
                currentStatus = terminalStatusOverride;
              }
              finish(null);
            }
            return;
          }

          if (event.type === "agent_stream") {
            if (event.event.type === "permission_requested") {
              finish(event.event.request);
              return;
            }
            if (event.event.type === "turn_failed") {
              hasStarted = true;
              terminalStatusOverride = "error";
              return;
            }
            if (event.event.type === "turn_completed") {
              hasStarted = true;
            }
            if (event.event.type === "turn_canceled") {
              hasStarted = true;
            }
          }
        },
        { agentId, replayState: true },
      );
    });
  }

  private async registerSession(
    session: AgentSession,
    openedConfig: AgentSessionConfig,
    agentId: string,
    options: {
      createdAt?: Date;
      updatedAt?: Date;
      lastUserMessageAt?: Date | null;
      labels?: Record<string, string>;
      metadata?: AgentMetadata;
      timeline?: AgentTimelineItem[];
      timelineRows?: AgentTimelineRow[];
      timelineNextSeq?: number;
      /** A validated snapshot of this agent's projected timeline, restored instead of a replay. */
      timelineSnapshot?: StoredAgentTimelineSnapshot | null;
      persistence?: AgentPersistenceHandle;
      historyPrimed?: boolean;
      lastUsage?: AgentUsage;
      usageTotals?: AgentUsageTotals;
      sessionMetrics?: AgentMetric[];
      lastError?: string;
      attention?: AttentionState;
      /**
       * Bringing a known agent back, rather than starting a new one. Its timestamps and
       * attention come from what was already recorded, and installing the session is not
       * activity in it.
       */
      /**
       * The effective options the opening resolved before the session started. Registration
       * starts from these rather than reading the defaults again, which may have been edited
       * while the provider was opening.
       */
      launchedOptions: ProviderOptions;
      restoring?: boolean;
      initialTitle?: string | null;
      publishWhenReady?: boolean;
      workspaceId?: string;
      owner?: AgentOwner;
      background?: boolean;
      launchEnv?: Record<string, string>;
    },
  ): Promise<ManagedAgent> {
    let registered = false;
    try {
      this.assertAcceptingAgentRegistrations();
      const config = this.withOpenedOptions({ config: openedConfig, session });
      const resolvedAgentId = validateAgentId(agentId, "registerSession");
      if (this.agents.has(resolvedAgentId)) {
        throw new Error(`Agent with id ${resolvedAgentId} already exists`);
      }
      const initialPersistedTitle = await this.resolveInitialPersistedTitle(
        resolvedAgentId,
        config,
        options?.initialTitle ?? null,
      );

      const now = new Date();
      const { durableTimelineHasRows } = await this.initializeAgentTimelineForRegister({
        agentId: resolvedAgentId,
        now,
        options,
      });

      const launchEnv = options?.launchEnv;
      const managed = this.buildManagedAgentForRegister({
        resolvedAgentId,
        session,
        config,
        effectiveOptions: this.openedEffectiveOptions({
          session,
          launchedOptions: options.launchedOptions,
        }),
        now,
        durableTimelineHasRows,
        background: options?.background === true,
        options,
      });

      managed.launchEnv = launchEnv;
      discardHeldHistoryReplay(managed, options.restoring === true);

      // Read history before publishing the agent: a provider failure must leave the
      // session unregistered so the registration catch closes it.
      const startupHistory: AgentStreamEvent[] = [];
      if (session.initialTimeline?.length && !managed.historyPrimed) {
        for await (const event of session.streamHistory()) {
          startupHistory.push(limitAgentStreamEventContent(event));
        }
      }

      this.assertAcceptingAgentRegistrations();
      this.runtimeCleanupIdentities.set(session, Object.freeze({ openedAt: Date.now() }));
      this.agents.set(resolvedAgentId, managed);
      registered = true;
      // Initialize previousStatus to track transitions
      this.previousStatuses.set(resolvedAgentId, managed.lifecycle);
      if (session.initialTimeline?.length) {
        if (!managed.historyPrimed) {
          // Legacy/imported chats need their existing history before startup rows.
          await this.primeTimelineFromLegacyProviderHistory(managed, false, startupHistory);
        } else {
          for (const entry of buildImportedTimelineRows(session.initialTimeline)) {
            this.recordTimeline(managed.id, entry.item, { timestamp: entry.timestamp });
          }
        }
        this.refreshSessionPersistence(managed);
      }
      await this.refreshRuntimeInfo(managed, { emit: false });
      this.assertAgentRegistrationActive(managed);
      await this.persistSnapshot(managed, {
        title: initialPersistedTitle,
      });
      this.assertAgentRegistrationActive(managed);
      if (!options?.publishWhenReady) {
        this.emitState(managed, { persist: false });
      }

      await this.refreshSessionState(managed, { emit: false });
      this.assertAgentRegistrationActive(managed);
      managed.lifecycle = "idle";
      // Stamping now over a restored timestamp rewrote the workspace's "last used" in the
      // sidebar every time a chat was reopened, because workspace `statusEnteredAt` is
      // re-derived from persisted agent `updatedAt` on every daemon start.
      if (!options?.restoring) {
        this.touchUpdatedAt(managed);
      }
      await this.persistSnapshot(managed);
      this.assertAgentRegistrationActive(managed);
      this.emitState(managed, { persist: false });
      this.subscribeToSession(managed);
      await this.drainSessionEvents(managed.id);
      this.assertAgentRegistrationActive(managed);
      return { ...managed };
    } catch (error) {
      if (!registered) {
        await this.closeUnregisteredSession(session);
      }
      throw error;
    }
  }

  private assertAcceptingAgentRegistrations(): void {
    if (!this.acceptingAgentRegistrations) {
      throw new AgentManagerShuttingDownError();
    }
  }

  private assertAgentRegistrationActive(agent: ActiveManagedAgent): void {
    if (!this.acceptingAgentRegistrations || this.agents.get(agent.id) !== agent) {
      throw new AgentManagerShuttingDownError();
    }
  }

  private async closeUnregisteredSession(session: AgentSession): Promise<void> {
    try {
      await session.close();
    } catch (error) {
      this.logger.warn({ err: error }, "Failed to close unregistered agent session");
    }
  }

  private async requireExternalMcpSupport(
    session: AgentSession,
    launchConfig: AgentSessionConfig,
    launchContext: AgentLaunchContext,
  ): Promise<void> {
    if (
      Object.keys(stripInternalJAgentDeskMcpServer(launchConfig).mcpServers ?? {}).length === 0 ||
      session.capabilities.supportsMcpServers === true
    ) {
      return;
    }
    await this.closeUnregisteredSession(session);
    throw this.unsupportedMcpError(launchConfig, launchContext);
  }

  private unsupportedMcpError(config: AgentSessionConfig, context: AgentLaunchContext): Error {
    const owners = [...new Set(Object.values(context.mcpServerOwners ?? {}))];
    const source = owners.length ? ` (plugin ${owners.join(", ")})` : "";
    return new Error(`Provider '${config.provider}' does not support MCP servers${source}`);
  }

  private async initializeAgentTimelineForRegister(params: {
    agentId: string;
    now: Date;
    options:
      | {
          timeline?: AgentTimelineItem[];
          timelineRows?: AgentTimelineRow[];
          timelineNextSeq?: number;
          timelineSnapshot?: StoredAgentTimelineSnapshot | null;
          persistence?: AgentPersistenceHandle;
          createdAt?: Date;
          updatedAt?: Date;
        }
      | undefined;
  }): Promise<{ durableTimelineHasRows: boolean }> {
    const { agentId, now, options } = params;
    const snapshot = options?.timelineSnapshot;
    if (snapshot && !this.timelineStore.has(agentId)) {
      this.timelineStore.restore(agentId, snapshot.timeline);
      this.providerSubagents.restoreParent(agentId, snapshot.subagents);
      return { durableTimelineHasRows: true };
    }
    const timelineAlreadyPrimed = this.timelineStore.has(agentId);
    const explicitTimelineSeed = buildExplicitTimelineSeedForRegister(now, options);
    const shouldSeedFromDurable =
      !explicitTimelineSeed && !this.timelineStore.has(agentId) && this.durableTimelineStore;
    const durableTimelineSeed = shouldSeedFromDurable
      ? await this.loadCommittedTimelineSeed(agentId, now)
      : null;
    const durableTimelineHasRows =
      timelineAlreadyPrimed ||
      (durableTimelineSeed != null && (durableTimelineSeed.nextSeq ?? 1) > 1);
    const timelineSeed = explicitTimelineSeed ?? durableTimelineSeed;
    if (timelineSeed || !this.timelineStore.has(agentId)) {
      this.timelineStore.initialize(agentId, timelineSeed ?? { timestamp: now.toISOString() });
    }
    if (options?.timelineRows?.length) {
      this.enqueueDurableTimelineBulkInsert(agentId, options.timelineRows);
    }
    return { durableTimelineHasRows };
  }

  private buildManagedAgentForRegister(params: {
    resolvedAgentId: string;
    session: AgentSession;
    config: AgentSessionConfig;
    effectiveOptions: ProviderOptions;
    now: Date;
    durableTimelineHasRows: boolean;
    background: boolean;
    options:
      | {
          createdAt?: Date;
          updatedAt?: Date;
          lastUserMessageAt?: Date | null;
          labels?: Record<string, string>;
          metadata?: AgentMetadata;
          historyPrimed?: boolean;
          lastUsage?: AgentUsage;
          usageTotals?: AgentUsageTotals;
          sessionMetrics?: AgentMetric[];
          lastError?: string;
          attention?: AttentionState;
          persistence?: AgentPersistenceHandle;
          workspaceId?: string;
          owner?: AgentOwner;
          launchEnv?: Record<string, string>;
        }
      | undefined;
  }): ActiveManagedAgent {
    const {
      resolvedAgentId,
      session,
      config,
      effectiveOptions,
      now,
      durableTimelineHasRows,
      options,
    } = params;
    return {
      id: resolvedAgentId,
      provider: config.provider,
      cwd: config.cwd,
      workspaceId: options?.workspaceId,
      owner: options?.owner,
      session,
      capabilities: session.capabilities,
      config,
      // What the session opened with. Provider defaults edited later reach it when it next opens.
      effectiveOptions,
      runtimeInfo: undefined,
      lifecycle: "initializing",
      createdAt: options?.createdAt ?? now,
      updatedAt: options?.updatedAt ?? now,
      availableModes: [],
      currentModeId: null,
      pendingPermissions: new Map<string, AgentPermissionRequest>(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      activeForegroundTurnId: null,
      activeTurnId: null,
      activeTurnStartedAt: null,
      foregroundTurnWaiters: new Set<ForegroundTurnWaiter>(),
      finalizedForegroundTurnIds: new Set<string>(),
      unsubscribeSession: null,
      persistence: normalizePersistenceForConfig(
        options?.persistence ?? session.describePersistence(),
        config,
      ),
      historyPrimed: options?.historyPrimed ?? durableTimelineHasRows,
      lastUserMessageAt: options?.lastUserMessageAt ?? null,
      lastUsage: options?.lastUsage,
      usageTotals: options?.usageTotals,
      sessionMetrics: readSessionMetrics(options),
      lastError: options?.lastError,
      attention: resolveInitialAttention(options?.attention),
      internal: config.internal ?? false,
      background: params.background,
      ...agentEntityData(options),
    } as ActiveManagedAgent;
  }

  private async loadCommittedTimelineSeed(
    agentId: string,
    now: Date,
  ): Promise<SeedAgentTimelineOptions> {
    if (!this.durableTimelineStore) {
      return { timestamp: now.toISOString() };
    }
    return {
      nextSeq: (await this.durableTimelineStore.getLatestCommittedSeq(agentId)) + 1,
      timestamp: now.toISOString(),
    };
  }

  private prepareAgentForClosure(
    agent: LiveManagedAgent,
    cancelReason: string,
  ): ManagedAgentClosed {
    this.agentStreamCoalescer.flushAndDiscard(agent.id);
    this.agents.delete(agent.id);
    this.previousStatuses.delete(agent.id);
    if (agent.unsubscribeSession) {
      agent.unsubscribeSession();
      agent.unsubscribeSession = null;
    }
    this.runs.cancelWaiters(agent, (turnId) => ({
      type: "turn_canceled",
      provider: agent.provider,
      reason: cancelReason,
      turnId,
    }));
    this.runs.clearAgentRun(agent.id);
    return {
      ...agent,
      lifecycle: "closed",
      session: null,
      activeForegroundTurnId: null,
      activeTurnId: null,
      activeTurnStartedAt: null,
      pendingPermissions: new Map(),
      bufferedPermissionResolutions: new Map(),
      inFlightPermissionResponses: new Set(),
      pendingReplacement: false,
      foregroundTurnWaiters: new Set(),
      finalizedForegroundTurnIds: new Set(),
      unsubscribeSession: null,
    };
  }

  private discardRetainedAgentState(agentId: string): void {
    this.jagentdeskToolPolicies.delete(agentId);
    this.hostToolInstructions.delete(agentId);
    this.unappliedHostToolSets.delete(agentId);
    this.unavailableJAgentDeskTools.delete(agentId);
    this.launchedHostHints.delete(agentId);
    this.timelineStore.delete(agentId);
    this.detachPluginTools(agentId);
    for (const event of this.providerSubagents.deleteParent(agentId)) {
      this.dispatch({ type: "provider_subagent", event });
    }
    this.clearProviderBackgroundWork(agentId);
  }

  private emitClosedAgent(agent: ManagedAgentClosed, options?: { persist?: boolean }): void {
    this.emitState(agent, options);
    if (!agent.internal) {
      this.pluginLifecycle?.emit("agent.close.after", {
        agent: describeHookAgent({ ...agent, title: agent.config.title }),
      });
    }
  }

  private subscribeToSession(agent: ActiveManagedAgent): void {
    if (agent.unsubscribeSession) {
      return;
    }
    const agentId = agent.id;
    const unsubscribe = agent.session.subscribe((event: AgentStreamEvent) => {
      this.enqueueSessionEvent(agentId, event);
    });
    agent.unsubscribeSession = unsubscribe;
  }

  private enqueueSessionEvent(agentId: string, event: AgentStreamEvent): void {
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: this.agents.get(agentId)?.persistence?.sessionId ?? undefined,
        turnId: getAgentStreamEventTurnId(event),
        event,
      },
      "agent.manager.enqueue",
    );
    const steerBarrier = this.steerEventBarriers.get(agentId);
    if (steerBarrier) {
      steerBarrier.events.push(event);
      return;
    }
    const pendingRun = this.runs.getPendingRun(agentId);
    if (pendingRun?.start.status === "pending") {
      pendingRun.stagedEvents.push(event);
      return;
    }
    const previous = this.sessionEventTails.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = this.agents.get(agentId);
        if (!current) {
          return;
        }
        if (current.session == null) {
          return;
        }
        this.logger.trace(
          {
            agentId,
            provider: event.provider,
            sessionId: current.persistence?.sessionId ?? undefined,
            turnId: getAgentStreamEventTurnId(event),
            event,
          },
          "agent.manager.dequeue",
        );
        await this.dispatchSessionEvent(current, event);
        return;
      })
      .catch((err) => {
        this.logger.error(
          { err, agentId, eventType: event.type },
          "Failed to process session event",
        );
      });

    this.sessionEventTails.set(agentId, next);
    this.trackBackgroundTask(next);
    void next.finally(() => {
      if (this.sessionEventTails.get(agentId) === next) {
        this.sessionEventTails.delete(agentId);
      }
    });
  }

  /**
   * Provider mutations may synchronously emit config events that are processed through the
   * asynchronous session queue. Apply those events before committing the mutation's explicit
   * manager state so call order remains authoritative.
   */
  private async drainSessionEvents(agentId: string): Promise<void> {
    while (true) {
      const tail = this.sessionEventTails.get(agentId);
      if (!tail) {
        return;
      }
      await tail;
      if (this.sessionEventTails.get(agentId) === tail) {
        return;
      }
    }
  }

  private async dispatchSessionEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
  ): Promise<void> {
    if (event.type === "provider_subagent") {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      this.timelineSnapshots?.markChanged(agent.id);
      this.dispatch({ type: "provider_subagent", event: update });
      return;
    }
    if (event.type === "background_work") {
      const items =
        event.items === null
          ? this.backgroundWork.clear(agent.id)
          : this.backgroundWork.apply(agent.id, event.items);
      this.publishBackgroundWork(agent.id, items);
      // Spec 38 §4.4b: "Started in background" / "Background task finished" rows for providers
      // whose timeline does not carry them. A reset (`items: null`) is not an end.
      if (event.items !== null && items) {
        const rows = this.backgroundWorkTimeline.update({
          agentId: agent.id,
          provider: event.provider,
          items,
          nowMs: Date.now(),
        });
        for (const row of rows) await this.appendTimelineItem(agent.id, row);
      }
      return;
    }
    const turnId = getAgentStreamEventTurnId(event);
    const matchingWaiters = this.runs.getMatchingWaiters(agent, turnId);
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        matchingWaiterCount: matchingWaiters.length,
        event,
      },
      "agent.manager.dispatch_session_event",
    );

    const shouldNotifyWaiters = await this.handleStreamEvent(agent, event);

    if (!shouldNotifyWaiters) {
      return;
    }

    this.runs.notifyWaiters(matchingWaiters, event, {
      terminal: isTurnTerminalEvent(event),
    });
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        notifiedWaiterCount: matchingWaiters.length,
        terminal: isTurnTerminalEvent(event),
        event,
      },
      "agent.manager.notify_waiters",
    );
  }

  private async resolveInitialPersistedTitle(
    agentId: string,
    config: AgentSessionConfig,
    fallbackTitle: string | null,
  ): Promise<string | null> {
    const existing = await this.registry?.get(agentId);
    if (existing) {
      return existing.title ?? null;
    }
    const explicitTitle =
      typeof config.title === "string" && config.title.trim().length > 0
        ? config.title.trim()
        : null;
    return explicitTitle ?? fallbackTitle;
  }

  private async persistSnapshot(
    agent: ManagedAgent,
    options?: { title?: string | null; internal?: boolean },
  ): Promise<void> {
    if (!this.registry) {
      return;
    }
    // Don't persist internal agents - they're ephemeral system tasks
    if (agent.internal) {
      return;
    }
    await this.registry.applySnapshot(agent, options);
  }

  private requireRegistry(): AgentStorage {
    if (!this.registry) {
      throw new Error("Agent storage unavailable");
    }
    return this.registry;
  }

  /**
   * Provider-side mode switches (ACP current_mode_update, in-session
   * commands, permission-driven transitions) must land in config.modeId too —
   * reloadAgentSession and the persisted record derive the resumed session's
   * mode from it, so leaving it stale silently downgrades the mode on resume.
   */
  private applyObservedMode(agent: ActiveManagedAgent, modeId: string | null): void {
    agent.currentModeId = modeId;
    if (modeId != null) {
      agent.config.modeId = modeId;
    }
  }

  private async refreshSessionState(
    agent: ActiveManagedAgent,
    options?: { emit?: boolean },
  ): Promise<void> {
    try {
      const modes = await agent.session.getAvailableModes();
      agent.availableModes = modes;
    } catch {
      agent.availableModes = [];
    }

    try {
      this.applyObservedMode(agent, await agent.session.getCurrentMode());
    } catch {
      agent.currentModeId = null;
    }

    try {
      const pending = agent.session.getPendingPermissions();
      agent.pendingPermissions = new Map(pending.map((request) => [request.id, request]));
    } catch {
      agent.pendingPermissions.clear();
    }

    this.syncControls(agent);
    await this.refreshRuntimeInfo(agent, options);
  }

  private async refreshRuntimeInfo(
    agent: ActiveManagedAgent,
    options?: { emit?: boolean },
  ): Promise<void> {
    try {
      const newInfo = await agent.session.getRuntimeInfo();
      const changed =
        newInfo.model !== agent.runtimeInfo?.model ||
        newInfo.thinkingOptionId !== agent.runtimeInfo?.thinkingOptionId ||
        newInfo.sessionId !== agent.runtimeInfo?.sessionId ||
        newInfo.modeId !== agent.runtimeInfo?.modeId;
      agent.runtimeInfo = newInfo;
      if (!agent.persistence && newInfo.sessionId) {
        agent.persistence = normalizePersistenceForConfig(
          { provider: agent.provider, sessionId: newInfo.sessionId },
          agent.config,
        );
      }
      // Emit state if runtimeInfo changed so clients get the updated model
      if (changed && options?.emit !== false) {
        this.emitState(agent);
      }
    } catch {
      // Keep existing runtimeInfo if refresh fails.
    }
  }

  private async hydrateTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    options?: HydrateTimelineOptions,
  ): Promise<void> {
    if (agent.historyPrimed && !options?.force) {
      return;
    }

    const broadcast = options?.broadcast ?? false;
    const broadcastTimeline = options?.broadcastTimeline ?? broadcast;

    if (options?.force) {
      await this.forceHydrateTimelineFromLegacyProviderHistory(
        agent,
        typeof broadcast === "function" ? broadcast() : broadcast,
        typeof broadcastTimeline === "function" ? broadcastTimeline() : broadcastTimeline,
      );
      return;
    }

    await this.primeTimelineFromLegacyProviderHistory(agent, broadcast);
  }

  private async forceHydrateTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    broadcast: boolean,
    broadcastTimeline: boolean,
  ): Promise<void> {
    const historyEntries: ProviderHistoryEntry[] = [];
    const providerSubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
    for await (const rawEvent of agent.session.streamHistory()) {
      const event = limitAgentStreamEventContent(rawEvent);
      if (event.type === "provider_subagent") {
        providerSubagentEvents.push(event);
      } else {
        historyEntries.push(...providerHistoryEntries(event));
      }
    }

    this.agentStreamCoalescer.flushAndDiscard(agent.id);
    await this.deleteCommittedTimeline(agent.id);
    this.timelineStore.delete(agent.id);
    this.timelineStore.initialize(agent.id, { timestamp: new Date().toISOString() });
    agent.historyPrimed = true;

    for (const event of this.providerSubagents.deleteParent(agent.id)) {
      if (broadcast) {
        this.dispatch({ type: "provider_subagent", event });
      }
    }
    for (const event of providerSubagentEvents) {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      this.timelineSnapshots?.markChanged(agent.id);
      if (broadcast) {
        this.dispatch({ type: "provider_subagent", event: update });
      }
    }
    for (const entry of historyEntries) {
      const replayed = this.replayProviderHistoryEntry(agent, entry);
      if (replayed && broadcastTimeline) {
        this.dispatchStream(agent.id, replayed.event, {
          seq: replayed.row.seq,
          epoch: this.timelineStore.getEpoch(agent.id),
          timestamp: replayed.row.timestamp,
        });
      }
    }
    this.touchUpdatedAt(agent);
    this.emitState(agent);
  }

  /**
   * Returns the row a replayed timeline event wrote. Metrics write no row: turn
   * metrics land on one already written, session metrics on the agent.
   */
  private replayProviderHistoryEntry(
    agent: ActiveManagedAgent,
    entry: ProviderHistoryEntry,
  ): ReplayedTimelineRow | null {
    if (entry.type === "turn_metrics") {
      this.stampTurnMetrics(agent.id, entry.metrics);
      return null;
    }
    if (entry.type === "session_metrics") {
      agent.sessionMetrics = entry.metrics;
      return null;
    }
    const { event } = entry;
    const row = this.recordTimeline(
      agent.id,
      event.item,
      event.timestamp ? { timestamp: event.timestamp } : undefined,
    );
    return { event, row };
  }

  private async primeTimelineFromLegacyProviderHistory(
    agent: ActiveManagedAgent,
    broadcast: boolean | (() => boolean),
    history:
      | AsyncIterable<AgentStreamEvent>
      | Iterable<AgentStreamEvent> = agent.session.streamHistory(),
  ): Promise<void> {
    const deferredBroadcast = typeof broadcast === "function";
    const historyEntries: ProviderHistoryEntry[] = [];
    const historySubagentEvents: Extract<AgentStreamEvent, { type: "provider_subagent" }>[] = [];
    agent.historyPrimed = false;
    try {
      // Collect the whole replay before touching either store. A stream that fails
      // halfway then leaves the committed timeline as it was, instead of a partial
      // copy the next attempt would append to.
      for await (const rawEvent of history) {
        const event = limitAgentStreamEventContent(rawEvent);
        if (event.type === "provider_subagent") {
          historySubagentEvents.push(event);
          continue;
        }
        historyEntries.push(...providerHistoryEntries(event));
      }
    } catch (error) {
      this.logger.warn({ err: error, agentId: agent.id }, "Failed to hydrate provider history");
      throw error;
    }

    // The replay is the timeline, so drop the rows a previous hydration committed.
    // Keeping them would leave getTimelineRows reading one copy per hydration.
    await this.deleteCommittedTimeline(agent.id);

    const timelineEvents: ReplayedTimelineRow[] = [];
    const providerSubagentEvents: AgentManagerEvent[] = [];
    for (const event of historySubagentEvents) {
      const update = this.providerSubagents.apply(agent.id, event.provider, event.event);
      this.timelineSnapshots?.markChanged(agent.id);
      const managerEvent: AgentManagerEvent = { type: "provider_subagent", event: update };
      if (deferredBroadcast) {
        providerSubagentEvents.push(managerEvent);
      } else if (broadcast) {
        this.dispatch(managerEvent);
      }
    }
    for (const entry of historyEntries) {
      const replayed = this.replayProviderHistoryEntry(agent, entry);
      if (!replayed) continue;
      if (deferredBroadcast) {
        timelineEvents.push(replayed);
      } else if (broadcast) {
        this.dispatchStream(agent.id, replayed.event, {
          seq: replayed.row.seq,
          epoch: this.timelineStore.getEpoch(agent.id),
          timestamp: replayed.row.timestamp,
        });
      }
    }
    agent.historyPrimed = true;
    if (historyEntries.some((entry) => entry.type === "session_metrics")) {
      this.emitState(agent);
    }

    if (typeof broadcast !== "function" || !broadcast()) {
      return;
    }
    for (const event of providerSubagentEvents) {
      this.dispatch(event);
    }
    for (const { event, row } of timelineEvents) {
      this.dispatchStream(agent.id, event, {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agent.id),
        timestamp: row.timestamp,
      });
    }
  }

  private notifyForegroundTurnWaiters(agentId: string, event: AgentStreamEvent): void {
    const turnId = getAgentStreamEventTurnId(event);
    if (turnId == null) {
      return;
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      return;
    }

    this.runs.notifyAgentWaiters(agent, event);
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        event,
      },
      "agent.manager.notify_waiters.coalesced",
    );
  }

  private async handleStreamEvent(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    options?: HandleStreamEventOptions,
  ): Promise<boolean> {
    event = limitAgentStreamEventContent(event);
    const identified = attachManagedTurnIdentity(agent, event, options?.fromHistory === true);
    event = identified.event;
    const eventTurnId = identified.turnId;
    const isForegroundEvent = agent.activeForegroundTurnId === eventTurnId;
    this.traceHandleStreamEventStart(agent, event, eventTurnId, isForegroundEvent);
    if (
      eventTurnId &&
      isTurnTerminalEvent(event) &&
      this.runs.hasFinalizedTurn(agent, eventTurnId) &&
      this.runs.getTurnId(agent.id) !== eventTurnId
    ) {
      return false;
    }

    // Only update timestamp for live events, not history replay
    if (!options?.fromHistory) {
      this.touchUpdatedAt(agent);
      if (this.agentStreamCoalescer.handle(agent.id, event)) {
        this.traceCoalescerBuffered(agent, event, eventTurnId);
        return false;
      }
      this.agentStreamCoalescer.flushFor(agent.id);
    }

    let terminalDisposition: ActiveTurnTerminalDisposition = "untracked";
    if (isTurnTerminalEvent(event)) {
      terminalDisposition = this.applyActiveTurnTerminal(
        agent,
        eventTurnId,
        options?.fromHistory === true,
      );
    }

    event = this.settleTurnMetrics({ agent, event, options, terminalDisposition });

    const flags: StreamEventFlags = { shouldDispatchEvent: true, shouldNotifyWaiters: true };

    const dispatchPromise = this.dispatchStreamEventByType({
      agent,
      event,
      options,
      isForegroundEvent,
      eventTurnId,
      terminalDisposition,
      flags,
    });
    if (dispatchPromise) {
      await dispatchPromise;
    }

    if (!options?.fromHistory) {
      if (isTurnTerminalEvent(event)) {
        this.runs.settleTerminalRun(agent.id, eventTurnId);
        if (isForegroundEvent) {
          this.finalizeForegroundTurn(agent, eventTurnId);
        } else if (terminalDisposition !== "stale" && !agent.activeForegroundTurnId) {
          // Publish autonomous readiness only after the tracked run has settled.
          this.emitState(agent);
        }
      }

      if (flags.shouldDispatchEvent) {
        this.dispatchStream(agent.id, event, { timestamp: new Date().toISOString() });
      }
    }

    this.traceHandleStreamEventEnd(agent, event, eventTurnId, flags);

    return flags.shouldNotifyWaiters;
  }

  private traceHandleStreamEventStart(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
    isForegroundEvent: boolean,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        isForegroundEvent,
        event,
      },
      "agent.manager.handle_stream_event.start",
    );
  }

  private traceCoalescerBuffered(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        event,
      },
      "agent.manager.coalescer.buffer",
    );
  }

  private traceHandleStreamEventEnd(
    agent: ActiveManagedAgent,
    event: AgentStreamEvent,
    turnId: string | undefined,
    flags: StreamEventFlags,
  ): void {
    this.logger.trace(
      {
        agentId: agent.id,
        provider: event.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        shouldDispatchEvent: flags.shouldDispatchEvent,
        shouldNotifyWaiters: flags.shouldNotifyWaiters,
        event,
      },
      "agent.manager.handle_stream_event.end",
    );
  }

  private onStreamOptionsChanged(params: {
    agent: ActiveManagedAgent;
    patch: ProviderOptionsPatch;
    flags: StreamEventFlags;
  }): void {
    const { agent, patch, flags } = params;
    this.storeOptionsPatch({ agent, patch });
    this.updateEffectiveOptions({ agent, sent: {}, reported: patch });
    flags.shouldDispatchEvent = false;
    this.emitState(agent);
  }

  private onStreamModelChanged(
    agent: ActiveManagedAgent,
    event: Extract<AgentStreamEvent, { type: "model_changed" }>,
    flags: StreamEventFlags,
  ): void {
    agent.runtimeInfo = event.runtimeInfo;
    if (!agent.persistence && event.runtimeInfo.sessionId) {
      agent.persistence = normalizePersistenceForConfig(
        { provider: agent.provider, sessionId: event.runtimeInfo.sessionId },
        agent.config,
      );
    }
    this.applyObservedMode(agent, event.runtimeInfo.modeId ?? agent.currentModeId);
    flags.shouldDispatchEvent = false;
    this.emitState(agent);
  }

  private dispatchStreamEventByType(params: {
    agent: ActiveManagedAgent;
    event: AgentStreamEvent;
    options: HandleStreamEventOptions | undefined;
    isForegroundEvent: boolean;
    eventTurnId: string | undefined;
    terminalDisposition: ActiveTurnTerminalDisposition;
    flags: StreamEventFlags;
  }): Promise<void> | undefined {
    const { agent, event, options, isForegroundEvent, eventTurnId, terminalDisposition, flags } =
      params;
    if (event.type === "session_metrics_updated") {
      agent.sessionMetrics = sanitizeAgentMetrics(event.metrics);
      flags.shouldDispatchEvent = false;
      this.emitState(agent);
      return undefined;
    }
    switch (event.type) {
      case "thread_started":
        this.onStreamThreadStarted(agent);
        return undefined;
      case "usage_updated":
        if (!options?.fromHistory) this.durable.observeUsage(this.durableView(agent), event.usage);
        agent.lastUsage = event.usage;
        // Remember this turn's running usage so it can be billed even if the
        // turn ends via cancel/fail (no turn_completed). Reset on turn start.
        agent.currentTurnUsage = event.usage;
        this.emitState(agent);
        return undefined;
      case "mode_changed":
        this.applyObservedMode(agent, event.currentModeId);
        agent.availableModes = event.availableModes;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = { ...agent.runtimeInfo, modeId: event.currentModeId };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "model_changed":
        this.onStreamModelChanged(agent, event, flags);
        return undefined;
      case "thinking_option_changed":
        agent.config.thinkingOptionId = event.thinkingOptionId ?? undefined;
        if (agent.runtimeInfo) {
          agent.runtimeInfo = {
            ...agent.runtimeInfo,
            thinkingOptionId: event.thinkingOptionId,
          };
        }
        flags.shouldDispatchEvent = false;
        this.emitState(agent);
        return undefined;
      case "options_changed":
        this.onStreamOptionsChanged({ agent, patch: event.patch, flags });
        return undefined;
      case "timeline":
        return this.onStreamTimelineEvent({ agent, event, options, flags });
      case "turn_completed":
        this.onStreamTurnCompleted({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
        });
        return undefined;
      case "turn_failed":
        return this.onStreamTurnFailed({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
          options,
        });
      case "turn_canceled":
        this.onStreamTurnCanceled({
          agent,
          event,
          eventTurnId,
          isForegroundEvent,
          terminalDisposition,
          options,
        });
        return undefined;
      case "turn_started":
        this.onStreamTurnStarted({ agent, eventTurnId, isForegroundEvent, flags });
        return undefined;
      case "permission_requested":
        this.onStreamPermissionRequested(agent, event);
        return undefined;
      case "permission_resolved":
        this.onStreamPermissionResolved({ agent, event, options, flags });
        return undefined;
      default:
        return undefined;
    }
  }

  private refreshSessionPersistence(agent: ActiveManagedAgent): void {
    const handle = agent.session.describePersistence();
    if (handle) {
      agent.persistence = normalizePersistenceForConfig(handle, agent.config);
    }
  }

  private onStreamThreadStarted(agent: ActiveManagedAgent): void {
    const previousSessionId = agent.persistence?.sessionId ?? null;
    const handle = agent.session.describePersistence();
    if (handle) {
      agent.persistence = normalizePersistenceForConfig(handle, agent.config);
      if (agent.persistence?.sessionId !== previousSessionId) {
        this.emitState(agent);
      }
    }
    void this.refreshRuntimeInfo(agent);
  }

  private async onStreamTimelineEvent(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "timeline" }>;
    options: { fromHistory?: boolean } | undefined;
    flags: StreamEventFlags;
  }): Promise<void> {
    const { agent, event, options, flags } = params;

    flags.shouldDispatchEvent = false;
    flags.shouldNotifyWaiters = false;
    for (const item of projectAgentMessages(event.item)) {
      if (
        item.type === "user_message" &&
        item.clientMessageId &&
        this.reconcileSubmittedPromptEcho(agent, item, event.turnId)
      )
        continue;

      if (options?.fromHistory) {
        this.recordTimeline(
          agent.id,
          item,
          event.timestamp ? { timestamp: event.timestamp } : undefined,
        );
        continue;
      }

      this.recordAndDispatchTimelineItem(agent.id, item, event.provider, event.turnId);
      if (item.type === "compaction")
        this.durable.observeTimelineItem(this.durableView(agent), item);
      if (item.type === "user_message") {
        agent.lastUserMessageAt = new Date();
        this.emitState(agent);
      }
      flags.shouldNotifyWaiters = true;
    }
  }

  /**
   * Add one turn's usage into the agent's cumulative {@link usageTotals} ledger.
   * Called on turn_completed (authoritative final usage) and on
   * turn_canceled/turn_failed (the partial usage streamed before the stop), so a
   * turn that the user interrupts still counts its consumed tokens.
   */
  private accumulateUsageTotals(agent: ManagedAgent, usage: AgentUsage): void {
    const prev = agent.usageTotals ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      turns: 0,
    };
    agent.usageTotals = {
      inputTokens: prev.inputTokens + (usage.inputTokens ?? 0),
      cachedInputTokens: prev.cachedInputTokens + (usage.cachedInputTokens ?? 0),
      outputTokens: prev.outputTokens + (usage.outputTokens ?? 0),
      totalCostUsd: prev.totalCostUsd + (usage.totalCostUsd ?? 0),
      turns: prev.turns + 1,
    };
    // Record the same billed turn into the daemon's usage time-series so a
    // day/month/year dashboard can be charted (usageTotals carry no time axis).
    this.onUsageBilled?.({
      timestampMs: Date.now(),
      provider: agent.provider,
      model: agent.config?.model ?? agent.runtimeInfo?.model ?? agent.provider,
      usage,
    });
  }

  /**
   * Decides what a completed turn shows and records it on the turn's footer row, so
   * the live event and a later timeline fetch agree.
   */
  private settleTurnMetrics(params: {
    agent: ActiveManagedAgent;
    event: AgentStreamEvent;
    options: HandleStreamEventOptions | undefined;
    terminalDisposition: ActiveTurnTerminalDisposition;
  }): AgentStreamEvent {
    if (params.event.type !== "turn_completed") return params.event;
    const { agent } = params;
    const { metrics: reported, ...event } = params.event;
    // A replayed turn may have run on another model than the agent has now.
    const model = params.options?.fromHistory
      ? null
      : (agent.runtimeInfo?.model ?? agent.config.model);
    const metrics = withModelMetric(sanitizeAgentMetrics(reported), model);
    if (metrics.length === 0) return event;
    if (params.terminalDisposition !== "stale") {
      this.stampTurnMetrics(agent.id, metrics, event.turnId);
    }
    return { ...event, metrics };
  }

  private stampTurnMetrics(agentId: string, metrics: AgentMetric[], turnId?: string): void {
    const row = this.timelineStore.stampTurnMetrics(agentId, metrics, { turnId });
    if (row) this.enqueueDurableTimelineUpdate(agentId, row);
  }

  private onStreamTurnCompleted(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_completed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition } = params;
    if (isForegroundEvent) this.failover.settleTurn(agent.id);
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
      },
      "agent.manager.turn.completed",
    );
    // An out-of-band turn (Codex /compact) ends as stale; its compaction row still shows now.
    this.durable.onTurnEnded(agent.id);
    if (terminalDisposition === "stale") return;
    if (event.usage) {
      this.durable.observeUsage(this.durableView(agent), event.usage);
      agent.lastUsage = { ...agent.lastUsage, ...event.usage };
      this.accumulateUsageTotals(agent, event.usage);
    }
    // The turn reached a clean end: its usage (if any) is now billed via
    // `event.usage`, so drop the per-turn tracker to avoid re-billing it if a
    // stray canceled/failed event arrives for the same turn.
    agent.currentTurnUsage = undefined;
    // If no usage on turn_completed, keep lastUsage as-is so context window
    // data accumulated during streaming isn't lost when the provider omits
    // it from the completion event.
    agent.lastError = undefined;
    if (
      !isForegroundEvent &&
      !agent.activeForegroundTurnId &&
      agent.lifecycle !== "idle" &&
      !agent.pendingReplacement
    ) {
      (agent as ActiveManagedAgent).lifecycle = "idle";
    }
    void this.refreshRuntimeInfo(agent);
  }

  private async onStreamTurnFailed(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
    options: { fromHistory?: boolean } | undefined;
  }): Promise<void> {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition, options } = params;
    this.logger.warn(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
        error: event.error,
        code: event.code,
        diagnostic: event.diagnostic,
      },
      "handleStreamEvent: turn_failed",
    );
    if (terminalDisposition === "stale") return;
    // A failed turn may still have consumed tokens before erroring; bill the
    // usage streamed so far so it isn't lost from the cumulative ledger.
    if (agent.currentTurnUsage) {
      this.accumulateUsageTotals(agent, agent.currentTurnUsage);
      agent.currentTurnUsage = undefined;
      this.emitState(agent);
    }
    if (!isForegroundEvent && !agent.activeForegroundTurnId) {
      agent.lifecycle = "error";
    }
    agent.lastError = event.error;
    await this.appendSystemErrorTimelineMessage(
      agent,
      event.provider,
      this.formatTurnFailedMessage(event),
      options,
    );
    this.resolvePendingPermissionsForAgent(agent, event.provider, options, "Turn failed");
    if (isForegroundEvent && !options?.fromHistory) {
      this.trackBackgroundTask(this.handleFailoverAfterTurnFailure(agent.id, event));
    }
  }

  private async handleFailoverAfterTurnFailure(
    agentId: string,
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>,
  ): Promise<void> {
    try {
      await this.failover.handleTurnFailure({
        agentId,
        provider: event.provider,
        error: event.error,
        code: event.code,
        diagnostic: event.diagnostic,
      });
    } catch (error) {
      this.logger.error({ err: error, agentId }, "Failover after a usage limit failed");
    }
  }

  private onStreamTurnCanceled(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "turn_canceled" }>;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    terminalDisposition: ActiveTurnTerminalDisposition;
    options:
      | {
          fromHistory?: boolean;
        }
      | undefined;
  }): void {
    const { agent, event, eventTurnId, isForegroundEvent, terminalDisposition, options } = params;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        eventTurnId,
      },
      "agent.manager.turn.canceled",
    );
    if (terminalDisposition === "stale") return;
    // The user stopped this turn mid-flight. It still consumed tokens, so bill
    // the usage streamed so far into the cumulative ledger + persist it.
    if (agent.currentTurnUsage) {
      this.accumulateUsageTotals(agent, agent.currentTurnUsage);
      agent.currentTurnUsage = undefined;
      this.emitState(agent);
    }
    if (!isForegroundEvent && !agent.activeForegroundTurnId && !agent.pendingReplacement) {
      agent.lifecycle = "idle";
    }
    agent.lastError = undefined;
    this.resolvePendingPermissionsForAgent(agent, event.provider, options, "Interrupted");
  }

  private onStreamTurnStarted(params: {
    agent: ActiveManagedAgent;
    eventTurnId: string | undefined;
    isForegroundEvent: boolean;
    flags: StreamEventFlags;
  }): void {
    const { agent, eventTurnId, isForegroundEvent, flags } = params;
    // A fresh turn begins: clear last turn's per-turn usage tracker so a later
    // cancel/fail bills only THIS turn's usage, never a prior turn's.
    agent.currentTurnUsage = undefined;
    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: eventTurnId,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
      },
      "agent.manager.turn.started",
    );
    if (isForegroundEvent) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }
    if (agent.activeForegroundTurnId) {
      flags.shouldDispatchEvent = false;
      flags.shouldNotifyWaiters = false;
      return;
    }
    this.runs.trackAutonomousRun(agent.id, eventTurnId ?? null);
    if (eventTurnId) {
      this.openActiveTurn(agent, eventTurnId, new Date());
    }
    agent.lastError = undefined;
    if (agent.attention.requiresAttention && agent.attention.attentionReason === "error")
      agent.attention = { requiresAttention: false };
    agent.lifecycle = "running";
    this.emitState(agent);
  }

  private onStreamPermissionRequested(
    agent: ActiveManagedAgent,
    event: Extract<AgentStreamEvent, { type: "permission_requested" }>,
  ): void {
    const hadPendingPermissions = agent.pendingPermissions.size > 0;
    agent.pendingPermissions.set(event.request.id, event.request);
    if (!hadPendingPermissions && raisesAttention(agent)) {
      this.broadcastAgentAttention(agent, "permission");
    }
    this.emitState(agent);
  }

  private onStreamPermissionResolved(params: {
    agent: ActiveManagedAgent;
    event: Extract<AgentStreamEvent, { type: "permission_resolved" }>;
    options: { fromHistory?: boolean } | undefined;
    flags: StreamEventFlags;
  }): void {
    const { agent, event, options, flags } = params;
    agent.pendingPermissions.delete(event.requestId);
    if (!options?.fromHistory && agent.inFlightPermissionResponses.has(event.requestId)) {
      agent.bufferedPermissionResolutions.set(event.requestId, event);
      flags.shouldDispatchEvent = false;
      return;
    }
    this.emitState(agent);
  }

  private resolvePendingPermissionsForAgent(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    options: { fromHistory?: boolean } | undefined,
    message: string,
  ): void {
    for (const [requestId] of agent.pendingPermissions) {
      agent.pendingPermissions.delete(requestId);
      if (!options?.fromHistory) {
        this.dispatchStream(agent.id, {
          type: "permission_resolved",
          provider,
          requestId,
          resolution: { behavior: "deny", message },
        });
      }
    }
  }

  private recordAndDispatchTimelineItem(
    agentId: string,
    item: AgentTimelineItem,
    provider: AgentProvider,
    turnId?: string,
    options?: { providerMessageId?: string },
  ): AgentStreamEvent {
    const row = this.recordTimeline(agentId, item, { ...options, turnId });
    const event: AgentStreamEvent = {
      type: "timeline",
      item,
      provider,
      ...(turnId !== undefined ? { turnId } : {}),
    };
    this.dispatchStream(agentId, event, {
      seq: row.seq,
      epoch: this.timelineStore.getEpoch(agentId),
      timestamp: row.timestamp,
    });

    if (
      item.type === "tool_call" &&
      item.status === "completed" &&
      item.detail?.type === "shell" &&
      commandMayHaveChangedExternalState(item.detail.command)
    ) {
      const agent = this.agents.get(agentId);
      if (agent) {
        this.onWorkspaceStateMayHaveChanged?.({ cwd: agent.cwd });
      }
    }

    return event;
  }

  private recordSubmittedPrompt(
    agent: ActiveManagedAgent,
    prompt: AgentPromptInput,
    clientMessageId: string,
    options?: { messageId?: string; providerMessageId?: string; turnId?: string },
  ): void {
    const items = projectAgentMessages({
      type: "user_message",
      text: submittedPromptText(prompt),
      clientMessageId,
      ...(options?.messageId ? { messageId: options.messageId } : {}),
    });
    for (const item of items) this.recordSubmittedPromptItem(agent, item, options);
  }

  private recordSubmittedPromptItem(
    agent: ActiveManagedAgent,
    item: AgentTimelineItem,
    options?: { providerMessageId?: string; turnId?: string },
  ): void {
    if (
      item.type === "user_message" &&
      item.clientMessageId &&
      this.timelineStore.getSubmittedUserMessage(agent.id, item.clientMessageId)
    )
      return;
    this.touchUpdatedAt(agent);
    if (item.type === "user_message") agent.lastUserMessageAt = new Date();
    this.recordAndDispatchTimelineItem(agent.id, item, agent.provider, options?.turnId, options);
  }

  private reconcileSubmittedPromptEcho(
    agent: ActiveManagedAgent,
    item: Extract<AgentTimelineItem, { type: "user_message" }>,
    turnId?: string,
  ): AgentTimelineRow | null {
    const { clientMessageId, messageId } = item;
    if (!clientMessageId) return null;
    let existing = this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId);
    if (!existing) {
      this.recordSubmittedPromptItem(
        agent,
        { ...item, messageId: clientMessageId },
        {
          ...(messageId ? { providerMessageId: messageId } : {}),
          ...(turnId ? { turnId } : {}),
        },
      );
      existing = this.timelineStore.getSubmittedUserMessage(agent.id, clientMessageId);
    }
    if (!existing || existing.item.type !== "user_message") return null;
    if (messageId) {
      const enriched = this.timelineStore.enrichSubmittedUserMessage(
        agent.id,
        clientMessageId,
        messageId,
      );
      if (enriched) this.enqueueDurableTimelineUpdate(agent.id, enriched);
    }
    return existing;
  }

  private async appendSystemErrorTimelineMessage(
    agent: ActiveManagedAgent,
    provider: AgentProvider,
    message: string,
    options?: { fromHistory?: boolean },
  ): Promise<void> {
    if (options?.fromHistory) {
      return;
    }

    const normalized = message.trim();
    if (!normalized) {
      return;
    }

    const text = `${SYSTEM_ERROR_PREFIX} ${normalized}`;
    const lastItem = await this.getLastItemFromStores(agent.id);
    if (lastItem?.type === "assistant_message" && lastItem.text === text) {
      return;
    }

    const item: AgentTimelineItem = { type: "assistant_message", text };
    const row = this.recordTimeline(agent.id, item);
    this.dispatchStream(
      agent.id,
      {
        type: "timeline",
        item,
        provider,
      },
      {
        seq: row.seq,
        epoch: this.timelineStore.getEpoch(agent.id),
        timestamp: row.timestamp,
      },
    );
  }

  private formatTurnFailedMessage(
    event: Extract<AgentStreamEvent, { type: "turn_failed" }>,
  ): string {
    const base = event.error.trim();
    const parts = [base.length > 0 ? base : "Provider run failed"];
    const code = event.code?.trim();
    if (code) {
      parts.push(`code: ${code}`);
    }
    const diagnostic = event.diagnostic?.trim();
    if (diagnostic && diagnostic !== base) {
      parts.push(diagnostic);
    }
    return parts.join("\n\n");
  }

  private recordTimeline(
    agentId: string,
    item: AgentTimelineItem,
    options?: {
      timestamp?: string;
      providerMessageId?: string;
      turnId?: string;
    },
  ): AgentTimelineRow {
    item = limitAgentTimelineItemContent(item);
    const row = this.timelineStore.append(agentId, item, options);
    this.enqueueDurableTimelineAppend(agentId, row);
    return row;
  }

  private emitState(agent: ManagedAgent, options?: { persist?: boolean }): void {
    // Keep attention as an edge-triggered unread signal, not a level signal.
    this.checkAndSetAttention(agent);
    if (options?.persist !== false) {
      this.enqueueBackgroundPersist(agent);
    }

    this.syncControls(agent);

    this.logger.trace(
      {
        agentId: agent.id,
        provider: agent.provider,
        sessionId: agent.persistence?.sessionId ?? undefined,
        turnId: agent.activeForegroundTurnId ?? undefined,
        lifecycle: agent.lifecycle,
        activeForegroundTurnId: agent.activeForegroundTurnId,
        pendingPermissions: agent.pendingPermissions.size,
        persist: options?.persist !== false,
      },
      "agent.manager.emit_state",
    );

    this.dispatch({
      type: "agent_state",
      agent: { ...agent },
    });
  }

  private syncControls(agent: ManagedAgent): void {
    if ("session" in agent && agent.session?.controls) {
      agent.controls = agent.session.controls;
    }
  }

  private checkAndSetAttention(agent: ManagedAgent): void {
    const previousStatus = this.previousStatuses.get(agent.id);
    const currentStatus = agent.lifecycle;

    // Track the new status
    this.previousStatuses.set(agent.id, currentStatus);

    if (!raisesAttention(agent)) {
      return;
    }

    const finished = previousStatus === "running" && currentStatus === "idle";
    if (agent.attention.requiresAttention) {
      // The unread finish stays the same; the notifier knows whether the user was told about it.
      if (finished && agent.attention.attentionReason === "finished") {
        this.broadcastAgentAttention(agent, "finished");
      }
      return;
    }

    if (finished) {
      agent.attention = {
        requiresAttention: true,
        attentionReason: "finished",
        attentionTimestamp: new Date(),
      };
      this.broadcastAgentAttention(agent, "finished");
      return;
    }

    // Check if agent entered error state
    if (previousStatus !== "error" && currentStatus === "error") {
      agent.attention = {
        requiresAttention: true,
        attentionReason: "error",
        attentionTimestamp: new Date(),
      };
      this.broadcastAgentAttention(agent, "error");
      return;
    }
  }

  private enqueueBackgroundPersist(agent: ManagedAgent): void {
    const task = this.persistSnapshot(agent).catch((err) => {
      this.logger.error({ err, agentId: agent.id }, "Failed to persist agent snapshot");
    });
    this.trackBackgroundTask(task);
  }

  private enqueueDurableTimelineAppend(agentId: string, row: AgentTimelineRow): void {
    this.timelineSnapshots?.markChanged(agentId);
    if (!this.durableTimelineStore) {
      return;
    }
    const task = this.durableTimelineStore.bulkInsert(agentId, [row]).catch((err) => {
      this.logger.error(
        { err, agentId, seq: row.seq, itemType: row.item.type },
        "Failed to append timeline row to durable store",
      );
    });
    this.trackBackgroundTask(task);
  }

  private enqueueDurableTimelineBulkInsert(
    agentId: string,
    rows: readonly AgentTimelineRow[],
  ): void {
    if (!this.durableTimelineStore || rows.length === 0) {
      return;
    }
    const task = this.durableTimelineStore.bulkInsert(agentId, rows).catch((err) => {
      this.logger.error(
        { err, agentId, rowCount: rows.length },
        "Failed to seed durable timeline store",
      );
    });
    this.trackBackgroundTask(task);
  }

  private enqueueDurableTimelineUpdate(agentId: string, row: AgentTimelineRow): void {
    this.timelineSnapshots?.markChanged(agentId);
    if (!this.durableTimelineStore) return;
    const task = this.durableTimelineStore.updateCommittedRow(agentId, row).catch((err) => {
      this.logger.error(
        { err, agentId, seq: row.seq, itemType: row.item.type },
        "Failed to enrich durable timeline row",
      );
    });
    this.trackBackgroundTask(task);
  }

  private trackBackgroundTask(task: Promise<void>): void {
    this.backgroundTasks.add(task);
    void task.finally(() => {
      this.backgroundTasks.delete(task);
    });
  }

  private trackAgentRegistrationOperation<T>(result: Promise<T>): Promise<T> {
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.agentRegistrationTasks.add(settled);
    void settled.then(() => {
      this.agentRegistrationTasks.delete(settled);
      return undefined;
    });
    return result;
  }

  /**
   * Flush any background persistence work (best-effort).
   */
  async flush(): Promise<void> {
    await this.flushTasks({ includeAgentRegistrations: false });
  }

  /**
   * Flush persistence and agent registrations that crossed the synchronous
   * shutdown barrier. Those registrations own provider sessions until they
   * either install them or close them.
   */
  async flushForShutdown(): Promise<void> {
    await this.flushTasks({ includeAgentRegistrations: true });
  }

  private async flushTasks(options: { includeAgentRegistrations: boolean }): Promise<void> {
    this.agentStreamCoalescer.flushAll();
    // Drain tasks, including tasks spawned while awaiting.
    while (
      this.backgroundTasks.size > 0 ||
      (options.includeAgentRegistrations && this.agentRegistrationTasks.size > 0)
    ) {
      const pending = options.includeAgentRegistrations
        ? [...this.backgroundTasks, ...this.agentRegistrationTasks]
        : [...this.backgroundTasks];
      await Promise.allSettled(pending);
    }
  }

  private broadcastAgentAttention(
    agent: ManagedAgent,
    reason: "finished" | "error" | "permission",
  ): void {
    if (isDelegatedAgent(agent)) {
      return;
    }

    this.onAgentAttention?.({
      agentId: agent.id,
      provider: agent.provider,
      reason,
      attentionTimestamp: agent.attention.requiresAttention
        ? agent.attention.attentionTimestamp
        : null,
    });
  }

  private dispatchStream(
    agentId: string,
    event: AgentStreamEvent,
    metadata?: {
      seq?: number;
      epoch?: string;
      timestamp?: string;
    },
  ): void {
    if (event.type === "timeline") {
      event = {
        ...event,
        item: limitAgentTimelineItemContent(event.item),
      };
    }
    const agent = this.agents.get(agentId);
    this.logger.trace(
      {
        agentId,
        provider: event.provider,
        sessionId: agent?.persistence?.sessionId ?? undefined,
        turnId: getAgentStreamEventTurnId(event),
        metadata,
        event,
      },
      "agent.manager.dispatch_stream",
    );
    this.dispatch({ type: "agent_stream", agentId, event, ...metadata });
    if (this.pluginLifecycle && agent && !agent.internal && event.type !== "timeline") {
      publishAgentStream(
        this.pluginLifecycle,
        describeHookAgent({ ...agent, title: agent.config.title }),
        event,
      );
    }
  }

  private dispatch(event: AgentManagerEvent): void {
    for (const subscriber of this.subscribers) {
      if (
        subscriber.agentId &&
        (event.type === "agent_stream" || event.type === "agent_removed") &&
        subscriber.agentId !== event.agentId
      ) {
        continue;
      }
      if (
        subscriber.agentId &&
        event.type === "background_work" &&
        subscriber.agentId !== event.agentId
      ) {
        continue;
      }
      if (
        subscriber.agentId &&
        event.type === "agent_state" &&
        subscriber.agentId !== event.agent.id
      ) {
        continue;
      }
      if (
        subscriber.agentId &&
        event.type === "provider_subagent" &&
        subscriber.agentId !==
          (event.event.type === "upsert"
            ? event.event.subagent.parentAgentId
            : event.event.parentAgentId)
      ) {
        continue;
      }
      // Skip internal agents for global subscribers (those without a specific agentId)
      if (!subscriber.agentId && this.eventBelongsToInternalAgent(event)) {
        continue;
      }
      subscriber.callback(event);
    }
  }

  private eventBelongsToInternalAgent(event: AgentManagerEvent): boolean {
    if (event.type === "agent_state") return event.agent.internal === true;
    if (event.type === "agent_removed") return event.internal;
    if (event.type === "agent_stream") return this.agents.get(event.agentId)?.internal === true;
    if (event.type === "background_work") return this.agents.get(event.agentId)?.internal === true;
    if (event.type !== "provider_subagent") return false;
    const parentAgentId =
      event.event.type === "upsert"
        ? event.event.subagent.parentAgentId
        : event.event.parentAgentId;
    return this.agents.get(parentAgentId)?.internal === true;
  }

  private async normalizeConfig(
    config: AgentSessionConfig,
    options: NormalizeConfigOptions = {},
  ): Promise<AgentSessionConfig> {
    const normalized: AgentSessionConfig = { ...this.withConvertedOptions(config) };

    // Always resolve cwd to absolute path for consistent history file lookup
    if (normalized.cwd) {
      normalized.cwd = resolve(normalized.cwd);
      // Only a session that will run in the directory needs it to still be there. Reading
      // an archived agent's history runs nothing, and must survive the worktree it ran in
      // being removed when its workspace was archived.
      if (options.purpose !== "history") {
        await assertUsableWorkingDirectory(normalized.cwd);
      }
    }

    if (typeof normalized.model === "string") {
      const trimmed = normalized.model.trim();
      normalized.model = trimmed.length > 0 && trimmed !== "default" ? trimmed : undefined;
    }

    const shouldResolveDefaultModel = options.resolveDefaultModel ?? true;
    if (shouldResolveDefaultModel && !normalized.model) {
      const defaultModelId = await this.resolveDefaultModelId(normalized);
      if (defaultModelId) {
        normalized.model = defaultModelId;
      }
    }

    return this.applyProviderConfiguration(normalized);
  }

  private applyProviderConfiguration(config: AgentSessionConfig): AgentSessionConfig {
    const definition = this.providerDefinitions.get(config.provider);
    this.validateToolPolicyServers(config);
    if (config.toolPolicy && !definition?.applyToolPolicy) {
      throw new Error(
        `Provider '${config.provider}' cannot preapprove exact MCP tools for unattended execution`,
      );
    }
    return definition?.applyToolPolicy
      ? definition.applyToolPolicy(config, config.toolPolicy)
      : config;
  }

  private validateToolPolicyServers(config: AgentSessionConfig): void {
    if (!config.toolPolicy) return;
    const serverNames = new Set(Object.keys(config.mcpServers ?? {}));
    for (const grant of config.toolPolicy.preapproved) {
      if (!serverNames.has(grant.server)) {
        throw new Error(
          `toolPolicy preapproval '${grant.server}.${grant.tool}' requires MCP server '${grant.server}' in the same agent request`,
        );
      }
    }
  }

  private async resolveDefaultModelId(config: AgentSessionConfig): Promise<string | undefined> {
    const client = this.clients.get(config.provider);
    if (!client) {
      return undefined;
    }
    try {
      const catalog = await client.fetchCatalog({
        scope: "workspace",
        cwd: config.cwd,
        force: false,
      });
      return (catalog.models.find((model) => model.isDefault) ?? catalog.models[0])?.id;
    } catch {
      // Provider may not support model listing — leave model undefined.
      return undefined;
    }
  }

  /** The adapter a provider id runs on: a custom provider is named by the one it extends. */
  private adapterOf(provider: AgentProvider): AgentProvider {
    return resolveAdapter({
      provider,
      extendsOf: (id) => this.providerDefinitions.get(id)?.derivedFromProviderId,
    });
  }

  /**
   * Options older data carries are converted for the adapter the provider runs on, before
   * defaults merge and before anything is stored; nothing past the manager sees the old keys.
   */
  private convertLegacyOptions<T extends ProviderOptions | undefined>(
    provider: AgentProvider,
    options: T,
  ): T {
    return convertLegacyOptions({ provider: this.adapterOf(provider), options }) as T;
  }

  private withConvertedOptions(config: AgentSessionConfig): AgentSessionConfig {
    const providerOptions = this.convertLegacyOptions(config.provider, config.providerOptions);
    return providerOptions === config.providerOptions ? config : { ...config, providerOptions };
  }

  private async prepareSessionConfig(
    config: AgentSessionConfig,
    agentId: string,
    options: NormalizeConfigOptions = {},
  ): Promise<PreparedSessionConfig> {
    const storedConfig = await this.normalizeConfig(stripInternalJAgentDeskMcpServer(config), {
      env: options.env,
      purpose: options.purpose,
      resolveDefaultModel: options.resolveDefaultModel,
    });
    const mcpBaseUrl =
      this.jagentdeskToolsEnabled &&
      isJAgentDeskToolPolicyEnabled(this.resolveJAgentDeskToolPolicy(storedConfig.provider))
        ? this.mcpBaseUrl
        : null;
    const launchConfig = this.applyDaemonAppendSystemPrompt(
      withRuntimeJAgentDeskMcpServer({
        config: storedConfig,
        agentId,
        mcpBaseUrl,
        mcpAuthToken: this.mcpAuthToken,
      }),
      {
        sessionLedgerTool: Boolean(mcpBaseUrl),
        identity: agentIdentityInstruction({
          agentId,
          title: storedConfig.title,
          cwd: storedConfig.cwd,
          agentTools: Boolean(mcpBaseUrl),
        }),
      },
    );
    return { storedConfig, launchConfig };
  }

  private withAgentShimEnv(env: Record<string, string>): Record<string, string> {
    if (!this.agentShimDir) return env;
    return {
      ...env,
      ...agentShimEnv({ dir: this.agentShimDir, basePath: env.PATH ?? process.env.PATH }),
    };
  }

  /** Spec 42 §4: agents are told to save lessons only while Memory and the switch are on. */
  private lessonLearningEnabled(): boolean {
    if (!this.durablePorts?.memory()) return false;
    return this.durablePorts.settings()?.learnFromCorrections ?? true;
  }

  private applyDaemonAppendSystemPrompt(
    config: AgentSessionConfig,
    options: { sessionLedgerTool?: boolean; identity?: string } = {},
  ): AgentSessionConfig {
    const daemonAppendSystemPrompt =
      composeSystemPromptParts(
        this.appendSystemPrompt,
        options.identity,
        options.sessionLedgerTool ? SESSION_LEDGER_INSTRUCTION : undefined,
        options.sessionLedgerTool && this.lessonLearningEnabled() ? LESSON_INSTRUCTION : undefined,
      ) ?? "";
    const operatorContext = this.operatorContext.trim();
    const next = { ...config };
    delete next.daemonAppendSystemPrompt;

    if (daemonAppendSystemPrompt) {
      next.daemonAppendSystemPrompt = daemonAppendSystemPrompt;
    }
    // Operator / engagement authorization context leads the system prompt so every provider (which all
    // compose config.systemPrompt first) surfaces it as leading context ahead of persona/task
    // instructions. Runtime-only: applied to the launch copy, never persisted per-agent, so operator
    // setting changes apply cleanly. Injection only — the underlying model still applies its own judgment.
    if (operatorContext) {
      next.systemPrompt = next.systemPrompt?.trim()
        ? `${operatorContext}\n\n${next.systemPrompt}`
        : operatorContext;
    }
    return next;
  }

  private canUseNativeJAgentDeskTools(
    client: AgentClient,
    policy?: ProviderJAgentDeskToolsPolicy,
  ): boolean {
    return (
      this.jagentdeskToolsEnabled &&
      isJAgentDeskToolPolicyEnabled(policy) &&
      client.capabilities.supportsNativeJAgentDeskTools === true
    );
  }

  private async buildLaunchContext(
    agentId: string,
    client: AgentClient,
    cwd: string,
    env?: Record<string, string>,
    opening?: {
      workspaceId?: string | null;
      reason?: PluginSessionOpenRequest["reason"];
      purpose?: PluginSessionOpenRequest["purpose"];
      title?: string | null;
      background?: boolean;
      labels?: Record<string, string>;
      metadata?: AgentMetadata;
    },
  ): Promise<AgentLaunchContext> {
    // A plugin changing during this open must still make the resulting session stale.
    const generation = this.sessionOpenGeneration;
    const jagentdeskToolPolicy = this.resolveJAgentDeskToolPolicy(client.provider);
    this.jagentdeskToolPolicies.set(agentId, jagentdeskToolPolicy);
    this.detachPluginTools(agentId);
    const hostTools = this.adoptHostToolSet(agentId, opening?.purpose);
    let appendSystemPrompt: string[] | undefined;
    let mcpServers: AgentSessionConfig["mcpServers"];
    let mcpServerOwners: Record<string, string> | undefined;
    if (this.pluginLifecycle) {
      const request = {
        agentId,
        provider: client.provider,
        cwd,
        workspaceId: opening?.workspaceId ?? null,
        reason: opening?.reason ?? "resume",
        purpose: opening?.purpose ?? "interactive",
        env: { ...env },
        title: opening?.title ?? null,
        ...pluginOpeningVisibility(opening),
        ...agentEntityData(opening),
        tools: [],
        mcpServers: {},
      };
      const transformed = await this.pluginLifecycle.before("agent.open.before", request);
      env = transformed.env;
      if (request.purpose === "interactive") {
        this.attachedPluginTools.set(agentId, transformed.tools as AttachedAgentTool[]);
        appendSystemPrompt = transformed.appendSystemPrompt;
        mcpServers = transformed.mcpServers;
        mcpServerOwners = transformed.mcpServerOwners;
      }
    }
    const context: AgentLaunchContext = {
      agentId,
      ...(this.durablePorts ? { compactionHooks: this.durable.hooksFor(agentId) } : {}),
      ...hostTools,
      ...pluginPromptContext(appendSystemPrompt),
      mcpServers,
      mcpServerOwners,
      env: this.withAgentShimEnv({
        ...env,
        ...this.launchEnvProvider?.(agentId),
        ...agentIdentityEnv({ agentId, cwd, opening }),
      }),
    };
    const useNativeTools = this.canUseNativeJAgentDeskTools(client, jagentdeskToolPolicy);
    if (
      this.jagentdeskToolCatalogFactory &&
      (useNativeTools || this.getPluginTools(agentId).length > 0)
    ) {
      try {
        const catalog = await this.jagentdeskToolCatalogFactory({
          callerAgentId: agentId,
          callerAgentLabels: opening?.labels,
          jagentdeskToolPolicy,
        });
        if (useNativeTools) context.jagentdeskTools = catalog;
      } catch (error) {
        this.detachPluginTools(agentId);
        throw error;
      }
    }
    this.sessionOpenGenerations.set(agentId, generation);
    return context;
  }

  /**
   * Every launch (create, resume, reload, idle-runtime resume) opens with the host's current
   * tool groups; the per-agent snapshot only keeps one runtime's tools consistent. Records the
   * launch's tool instructions, which `resolveProviderLaunchConfig` joins into the daemon prompt.
   */
  private adoptHostToolSet(
    agentId: string,
    purpose: PluginSessionOpenRequest["purpose"] | undefined,
  ): Pick<AgentLaunchContext, "inAppBrowser" | "hideProviderConnectors"> {
    this.unappliedHostToolSets.delete(agentId);
    this.hostToolInstructions.delete(agentId);
    if (!this.hostToolSet) return {};
    this.hostToolSet.adopt(agentId);
    const interactive = (purpose ?? "interactive") === "interactive";
    const instructions = interactive ? this.hostToolSet.instructions(agentId) : [];
    if (instructions.length) this.hostToolInstructions.set(agentId, instructions);
    const hidden =
      interactive && this.hideProviderConnectors()
        ? (this.hostToolSet.replacedProviderConnectors?.(agentId) ?? [])
        : [];
    this.launchedHostHints.set(agentId, hostHintsSignature(instructions, hidden));
    return {
      ...(this.hostToolSet.inAppBrowser(agentId) ? { inAppBrowser: true } : {}),
      ...(hidden.length ? { hideProviderConnectors: hidden } : {}),
    };
  }

  private resolveProviderLaunchConfig(
    launchConfig: AgentSessionConfig,
    launchContext: AgentLaunchContext,
  ): AgentSessionConfig {
    const savedServerNames = new Set(
      Object.keys(stripInternalJAgentDeskMcpServer(launchConfig).mcpServers ?? {}),
    );
    for (const name of Object.keys(launchContext.mcpServers ?? {})) {
      const owner = launchContext.mcpServerOwners?.[name];
      if (name === JAGENTDESK_MCP_SERVER_NAME || savedServerNames.has(name)) {
        const existingOwner = savedServerNames.has(name)
          ? "agent saved configuration"
          : "JAgentDesk internal MCP server";
        throw new Error(`MCP server '${name}' from plugin ${owner} collides with ${existingOwner}`);
      }
    }
    launchConfig = {
      ...withHostToolInstructions(
        launchConfig,
        this.hostToolInstructions.get(launchContext.agentId ?? ""),
      ),
      pluginAppendSystemPrompt: launchContext.appendSystemPrompt,
    };
    const merged =
      Object.keys(launchContext.mcpServers ?? {}).length > 0
        ? {
            ...launchConfig,
            mcpServers: { ...launchConfig.mcpServers, ...launchContext.mcpServers },
          }
        : launchConfig;
    return launchContext.jagentdeskTools ? stripInternalJAgentDeskMcpServer(merged) : merged;
  }

  private async requireAvailableClient(options: { provider: AgentProvider }): Promise<AgentClient> {
    const client = this.clients.get(options.provider);
    if (!client) {
      const configuredProviders = this.getConfiguredProviderIds();
      throw new Error(
        `Unknown provider '${options.provider}'. Configured providers: ${formatProviderList(
          configuredProviders,
        )}.`,
      );
    }

    let unavailableReason: string | null = null;
    try {
      const available = await client.isAvailable();
      if (available) {
        return client;
      }
    } catch (error) {
      unavailableReason = error instanceof Error ? error.message : String(error);
    }

    const availableProviders = (await this.listProviderAvailability())
      .filter((entry) => entry.available)
      .map((entry) => entry.provider);
    const providerList = formatProviderList(availableProviders);
    const reason = unavailableReason ? ` Reason: ${unavailableReason}.` : "";
    throw new Error(
      `Provider '${options.provider}' is not available.${reason} Available providers: ${providerList}. Use one of those providers, or install/configure '${options.provider}'.`,
    );
  }

  private requireEnabledProvider(provider: AgentProvider): void {
    if (this.providerEnabled.get(provider) === false) {
      throw new Error(`Provider '${provider}' is disabled`);
    }
  }

  private getConfiguredProviderIds(): AgentProvider[] {
    return Array.from(new Set([...this.providerEnabled.keys(), ...this.clients.keys()]));
  }

  private requireClient(provider: AgentProvider): AgentClient {
    const client = this.clients.get(provider);
    if (!client) {
      throw new Error(`No client registered for provider '${provider}'`);
    }
    return client;
  }

  private async syncNativeArchiveState(
    provider: AgentProvider,
    persistence: AgentPersistenceHandle | null | undefined,
    state: "archive" | "restore",
  ): Promise<void> {
    if (!persistence) return;
    const client = this.clients.get(provider);
    const sync =
      state === "archive" ? client?.archiveNativeSession : client?.unarchiveNativeSession;
    if (!sync) return;
    if (state === "restore") {
      await sync.call(client, persistence);
      return;
    }
    try {
      await sync.call(client, persistence);
    } catch (error) {
      this.logger.warn(
        { error, provider, sessionId: persistence.sessionId },
        "Failed to archive native session (best-effort)",
      );
    }
  }

  private requireAgent(id: string): LiveManagedAgent {
    const normalizedId = validateAgentId(id, "requireAgent");
    const agent = this.agents.get(normalizedId);
    if (!agent) {
      throw new Error(`Unknown agent '${normalizedId}'`);
    }
    return agent;
  }

  private requireSessionAgent(id: string): ActiveManagedAgent {
    const agent = this.requireAgent(id);
    if (agent.session === null) {
      throw new Error(`Agent '${agent.id}' has no managed session`);
    }
    return agent;
  }

  private requirePublicAgent(id: string): LiveManagedAgent {
    const agent = this.requireAgent(id);
    if (agent.internal) {
      throw new Error(`Unknown agent '${agent.id}'`);
    }
    return agent;
  }
}

function matchesImportableSessionQuery(
  session: ImportableProviderSession,
  rawQuery: string | undefined,
): boolean {
  const query = rawQuery?.trim().toLowerCase();
  if (!query) return true;
  const cwdBasename = basename(session.cwd.replaceAll("\\", "/"));
  return [session.title, session.firstPromptPreview, session.lastPromptPreview, cwdBasename].some(
    (value) => value?.toLowerCase().includes(query),
  );
}

export function commandMayHaveChangedExternalState(command: string): boolean {
  const normalized = command.toLowerCase();
  // Commands that operate on remote state and do NOT trigger local file
  // watchers. Local git mutations (commit, checkout, merge, rebase, reset,
  // pull) are already caught by watchers on .git/HEAD and refs/heads/.
  return (
    // GitHub PR operations (merge, close, create, edit, comment, review)
    /\bgh\s+pr\s+(merge|close|create|edit|comment|review)\b/.test(normalized) ||
    // Pushes to remote — local refs unchanged, but remote state (PR checks,
    // mergeable status) may shift immediately after.
    /\bgit\s+push\b/.test(normalized) ||
    // Fetches update refs/remotes/ which our watchers do not watch, so
    // ahead/behind counts can drift stale until the next refresh.
    /\bgit\s+fetch\b/.test(normalized)
  );
}

// Joined into the daemon prompt rather than the plugin prompt: every provider reads it, and
// Codex before 0.121 refuses plugin prompts on a new thread.
function withHostToolInstructions(
  config: AgentSessionConfig,
  instructions: string[] | undefined,
): AgentSessionConfig {
  if (!instructions?.length) return config;
  const daemonAppendSystemPrompt = [config.daemonAppendSystemPrompt, ...instructions]
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n\n");
  return { ...config, daemonAppendSystemPrompt };
}

function pluginPromptContext(
  appendSystemPrompt: string[] | undefined,
): Pick<AgentLaunchContext, "appendSystemPrompt"> {
  return appendSystemPrompt?.length ? { appendSystemPrompt } : {};
}

function pluginOpeningVisibility(opening?: {
  labels?: Record<string, string>;
  background?: boolean;
}) {
  return { labels: opening?.labels ?? {}, background: opening?.background === true };
}

function resumeLaunchIdentity(
  record: StoredAgentRecord | null,
  config: AgentSessionConfig,
  options:
    | { labels?: Record<string, string>; background?: boolean; metadata?: AgentMetadata }
    | undefined,
) {
  return {
    title: record?.title ?? config.title ?? null,
    labels: record?.labels ?? options?.labels ?? {},
    background: options?.background,
    metadata: (record ?? options)?.metadata,
  };
}
