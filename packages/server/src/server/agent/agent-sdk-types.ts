import type {
  AgentOptionControl,
  AgentOptionSelectControl,
  AgentOptionToggleControl,
} from "@jagentdesk/protocol/agent-types";
export type { AgentOptionControl, AgentOptionSelectControl, AgentOptionToggleControl };
import type {
  ContextCompactionNotice,
  ProviderSwitchNotice,
  RegroundingNotice,
  UsageLimitNotice,
} from "@jagentdesk/protocol/agent-types";
export type { ContextCompactionNotice, ProviderSwitchNotice, RegroundingNotice, UsageLimitNotice };
import type { AgentMessage } from "@jagentdesk/protocol/agent-message";
import type { Options as ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentFeature,
  AgentFeatureSelect,
  AgentFeatureToggle,
  AgentMetric,
  AgentProviderNotice,
  AgentTaskItem,
  ProviderOptions,
  ToolPolicy,
} from "@jagentdesk/protocol/agent-types";
import {
  type AgentAttachment,
  type ProviderInstallationInspection,
} from "@jagentdesk/protocol/messages";
import {
  type ProviderInspection,
  type ProviderUpdateCheck,
  type ProviderUpdateReport,
  type ProviderUpdateResult,
} from "@jagentdesk/plugin/server/provider";
import { type JAgentDeskToolCatalog } from "./tools/types.js";

export type {
  AgentFeature,
  AgentFeatureSelect,
  AgentFeatureToggle,
  AgentMetric,
  AgentProviderNotice,
  AgentTaskItem,
};

export type AgentProvider = string;

export interface AgentMetadata {
  [key: string]: unknown;
}

/**
 * Stdio-based MCP server (spawns a subprocess).
 */
export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * HTTP-based MCP server.
 */
export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * SSE-based MCP server (Server-Sent Events over HTTP).
 */
export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  /**
   * When true, all tools from this server are always included in the prompt
   * and never deferred behind tool search. Honored by the Claude provider.
   */
  alwaysLoad?: boolean;
}

/**
 * Canonical MCP server configuration.
 * Discriminated union by `type` field.
 * Each provider normalizes this to their expected format.
 */
export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig;

export interface AgentMode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  colorTier?: string;
  isUnattended?: boolean;
}

export type ProviderStatus = "ready" | "loading" | "error" | "unavailable";

export interface AgentModelDefinition {
  provider: AgentProvider;
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
  contextWindowMaxTokens?: number;
  thinkingOptions?: AgentSelectOption[];
  defaultThinkingOptionId?: string;
  aliases?: string[];
  isSelectable?: boolean;
}

export interface AgentSelectOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: AgentMetadata;
}

export function normalizeAgentModelDefinition(model: AgentModelDefinition): AgentModelDefinition {
  const defaultThinkingOptionId =
    model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id;
  if (!defaultThinkingOptionId || defaultThinkingOptionId === model.defaultThinkingOptionId) {
    return model;
  }
  return { ...model, defaultThinkingOptionId };
}

export function filterSelectableAgentModels(
  models: AgentModelDefinition[] | undefined,
): AgentModelDefinition[] {
  return models?.filter((model) => model.isSelectable !== false) ?? [];
}

export interface ProviderSnapshotEntry {
  provider: AgentProvider;
  status: ProviderStatus;
  enabled: boolean;
  source?: "builtin" | "custom";
  error?: string;
  models?: AgentModelDefinition[];
  modes?: AgentMode[];
  fetchedAt?: string;
  label?: string;
  description?: string;
  iconSvg?: string;
  /** The page that helps users set up and troubleshoot this provider. */
  docsUrl?: string;
  defaultModeId?: string | null;
}

export interface AgentCreateConfigParent {
  provider: AgentProvider;
  modeId: string | null;
  isUnattended: boolean;
}

export interface ResolveAgentCreateConfigInput {
  provider: AgentProvider;
  requestedMode: string | undefined;
  providerOptions: ProviderOptions | undefined;
  parent: AgentCreateConfigParent | null;
  unattended: boolean;
  availableModes: AgentMode[] | undefined;
}

export interface ResolveAgentCreateConfigResult {
  modeId: string | undefined;
  providerOptions: ProviderOptions | undefined;
}

export interface AgentCreateConfigUnattendedInput {
  modeId: string | null;
  config: AgentSessionConfig;
  controls?: AgentOptionControl[];
  availableModes: AgentMode[];
}

export interface AgentCapabilityFlags {
  [capability: string]: boolean | undefined;
  supportsStreaming: boolean;
  supportsSessionPersistence: boolean;
  supportsSessionListing?: boolean;
  supportsDynamicModes: boolean;
  supportsMcpServers: boolean;
  supportsNativeJAgentDeskTools?: boolean;
  supportsReasoningStream: boolean;
  supportsToolInvocations: boolean;
  supportsRewindConversation?: boolean;
  supportsRewindFiles?: boolean;
  supportsRewindBoth?: boolean;
}

export interface AgentPersistenceHandle {
  provider: AgentProvider;
  sessionId: string;
  /** Provider specific handle (Codex thread id, Claude resume token, etc). */
  nativeHandle?: string;
  metadata?: AgentMetadata;
}

export type AgentPromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | AgentAttachment;

export type AgentPromptInput = string | AgentPromptContentBlock[];

export interface AgentRunOptions {
  outputSchema?: unknown;
  resumeFrom?: AgentPersistenceHandle;
  maxThinkingTokens?: number;
  clientMessageId?: string;
}

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export const TOOL_CALL_ICON_NAMES = [
  "wrench",
  "square_terminal",
  "eye",
  "pencil",
  "search",
  "bot",
  "sparkles",
  "brain",
  "mic_vocal",
] as const;

export type ToolCallIconName = (typeof TOOL_CALL_ICON_NAMES)[number];

export type ToolCallDetail =
  | {
      type: "shell";
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
    }
  | {
      type: "read";
      filePath: string;
      content?: string;
      offset?: number;
      limit?: number;
    }
  | {
      type: "edit";
      filePath: string;
      oldString?: string;
      newString?: string;
      unifiedDiff?: string;
    }
  | {
      type: "write";
      filePath: string;
      content?: string;
    }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: Array<{
        title: string;
        url: string;
      }>;
      annotations?: string[];
      numFiles?: number;
      numMatches?: number;
      durationMs?: number;
      durationSeconds?: number;
      truncated?: boolean;
      mode?: "content" | "files_with_matches" | "count";
    }
  | {
      type: "fetch";
      url: string;
      prompt?: string;
      result?: string;
      code?: number;
      codeText?: string;
      bytes?: number;
      durationMs?: number;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
      log: string;
      commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
      }>;
      truncated?: boolean;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      // COMPAT(subagent-log): added in v0.14.1, remove after 2027-04-30. Apps before v0.14.1
      // require `log`; every producer sends it empty and carries the same tag. Optional here because
      // protocol timeline items, where `log` is optional, flow into this type.
      log?: string;
      actions?: Array<{
        index: number;
        toolName: string;
        summary?: string;
      }>;
    }
  | {
      type: "plain_text";
      label?: string;
      text?: string;
      icon?: ToolCallIconName;
    }
  | {
      type: "plan";
      text: string;
    }
  | {
      type: "unknown";
      input: unknown;
      output: unknown;
    };

interface ToolCallBase {
  [key: string]: unknown;
  type: "tool_call";
  callId: string;
  name: string;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
  /** Set when the row is a delivered agent message rather than a provider tool call. */
  agentMessage?: AgentMessage;
}

type ToolCallRunningTimelineItem = ToolCallBase & {
  status: "running";
  error: null;
};

type ToolCallCompletedTimelineItem = ToolCallBase & {
  status: "completed";
  error: null;
};

type ToolCallFailedTimelineItem = ToolCallBase & {
  status: "failed";
  error: unknown;
};

type ToolCallCanceledTimelineItem = ToolCallBase & {
  status: "canceled";
  error: null;
};

export type ToolCallTimelineItem =
  | ToolCallRunningTimelineItem
  | ToolCallCompletedTimelineItem
  | ToolCallFailedTimelineItem
  | ToolCallCanceledTimelineItem;

export interface CompactionTimelineItem {
  [key: string]: unknown;
  type: "compaction";
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}

export interface PluginTimelineItem {
  [key: string]: unknown;
  type: "plugin";
  id: string;
  pluginId: string;
  kind: string;
  version: number;
  data: import("@jagentdesk/protocol/agent-types").JsonValue;
}

export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string; clientMessageId?: string }
  | { type: "assistant_message"; text: string; messageId?: string }
  | { type: "reasoning"; text: string }
  | ToolCallTimelineItem
  | { type: "todo"; items: AgentTaskItem[] }
  | { type: "error"; message: string }
  | {
      type: "notification";
      level: "info" | "warning" | "error";
      message: string;
      /** Set on the row a provider switch appends (spec 40 §3). */
      providerSwitch?: ProviderSwitchNotice;
      /** Set on the row a usage-limit failure appends when no failover ran (spec 40 §4). */
      usageLimit?: UsageLimitNotice;
      /** Set on the "Context compacted" row (spec 42 §1). */
      contextCompaction?: ContextCompactionNotice;
      /** Set on the "Re-grounded after compaction" row (spec 42 §2). */
      regrounding?: RegroundingNotice;
    }
  | CompactionTimelineItem
  | PluginTimelineItem;

export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string; provider: AgentProvider }
  | { type: "turn_started"; provider: AgentProvider; turnId?: string }
  | {
      type: "turn_completed";
      provider: AgentProvider;
      usage?: AgentUsage;
      turnId?: string;
      /** Shown on the completed turn's footer. */
      metrics?: AgentMetric[];
    }
  | { type: "usage_updated"; provider: AgentProvider; usage: AgentUsage; turnId?: string }
  /** Full replacement of the metrics shown for the session. An empty list clears them. */
  | { type: "session_metrics_updated"; provider: AgentProvider; metrics: AgentMetric[] }
  | {
      type: "mode_changed";
      provider: AgentProvider;
      currentModeId: string | null;
      availableModes: AgentMode[];
    }
  | { type: "model_changed"; provider: AgentProvider; runtimeInfo: AgentRuntimeInfo }
  | {
      type: "thinking_option_changed";
      provider: AgentProvider;
      thinkingOptionId: string | null;
    }
  /**
   * The provider changed options on its own: after `createSession`/`resumeSession` or
   * `applyOptions` it ended up different from what it was given, or later it changed a setting
   * itself. The daemon stores the patch and forwards it; it does not undo it. `null` removes the
   * agent's own value. Only for changes that happen on the provider's own initiative: the result
   * of opening goes in `openOptionsPatch` and the result of `applyOptions` is its return value.
   */
  | { type: "options_changed"; provider: AgentProvider; patch: Record<string, unknown> }
  | {
      type: "turn_failed";
      provider: AgentProvider;
      error: string;
      code?: string;
      diagnostic?: string;
      turnId?: string;
    }
  | { type: "turn_canceled"; provider: AgentProvider; reason: string; turnId?: string }
  | {
      type: "timeline";
      item: AgentTimelineItem;
      provider: AgentProvider;
      turnId?: string;
      timestamp?: string;
    }
  | {
      type: "permission_requested";
      provider: AgentProvider;
      request: AgentPermissionRequest;
      turnId?: string;
    }
  | {
      type: "permission_resolved";
      provider: AgentProvider;
      requestId: string;
      resolution: AgentPermissionResponse;
      turnId?: string;
    }
  | {
      type: "attention_required";
      provider: AgentProvider;
      reason: "finished" | "error" | "permission";
      timestamp: string;
    }
  | {
      type: "provider_subagent";
      provider: AgentProvider;
      event: import("./provider-subagents/store.js").ProviderSubagentInputEvent;
    }
  | {
      /** Full replacement of the agent's live background work (shells, monitors…). */
      type: "background_work";
      provider: AgentProvider;
      items: import("./background-work/index.js").AgentBackgroundWorkInput[] | null;
    };

export function getAgentStreamEventTurnId(event: AgentStreamEvent): string | undefined {
  return "turnId" in event ? event.turnId : undefined;
}

export type AgentPermissionRequestKind = "tool" | "plan" | "question" | "mode" | "other";

export type AgentPermissionUpdate = AgentMetadata;

export interface AgentPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
  intent?: "implement" | "implement_resume" | "dismiss";
}

export interface AgentPermissionRequest {
  id: string;
  provider: AgentProvider;
  name: string;
  kind: AgentPermissionRequestKind;
  title?: string;
  description?: string;
  input?: AgentMetadata;
  detail?: ToolCallDetail;
  suggestions?: AgentPermissionUpdate[];
  actions?: AgentPermissionAction[];
  metadata?: AgentMetadata;
}

export type AgentPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: AgentMetadata;
      updatedPermissions?: AgentPermissionUpdate[];
    }
  | {
      behavior: "deny";
      selectedActionId?: string;
      message?: string;
      interrupt?: boolean;
    };

/** A requested turn was canceled before the provider accepted it. */
export class AgentTurnStartCanceledError extends Error {
  constructor() {
    super("Turn was canceled before starting");
    this.name = "AgentTurnStartCanceledError";
  }
}

export interface AgentRunResult {
  sessionId: string;
  finalText: string;
  usage?: AgentUsage;
  timeline: AgentTimelineItem[];
  canceled?: boolean;
}

export interface AgentRuntimeInfo {
  provider: AgentProvider;
  sessionId: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  modeId?: string | null;
  extra?: AgentMetadata;
}

export type AgentSlashCommandKind = "command" | "skill";

/**
 * Represents a slash command available in an agent session.
 * Commands are executed by sending them as prompts with / prefix.
 */
export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: AgentSlashCommandKind;
}

export interface ListImportableSessionsOptions {
  providerOptions?: ProviderOptions;
  limit?: number;
  /**
   * How many candidate sessions to scan before ranking down to `limit`. Lets a
   * host-wide search page deeper than the returned window; capped by the provider.
   */
  scanLimit?: number;
  /**
   * Optional cwd hint. Providers that can cheaply pre-filter importable
   * sessions by working directory should do so before doing expensive work.
   */
  cwd?: string;
}

export interface ImportableProviderSession {
  providerHandleId: string;
  cwd: string;
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: Date;
}

export interface ImportProviderSessionInput {
  providerHandleId: string;
  cwd: string;
}

export interface ImportProviderSessionContext {
  config: AgentSessionConfig;
  storedConfig: AgentSessionConfig;
  launchContext?: AgentLaunchContext;
}

export interface ImportedTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
  /** Set on the last entry of a turn the provider reported stats for. */
  turnMetrics?: AgentMetric[];
}

export interface ImportedProviderSession {
  session: AgentSession;
  config: AgentSessionConfig;
  persistence: AgentPersistenceHandle;
  timeline: ImportedTimelineEntry[];
  sessionMetrics?: AgentMetric[];
  providerSubagentEvents?: Extract<AgentStreamEvent, { type: "provider_subagent" }>[];
}

export interface AgentSessionConfig {
  provider: AgentProvider;

  cwd: string;

  /**
   * Provider-agnostic system/developer instruction string.
   * Mapped by each provider to its native instruction field.
   */
  systemPrompt?: string;

  /**
   * Daemon-level instructions appended at runtime. This is deliberately not
   * persisted into agent config so daemon setting changes apply cleanly.
   */
  daemonAppendSystemPrompt?: string;

  /** Plugin instructions for this launch; never persisted. */
  pluginAppendSystemPrompt?: string[];

  modeId?: string;

  model?: string;

  thinkingOptionId?: string;

  title?: string | null;

  approvalPolicy?: string;

  sandboxMode?: string;

  networkAccess?: boolean;

  webSearch?: boolean;

  extra?: {
    codex?: AgentMetadata;
    claude?: Partial<ClaudeAgentOptions>;
  };

  providerOptions?: ProviderOptions;

  toolPolicy?: ToolPolicy;

  mcpServers?: Record<string, McpServerConfig>;

  /**
   * Internal agents are hidden from listings and don't trigger notifications.
   * They are used for ephemeral system tasks like commit/PR generation.
   */
  internal?: boolean;
}

/**
 * Spec 42 §3: provider compaction hooks (Claude PreCompact / PostCompact). Runtime-only, never
 * persisted; providers without compaction hooks ignore it.
 */
export interface AgentCompactionHooks {
  /** Extra instructions for the compaction itself, or null to add none. */
  preCompactInstruction(): string | null;
  /** The provider's own summary after a compaction, kept to compare with the ledger. */
  onCompactSummary(input: { summary: string; trigger: "auto" | "manual" | null }): void;
}

export interface AgentLaunchContext {
  /** Spec 42 §3 compaction hooks; runtime-only. */
  compactionHooks?: AgentCompactionHooks;
  /** Launch-only instructions contributed by plugins. */
  appendSystemPrompt?: string[];
  /** Launch-only plugin MCP servers and their owners; never persisted. */
  mcpServers?: Record<string, McpServerConfig>;
  mcpServerOwners?: Record<string, string>;
  agentId?: string;
  env?: Record<string, string>;
  /**
   * JAgentDesk browser tools are part of this launch. Providers turn off their own browser
   * tooling (Codex's Browser/Chrome plugin skills, Claude in Chrome) and refuse shell commands
   * that open a URL in the system browser, so pages open in the app (spec 04 §27b.3).
   */
  inAppBrowser?: boolean;
  /**
   * Provider-owned connector families JAgentDesk tools replace in this launch, for example
   * `atlassian` while JAgentDesk has a Jira connection (spec 29.4). Providers hide those
   * connectors from the agent where their CLI can; launch-only, never persisted.
   */
  hideProviderConnectors?: string[];
  /**
   * Runtime-only internal JAgentDesk tools. This must never be persisted into
   * AgentSessionConfig; providers may adapt it to their native tool surface.
   */
  jagentdeskTools?: JAgentDeskToolCatalog;
}

export interface AgentCreateSessionOptions {
  /**
   * Whether the provider should leave a durable native session behind.
   * Defaults to true. Providers that cannot honor false should no-op.
   */
  persistSession?: boolean;
  /**
   * Model ids added by provider configuration (`models` / `additionalModels`).
   * Providers that validate against runtime-advertised models must accept these.
   */
  configuredModelIds?: readonly string[];
}

/** What a resumed session is for: driving the agent, or reading what it already did. */
export type AgentResumePurpose = "interactive" | "history";

/** Runtime-only intent for a persisted-session resume. Never persist this option. */
export interface AgentResumeSessionOptions {
  /** Defaults to interactive. History loading may be read-only for archived native sessions. */
  purpose?: AgentResumePurpose;
  /** See AgentCreateSessionOptions.configuredModelIds. */
  configuredModelIds?: readonly string[];
}

/**
 * Returned by respondToPermission when the permission resolution requires
 * a follow-up turn (e.g. Codex plan approval → implementation).
 */
export interface AgentPermissionResult {
  followUpPrompt?: AgentPromptInput;
}

export interface AgentSteerOptions extends AgentRunOptions {
  /** Deny permissions that block this steer. An accepted steer must honor this contract. */
  clearPendingPermissions?: boolean;
}

/**
 * Options for {@link AgentSession.steerActiveTurn}. `expectedTurnId` guards the
 * injection: the provider only steers if the currently-active turn still equals
 * the turn the caller observed, otherwise it returns `unavailable`. See ADR-0013.
 */
export interface SteerActiveTurnOptions extends AgentSteerOptions {
  expectedTurnId: string;
}

/**
 * Result of a steer attempt.
 * - `accepted`: the message was injected into the active turn.
 * - `unavailable`: the turn could not be steered (provider unsupported, turn
 *   already ended, or `expectedTurnId` no longer matches). The caller then
 *   safely falls back to interrupt-and-replace.
 */
// providerMessageId names the steered message in the provider's own history, when the provider
// mints one. Rewinding to the message needs it.
export type SteerResult =
  | { status: "accepted"; providerMessageId?: string }
  | { status: "unavailable" };

export interface AgentUsageSession {
  launch?: import("@jagentdesk/plugin/server/provider").ProviderLaunch;
  provider: string;
  model?: string;
  env: Record<string, string>;
  sessionKey: string;
}

export type JAgentDeskToolsHealth =
  | { status: "ok" }
  | { status: "missing"; reason: string }
  | { status: "unknown" };

export interface AgentSession {
  /** Persist the session's current handle immediately after an interactive resume. */
  readonly persistenceUpdatedOnResume?: boolean;

  usageSession?(): AgentUsageSession | null;

  readonly provider: AgentProvider;

  readonly id: string | null;

  readonly capabilities: AgentCapabilityFlags;

  /** Composer controls over top-level option keys. Values come from the agent's effective options. */
  readonly controls?: AgentOptionControl[];

  /**
   * How the session ended up different from the options it was opened with, as a patch (`null`
   * removes a key). Set by the time `createSession`/`resumeSession` resolves; the daemon stores it
   * before the agent is published.
   */
  readonly openOptionsPatch?: Record<string, unknown>;

  /** New provider-owned rows to commit on registration. streamHistory must also
   * replay them at their original timestamps; restored sessions omit old rows. */
  readonly initialTimeline?: ImportedTimelineEntry[];

  run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult>;

  /** Turn IDs remain unique through resume and daemon restarts. */
  startTurn(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<{ turnId: string }>;

  subscribe(callback: (event: AgentStreamEvent) => void): () => void;

  streamHistory(): AsyncGenerator<AgentStreamEvent>;

  /**
   * A cheap token that changes whenever the provider's stored history for this session changes
   * (a file's size and mtime, a session's update time). Null when it cannot be read. Providers
   * without one always replay their history when an agent is reopened.
   */
  readHistoryVersion?(): Promise<string | null>;

  /**
   * The host already holds this session's projected timeline and will not call streamHistory for
   * it. History the session reads later, to index turns or rewind targets, must not be retained.
   */
  discardHistoryReplay?(): void;

  getRuntimeInfo(): Promise<AgentRuntimeInfo>;

  getAvailableModes(): Promise<AgentMode[]>;

  getCurrentMode(): Promise<string | null>;

  setMode(modeId: string): Promise<void | AgentProviderNotice>;

  getPendingPermissions(): AgentPermissionRequest[];

  respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void>;

  /** Null until a new provider process could resume this session; see docs/providers.md. */
  describePersistence(): AgentPersistenceHandle | null;

  interrupt(): Promise<void>;

  /** Stop one currently owned background item and wait for provider confirmation. */
  stopBackgroundWork?(id: string): Promise<void>;

  /** True only when releasing this runtime loses no background work or pending replies.
   * An optional additional veto: missing methods use daemon baseline eligibility;
   * implemented checks that reject or return false keep the runtime resident. */
  canStopRuntime?(): Promise<boolean>;

  /** Release live runtime resources without archiving or deleting the durable native session. */
  close(): Promise<void>;

  listCommands?(): Promise<AgentSlashCommand[]>;

  /**
   * Spec 04 §27b.0: whether the JAgentDesk tools reached this runtime, asked before each
   * foreground turn. Cheap: reads the provider's own MCP or bridge status and may repair the
   * connection in place. Providers that cannot tell return `unknown`.
   */
  checkJAgentDeskTools?(options: { signal: AbortSignal }): Promise<JAgentDeskToolsHealth>;

  /** A returned model is the effective selection committed by this mutation.
   * Returning void means the requested selection was accepted. No status read is required. */
  setModel?(modelId: string | null): Promise<void | { model: string | null }>;

  setThinkingOption?(thinkingOptionId: string | null): Promise<void | AgentProviderNotice>;

  /**
   * Apply an options patch. `options` holds only the keys the patch touches, resolved against
   * the `config.json` defaults; `null` means nothing is set for the key, so return it to the
   * session's own default if that can be done. Leave every other setting alone. Throw to reject a
   * value, or a key the running session cannot apply (one the provider reads only when it
   * opens): the daemon stores the patch only when this resolves, so a stored option always
   * describes what runs, and the call is all-or-nothing.
   * Emit nothing from here. Return the options the session ended up with when they differ from
   * the request (a patch, `null` removes a key), for example a value it kept because it could not
   * be reverted; the daemon stores it together with the patch. When a throw leaves the session's
   * state moved anyway, report the moved values once as `options_changed` after the call has
   * ended, so the stored options still match what runs.
   */
  applyOptions?(options: ProviderOptions): Promise<Record<string, unknown> | void>;

  revertConversation?(input: { messageId: string }): Promise<void>;

  /**
   * Fast fork (spec 41 §6): copies the provider conversation into a new provider session that ends
   * before the turn `beforeUserMessageId` opened (the whole conversation when null) and returns
   * its handle. This session is unchanged; nothing is replayed into a prompt.
   */
  forkConversation?(input: { beforeUserMessageId: string | null }): Promise<AgentPersistenceHandle>;

  revertFiles?(input: { messageId: string }): Promise<void>;

  revertBoth?(input: { messageId: string }): Promise<void>;

  /**
   * Out-of-band prompt handler. When non-null, the manager runs the returned
   * handler instead of allocating a turn. The handler emits stream events
   * directly via the provided `emit` callback, which routes through the
   * manager's persistence + broadcast pipeline. The active foreground turn
   * (if any) is left untouched, so this is how mid-turn side-effect commands
   * (e.g. /goal pause) reach the provider without canceling the running turn.
   */
  tryHandleOutOfBand?(prompt: AgentPromptInput): {
    run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void>;
  } | null;

  /**
   * Inject a user message into the currently-active turn without cancelling it
   * ("steering"). Only defined by providers that support mid-turn injection.
   * Must re-check that `options.expectedTurnId` still owns the active turn both
   * before and after building the message, returning `{ status: "unavailable" }`
   * if not (the manager then falls back to interrupt). See ADR-0013.
   */
  steerActiveTurn?(prompt: AgentPromptInput, options: SteerActiveTurnOptions): Promise<SteerResult>;
}

export type FetchCatalogOptions = { providerOptions?: ProviderOptions } & (
  | {
      scope: "global";
      force: boolean;
      timeoutMs?: number;
    }
  | {
      scope: "workspace";
      cwd: string;
      force: boolean;
      timeoutMs?: number;
    }
);

export interface ProviderRefreshContext {
  readonly signal: AbortSignal;
  /** Track an upstream operation so timeout errors identify the work still pending. */
  runActivity<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

export interface ProviderCatalog {
  models: AgentModelDefinition[];
  modes: AgentMode[];
  defaultModeId?: string | null;
  /** Part of discovery failed, so the catalogue omits models the provider could not confirm. */
  incomplete?: boolean;
}

export interface ResolveAgentDefaultModeInput {
  config: AgentSessionConfig;
  env?: Record<string, string>;
  signal?: AbortSignal;
}

export interface AgentDraftControls {
  controls: AgentOptionControl[];
  options: ProviderOptions;
}

export interface AgentClientInstallationContext {
  /** Aborted when JAgentDesk stops waiting for the result. */
  signal: AbortSignal;
}

export interface AgentClientInstallation {
  installUrl?: string;
  updateUrl?: string;
  inspect?(context: AgentClientInstallationContext): Promise<ProviderInspection>;
  /** See `ProviderInstallation.checkForUpdates` in the plugin contract. */
  checkForUpdates?(context: AgentClientUpdateCheckContext): Promise<ProviderUpdateCheck>;
  /** Runs the provider's updater. See `ProviderInstallation.update` in the plugin contract. */
  update?(context: AgentClientUpdateContext): Promise<ProviderUpdateResult>;
}

export interface AgentClientUpdateCheckContext extends AgentClientInstallationContext {
  /** The version `inspect` reported, as written. Absent when it reported none or there is no `inspect`. */
  installedVersion?: string;
}

export interface AgentClientUpdateContext extends AgentClientInstallationContext {
  report(event: ProviderUpdateReport): void;
}

/** What the daemon gives a provider's diagnostic report. */
export interface AgentClientDiagnosticContext {
  /**
   * The installation as the provider's Installation row shows it, under the same deadline and
   * cache. Undefined when the provider does not report its installation.
   */
  inspectInstallation(): Promise<ProviderInstallationInspection | undefined>;
}

export interface AgentClient {
  resolveUsageLaunch?(): Promise<
    import("@jagentdesk/plugin/server/provider").ProviderLaunch | undefined
  >;

  readonly provider: AgentProvider;

  readonly capabilities: AgentCapabilityFlags;

  createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession>;

  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    options?: AgentResumeSessionOptions,
  ): Promise<AgentSession>;

  /**
   * Discover models and modes together. Implementations may use one upstream
   * process, separate upstream calls, static modes, or private helpers; callers
   * outside the provider do not get separate runtime model/mode probes.
   * The registry is responsible for merging configured model overrides.
   */
  fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog>;

  /** Apply provider-owned defaults to a model supplied through provider configuration. */
  resolveConfiguredModel?(model: AgentModelDefinition): AgentModelDefinition;

  resolveDefaultModeId?(input: ResolveAgentDefaultModeInput): Promise<string | undefined>;

  resolveCreateConfig?(input: ResolveAgentCreateConfigInput): ResolveAgentCreateConfigResult;

  isCreateConfigUnattended?(input: AgentCreateConfigUnattendedInput): boolean;

  listCommands?(config: AgentSessionConfig): Promise<AgentSlashCommand[]>;

  /**
   * The controls of a draft, with the options a session opened from `config` would run with:
   * `config.providerOptions` (defaults already merged in) plus what the provider resolves
   * natively for the ones nobody set.
   */
  listControls?(config: AgentSessionConfig): Promise<AgentDraftControls>;

  /** Effective options: provider defaults from `config.json` deep-merged with the agent's own. */
  effectiveOptions?(own: ProviderOptions | undefined): ProviderOptions;

  listImportableSessions?(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]>;

  importSession?(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession>;

  /**
   * Check if this provider is available (CLI binary is installed).
   * Returns true if available, false otherwise.
   */
  isAvailable(signal?: AbortSignal): Promise<boolean>;

  getDiagnostic?(context?: AgentClientDiagnosticContext): Promise<{ diagnostic: string }>;

  /**
   * Installation links and the installed version. The same contract as plugin providers'
   * `ProviderRegistration.installation`; built-ins resolve their own launch inside `inspect`.
   * Never consulted by availability, discovery, or session creation.
   */
  readonly installation?: AgentClientInstallation;

  /**
   * Archive a durable native session (best-effort). Runtime release belongs to AgentSession.close().
   * Called when JAgentDesk archives an agent so the provider's own UI reflects the same state.
   */
  archiveNativeSession?(handle: AgentPersistenceHandle): Promise<void>;

  /**
   * Unarchive a durable native session in the provider.
   * Called before JAgentDesk clears its archived flag so provider resume can succeed.
   */
  unarchiveNativeSession?(handle: AgentPersistenceHandle): Promise<void>;

  /**
   * Release any provider-owned resources held by this client (background
   * processes, sockets, cached subprocesses, etc.). Called when the daemon
   * shuts down. Must be idempotent.
   */
  shutdown?(): Promise<void>;
}
