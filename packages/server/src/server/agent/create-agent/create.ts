import { type Logger } from "pino";
import { type TerminalManager } from "../../../terminal/terminal-manager.js";
import { type CreateJAgentDeskWorktreeInput } from "../../jagentdesk-worktree-service.js";
import { expandUserPath, resolvePathFromBase } from "../../path-utils.js";
import { toWorktreeRequestError } from "../../worktree-errors.js";
import {
  type AgentWorktreeSetupContinuation,
  type CreateJAgentDeskWorktreeSetupContinuationInput,
  type CreateJAgentDeskWorktreeWorkflowFn,
  type CreateJAgentDeskWorktreeWorkflowResult,
} from "../../worktree-session.js";
import {
  type AgentAttachment,
  type FirstAgentContext,
  type GitSetupOptions,
} from "../../messages.js";
import { type AgentManager, type CreateAgentOptions, type ManagedAgent } from "../agent-manager.js";
import {
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentSessionConfig,
} from "../agent-sdk-types.js";
import { type AgentStorage } from "../agent-storage.js";
import { type AgentOwner } from "../agent-owner.js";
import { type ProviderSnapshotManager } from "../provider-snapshot-manager.js";
import { type AgentPromptSource } from "../agent-messages/index.js";
import { setupFinishNotification, startCreatedAgentInitialPrompt } from "../agent-prompt.js";
import { resolveCreateAgentTitles } from "../create-agent-title.js";
import { buildAgentPrompt } from "../prompt-attachments.js";
import { normalizeClientMessageId, resolveClientMessageId } from "../../client-message-id.js";
import { resolveRequiredProviderModel, type ResolvedProviderModel } from "../mcp-shared.js";
import {
  appendTimelineItemIfAgentKnown,
  emitLiveTimelineItemIfAgentKnown,
} from "../timeline-append.js";
import {
  inheritAgentBackground,
  inheritWorkspaceBackground,
  resolveCreateAgentIntent,
} from "./intent.js";
import { type ProviderOptions } from "@jagentdesk/protocol/agent-types";
import { foldFeatureValues, type LegacyFeatureValues } from "../option-controls.js";

interface McpWorkspaceIntent {
  background?: boolean;
  callerWorkspaceId?: string;
}

export interface CreateAgentSessionWorktreeResult {
  sessionConfig: AgentSessionConfig;
  setupContinuation?: AgentWorktreeSetupContinuation;
  // Set when this build created a fresh worktree workspace. The agent must be
  // stamped with it so workspaceId-scoped archive can find the agent later.
  createdWorkspaceId?: string;
}

export interface CreateAgentCommandDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  jagentdeskHome?: string;
  worktreesRoot?: string;
  terminalManager?: TerminalManager | null;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "resolveCreateConfig">;
  createJAgentDeskWorktree?: CreateJAgentDeskWorktreeWorkflowFn;
  // Mints a fresh directory workspace for a cwd and returns its id.
  ensureWorkspaceForCreate?: EnsureWorkspaceForCreate;
}

export type EnsureWorkspaceForCreate = (
  cwd: string,
  firstAgentContext?: FirstAgentContext,
  context?: { background?: boolean; callerWorkspaceId?: string },
) => Promise<string>;

export interface CreateAgentFromSessionInput {
  kind: "session";

  onAgentReady?: (agent: ManagedAgent) => Promise<void>;

  /** Wire configs from older clients can still carry `featureValues`; they are folded on entry. */
  config: AgentSessionConfig & LegacyFeatureValues;

  workspaceId: string;

  worktreeName?: string;

  background: boolean;

  initialPrompt?: string;

  clientMessageId?: string;

  outputSchema?: Record<string, unknown>;

  images?: Array<{ data: string; mimeType: string }>;

  attachments?: AgentAttachment[];

  git?: GitSetupOptions;

  labels: Record<string, string>;

  metadata?: CreateAgentOptions["metadata"];

  env?: Record<string, string>;

  provisionalTitle: string | null;

  firstAgentContext: FirstAgentContext;

  buildSessionConfig: (
    config: AgentSessionConfig,
    gitOptions?: GitSetupOptions,
    legacyWorktreeName?: string,
    firstAgentContext?: FirstAgentContext,
  ) => Promise<CreateAgentSessionWorktreeResult>;
}

export interface CreateAgentFromMcpInput {
  agentBackground?: boolean;

  kind: "mcp";

  provider: string;

  title: string;

  initialPrompt?: string;

  config?: Partial<AgentSessionConfig>;

  cwd?: string;

  workspaceId?: string;

  thinking?: string;

  providerOptions?: ProviderOptions;

  labels?: Record<string, string>;

  mode?: string;

  unattended?: boolean;

  promptFailure?: CreateAgentPromptFailureMode;

  background: boolean;

  notifyOnFinish: boolean;

  internal?: boolean;

  detached?: boolean;

  owner?: AgentOwner;

  env?: Record<string, string>;

  onCreated?: (created: {
    agentId: string;
    createdWorktree: CreateJAgentDeskWorktreeWorkflowResult | null;
  }) => void;

  onWorktreeCreated?: (createdWorktree: CreateJAgentDeskWorktreeWorkflowResult) => void;

  callerAgentId?: string;

  callerContext?: {
    lockedCwd?: string;
    allowCustomCwd?: boolean;
    childAgentDefaultLabels?: Record<string, string>;
  } | null;

  worktree?: {
    worktreeName?: string;
    branchName?: string;
    baseBranch?: string;
    refName?: string;
    action?: "branch-off" | "checkout";
    githubPrNumber?: number;
  };
}

export type CreateAgentCommandInput = CreateAgentFromSessionInput | CreateAgentFromMcpInput;

export type CreateAgentPromptFailureMode = "throw" | "log" | "return-error";

export interface CreateAgentCommandResult {
  snapshot: ManagedAgent;
  liveSnapshot: ManagedAgent;
  background: boolean;
  initialPromptStarted: boolean;
  initialPromptError: unknown | null;
  createdWorktree?: CreateJAgentDeskWorktreeWorkflowResult;
}

export type BoundCreateAgentCommand = (
  input: CreateAgentCommandInput,
) => Promise<CreateAgentCommandResult>;

function requireResolvedWorkspaceId(workspaceId: string | undefined): string {
  if (!workspaceId) {
    throw new Error("createAgentCommand requires a resolved workspaceId");
  }
  return workspaceId;
}

export function formatProviderModel(provider: string, model: string | null | undefined): string {
  if (!model || provider.includes("/")) {
    return provider;
  }
  return `${provider}/${model}`;
}

function resolveProviderModel(providerValue: string): ResolvedProviderModel {
  const providerInput = providerValue.trim();
  if (providerInput.includes("/")) {
    return resolveRequiredProviderModel(providerInput);
  }
  if (!providerInput) {
    throw new Error("provider is required");
  }
  return { provider: providerInput, model: undefined };
}

interface ResolvedCreateAgent {
  config: AgentSessionConfig;
  createOptions: CreateAgentOptions;
  prompt?: AgentPromptInput;
  /** Sender of the first prompt when another agent created this one (ADR-0029). */
  source?: AgentPromptSource;
  runOptions?: AgentRunOptions;
  setupContinuation?: AgentWorktreeSetupContinuation;
  background: boolean;
  promptFailure: CreateAgentPromptFailureMode;
  promptLogger?: Logger;
  createdWorktree?: CreateJAgentDeskWorktreeWorkflowResult;
}

export async function createAgentCommand(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentCommandInput,
): Promise<CreateAgentCommandResult> {
  const resolved =
    input.kind === "session"
      ? await resolveSessionCreateAgent(dependencies, input)
      : await resolveMcpCreateAgent(dependencies, input);

  const snapshot = await dependencies.agentManager.createAgent(
    resolved.config,
    undefined,
    resolved.createOptions,
  );

  resolved.setupContinuation?.startAfterAgentCreate({
    agentId: snapshot.id,
  });

  if (input.kind === "session") await input.onAgentReady?.(snapshot);

  let liveSnapshot = snapshot;
  let initialPromptStarted = false;
  let initialPromptError: unknown | null = null;
  if (input.kind === "mcp") {
    input.onCreated?.({ agentId: snapshot.id, createdWorktree: resolved.createdWorktree ?? null });
  }
  // Register before the first prompt (ADR-0029 decision 4): a child that finishes
  // at once is still reported, and the durable record exists before any turn.
  const stopFinishNotification =
    input.kind === "mcp" &&
    input.notifyOnFinish &&
    input.callerAgentId &&
    resolved.prompt !== undefined
      ? setupFinishNotification({
          agentManager: dependencies.agentManager,
          agentStorage: dependencies.agentStorage,
          childAgentId: snapshot.id,
          callerAgentId: input.callerAgentId,
          // Detached agents have no parent label, but still notify their creator.
          requireParentOwnership: !(input.detached ?? false),
          waitForTurnStart: true,
          logger: dependencies.logger,
        })
      : null;

  await stopFinishNotification?.ready;
  if (resolved.prompt !== undefined) {
    const sendResult = await sendInitialPrompt(dependencies, resolved, snapshot);
    initialPromptStarted = sendResult.started;
    liveSnapshot = sendResult.liveSnapshot;
    initialPromptError = sendResult.error ?? null;
  }
  if (!initialPromptStarted) stopFinishNotification?.();

  return {
    snapshot,
    liveSnapshot,
    background: resolved.background,
    initialPromptStarted,
    initialPromptError,
    ...(resolved.createdWorktree ? { createdWorktree: resolved.createdWorktree } : {}),
  };
}

async function resolveSessionCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromSessionInput,
): Promise<ResolvedCreateAgent> {
  const trimmedPrompt = input.initialPrompt?.trim();
  const {
    sessionConfig: builtSessionConfig,
    setupContinuation,
    createdWorkspaceId,
  } = await input.buildSessionConfig(
    foldFeatureValues(input.config),
    input.git,
    input.worktreeName,
    input.firstAgentContext,
  );
  // Validate the requested mode against the provider's modes for the resolved
  // cwd. The app remembers mode preferences globally, so a saved mode can be
  // stale for a workspace whose provider config no longer defines it — reject
  // it here instead of letting the provider fail mid-turn.
  //
  // This runs after buildSessionConfig, which may already have created a
  // worktree and/or workspace record — cwd (required to resolve modes) is
  // only known once that step completes. If validation throws, any
  // worktree/workspace buildSessionConfig created is the caller's
  // responsibility to clean up (session.ts's handleCreateAgentRequest does
  // this for the worktree path via cleanupCreatedWorktreeAfterFailedAgentCreate;
  // this is a pre-existing gap for directory-only workspace creates, not
  // introduced by this validation).
  const resolvedCreateConfig = await dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: builtSessionConfig.cwd,
    provider: builtSessionConfig.provider,
    requestedMode: builtSessionConfig.modeId,
    providerOptions: builtSessionConfig.providerOptions,
    parent: null,
    unattended: false,
  });
  const sessionConfig: AgentSessionConfig = {
    ...builtSessionConfig,
    modeId: resolvedCreateConfig.modeId,
    providerOptions: resolvedCreateConfig.providerOptions,
  };
  const prompt = buildAgentPrompt(trimmedPrompt ?? "", input.images, input.attachments);
  const hasPromptContent = Array.isArray(prompt) ? prompt.length > 0 : prompt.length > 0;
  const clientMessageId = normalizeClientMessageId(input.clientMessageId);
  const runOptions: AgentRunOptions | undefined =
    input.outputSchema || clientMessageId
      ? {
          ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          ...(clientMessageId ? { clientMessageId } : {}),
        }
      : undefined;
  const workspaceId = setupContinuation ? createdWorkspaceId : input.workspaceId;

  return {
    config: sessionConfig,
    createOptions: {
      labels: input.labels,
      metadata: input.metadata,
      initialPrompt: trimmedPrompt,
      env: input.env,
      initialTitle: input.provisionalTitle,
      // A legacy git/worktreeName worktree creates a fresh workspace, so the
      // agent belongs to that workspace, not the source one. createdWorkspaceId
      // is the freshly created worktree's workspace.
      workspaceId: requireResolvedWorkspaceId(workspaceId),
      background: input.background,
    },
    prompt: hasPromptContent ? prompt : undefined,
    runOptions,
    setupContinuation,
    background: true,
    // Registration commits creation. First-turn failures belong to the created agent.
    promptFailure: "return-error",
    promptLogger: dependencies.logger.child({
      clientMessageId: resolveClientMessageId(input.clientMessageId),
    }),
  };
}

async function resolveMcpCreateAgent(
  dependencies: CreateAgentCommandDependencies,
  input: CreateAgentFromMcpInput,
): Promise<ResolvedCreateAgent> {
  const resolvedProviderModel = resolveProviderModel(input.provider);
  const provider = resolvedProviderModel.provider;
  const parentAgent = input.callerAgentId
    ? requireParentAgent(dependencies.agentManager, input.callerAgentId)
    : null;
  const cwd = resolveMcpInitialCwd(input, parentAgent);
  const workspaceIntent = {
    background: inheritWorkspaceBackground(input.agentBackground, parentAgent),
    callerWorkspaceId: parentAgent?.workspaceId,
  };
  const { resolvedCwd, setupContinuation, createdWorkspaceId, createdWorktree } =
    await resolveMcpCwd({
      dependencies,
      cwd,
      worktree: input.worktree,
      initialPrompt: input.initialPrompt ?? "",
      workspaceIntent,
    });
  if (createdWorktree) input.onWorktreeCreated?.(createdWorktree);

  const intent = await resolveCreateAgentIntent({
    explicitWorkspaceId: setupContinuation ? createdWorkspaceId : input.workspaceId,
    caller: parentAgent
      ? { id: parentAgent.id, cwd: parentAgent.cwd, workspaceId: parentAgent.workspaceId }
      : null,
    labels: input.labels,
    childAgentDefaultLabels: input.callerContext?.childAgentDefaultLabels,
    legacyDetached: input.detached ?? false,
    resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: resolvedCwd }),
    createWorkspace: async () => ({
      workspaceId: requireResolvedWorkspaceId(
        await ensureWorkspaceForMcpCreate(
          dependencies,
          resolvedCwd,
          input.initialPrompt ?? "",
          workspaceIntent,
        ),
      ),
      cwd: resolvedCwd,
    }),
  });
  const resolvedCreateConfig = await resolveMcpProviderCreateConfig({
    dependencies,
    input,
    provider,
    resolvedCwd,
    parentAgent,
  });

  const trimmedPrompt = input.initialPrompt?.trim() ?? "";
  return {
    config: buildMcpSessionConfig({
      input,
      resolvedProviderModel,
      provider,
      resolvedCwd: intent.cwd,
      trimmedPrompt,
      resolvedMode: resolvedCreateConfig.modeId,
      resolvedProviderOptions: resolvedCreateConfig.providerOptions,
    }),
    createOptions: {
      ...(Object.keys(intent.labels).length > 0 ? { labels: intent.labels } : {}),
      workspaceId: intent.workspaceId,
      owner: input.owner,
      background: inheritAgentBackground(input.agentBackground, parentAgent),
      env: input.env,
    },
    prompt: trimmedPrompt ? trimmedPrompt : undefined,
    source: input.callerAgentId
      ? { kind: "agent-message", agentId: input.callerAgentId }
      : undefined,
    setupContinuation,
    createdWorktree,
    background: input.background,
    promptFailure: input.promptFailure ?? "log",
  };
}

function resolveMcpInitialCwd(
  input: CreateAgentFromMcpInput,
  parentAgent: ManagedAgent | null,
): string {
  if (!parentAgent) {
    return expandUserPath(input.cwd ?? process.cwd());
  }
  return resolveChildAgentCwd({
    parentCwd: parentAgent.cwd,
    requestedCwd: input.cwd,
    lockedCwd: input.callerContext?.lockedCwd,
    allowCustomCwd: input.callerContext?.allowCustomCwd ?? true,
  });
}

async function resolveMcpProviderCreateConfig(params: {
  dependencies: CreateAgentCommandDependencies;
  input: CreateAgentFromMcpInput;
  provider: string;
  resolvedCwd: string;
  parentAgent: ManagedAgent | null;
}): Promise<{ modeId?: string; providerOptions?: ProviderOptions }> {
  const passthroughConfig = params.input.config;
  return params.dependencies.providerSnapshotManager.resolveCreateConfig({
    cwd: params.resolvedCwd,
    provider: params.provider,
    requestedMode: params.input.mode ?? passthroughConfig?.modeId,
    providerOptions: mergeMcpProviderOptions(params.input),
    parent: params.parentAgent,
    unattended: params.input.unattended ?? false,
  });
}

function mergeMcpProviderOptions(input: CreateAgentFromMcpInput): ProviderOptions | undefined {
  if (!input.providerOptions) return input.config?.providerOptions;
  return { ...input.config?.providerOptions, ...input.providerOptions };
}

function buildMcpSessionConfig(params: {
  input: CreateAgentFromMcpInput;
  resolvedProviderModel: ResolvedProviderModel;
  provider: string;
  resolvedCwd: string;
  trimmedPrompt: string;
  resolvedMode?: string;
  resolvedProviderOptions?: ProviderOptions;
}): AgentSessionConfig {
  const passthroughConfig = params.input.config;
  const { provisionalTitle } = resolveCreateAgentTitles({
    configTitle: passthroughConfig?.title ?? params.input.title,
    initialPrompt: params.trimmedPrompt,
  });
  const providerOptions = params.resolvedProviderOptions ?? mergeMcpProviderOptions(params.input);
  const config: AgentSessionConfig = {
    ...passthroughConfig,
    provider: params.provider,
    cwd: params.resolvedCwd,
    modeId: params.resolvedMode ?? passthroughConfig?.modeId,
    model: params.resolvedProviderModel.model ?? passthroughConfig?.model,
    thinkingOptionId: params.input.thinking ?? passthroughConfig?.thinkingOptionId,
    internal: params.input.internal ?? passthroughConfig?.internal,
  };
  if (provisionalTitle) {
    config.title = provisionalTitle;
  }
  if (providerOptions) {
    config.providerOptions = providerOptions;
  }
  return config;
}

async function ensureWorkspaceForMcpCreate(
  dependencies: CreateAgentCommandDependencies,
  cwd: string,
  initialPrompt: string,
  workspaceIntent: McpWorkspaceIntent,
): Promise<string | undefined> {
  if (!dependencies.ensureWorkspaceForCreate) {
    return undefined;
  }
  return dependencies.ensureWorkspaceForCreate(cwd, { prompt: initialPrompt }, workspaceIntent);
}

async function sendInitialPrompt(
  dependencies: CreateAgentCommandDependencies,
  resolved: ResolvedCreateAgent,
  snapshot: ManagedAgent,
): Promise<{ started: boolean; liveSnapshot: ManagedAgent; error?: unknown }> {
  try {
    const prompt = resolved.prompt;
    if (prompt === undefined) {
      return { started: false, liveSnapshot: snapshot };
    }
    const liveSnapshot = await startCreatedAgentInitialPrompt({
      agentManager: dependencies.agentManager,
      agentStorage: dependencies.agentStorage,
      source: resolved.source,
      agentId: snapshot.id,
      snapshot,
      prompt,
      runOptions: resolved.runOptions,
      logger: resolved.promptLogger ?? dependencies.logger,
    });
    return { started: true, liveSnapshot };
  } catch (error) {
    if (resolved.promptFailure === "throw") {
      throw error;
    }
    if (resolved.promptFailure === "return-error") {
      return {
        started: false,
        liveSnapshot: dependencies.agentManager.getAgent(snapshot.id) ?? snapshot,
        error,
      };
    }
    dependencies.logger.error({ err: error, agentId: snapshot.id }, "Failed to run initial prompt");
    return { started: false, liveSnapshot: snapshot };
  }
}

function requireParentAgent(agentManager: AgentManager, parentAgentId: string): ManagedAgent {
  const parentAgent = agentManager.getAgent(parentAgentId);
  if (!parentAgent) {
    throw new Error(`Parent agent ${parentAgentId} not found`);
  }
  return parentAgent;
}

function resolveChildAgentCwd(params: {
  parentCwd: string;
  requestedCwd?: string;
  lockedCwd?: string;
  allowCustomCwd: boolean;
}): string {
  const lockedCwd = params.lockedCwd?.trim();
  if (lockedCwd) {
    return expandUserPath(lockedCwd);
  }

  const requestedCwd = params.requestedCwd?.trim();
  if (!requestedCwd || !params.allowCustomCwd) {
    return params.parentCwd;
  }

  return resolvePathFromBase(params.parentCwd, requestedCwd);
}

async function resolveMcpCwd(params: {
  dependencies: CreateAgentCommandDependencies;
  cwd: string;
  initialPrompt: string;
  workspaceIntent: McpWorkspaceIntent;
  worktree: CreateAgentFromMcpInput["worktree"];
}): Promise<{
  resolvedCwd: string;
  setupContinuation?: AgentWorktreeSetupContinuation;
  createdWorkspaceId?: string;
  createdWorktree?: CreateJAgentDeskWorktreeWorkflowResult;
}> {
  const { dependencies, worktree } = params;
  if (!worktree) {
    return { resolvedCwd: params.cwd };
  }
  const shouldCreateWorktree = Boolean(
    worktree.worktreeName || worktree.refName || worktree.action || worktree.githubPrNumber,
  );
  if (!shouldCreateWorktree) {
    return { resolvedCwd: params.cwd };
  }
  if (
    worktree.worktreeName &&
    !worktree.baseBranch &&
    !worktree.refName &&
    !worktree.action &&
    worktree.githubPrNumber === undefined
  ) {
    throw new Error("baseBranch is required when creating a worktree");
  }
  const baseBranch = worktree.baseBranch;
  const createdWorktree = await createMcpWorktree({
    input: {
      cwd: params.cwd,
      ...params.workspaceIntent,
      worktreeSlug: worktree.worktreeName,
      branchName: worktree.branchName,
      refName: worktree.refName,
      action: worktree.action,
      githubPrNumber: worktree.githubPrNumber,
      firstAgentContext: { prompt: params.initialPrompt },
      runSetup: false,
      jagentdeskHome: dependencies.jagentdeskHome,
      worktreesRoot: dependencies.worktreesRoot,
    },
    createJAgentDeskWorktree: dependencies.createJAgentDeskWorktree,
    resolveDefaultBranch: baseBranch ? async () => baseBranch : undefined,
    setupContinuation: {
      kind: "agent",
      terminalManager: dependencies.terminalManager ?? null,
      appendTimelineItem: ({ agentId, item }) =>
        appendTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      emitLiveTimelineItem: ({ agentId, item }) =>
        emitLiveTimelineItemIfAgentKnown({
          agentManager: dependencies.agentManager,
          agentId,
          item,
        }),
      logger: dependencies.logger,
    },
  });
  return {
    resolvedCwd: createdWorktree.workspace.cwd,
    setupContinuation: createdWorktree.setupContinuation,
    createdWorkspaceId: createdWorktree.workspace.workspaceId,
    createdWorktree,
  };
}

interface CreateMcpWorktreeOptions {
  input: CreateJAgentDeskWorktreeInput;
  createJAgentDeskWorktree: CreateJAgentDeskWorktreeWorkflowFn | undefined;
  resolveDefaultBranch?: (repoRoot: string) => Promise<string>;
  setupContinuation?: CreateJAgentDeskWorktreeSetupContinuationInput;
}

async function createMcpWorktree(
  options: CreateMcpWorktreeOptions,
): Promise<CreateJAgentDeskWorktreeWorkflowResult> {
  try {
    if (!options.createJAgentDeskWorktree) {
      throw new Error("JAgentDesk worktree service is not configured");
    }
    return await options.createJAgentDeskWorktree(options.input, {
      ...(options.resolveDefaultBranch
        ? { resolveDefaultBranch: options.resolveDefaultBranch }
        : {}),
      ...(options.setupContinuation ? { setupContinuation: options.setupContinuation } : {}),
    });
  } catch (error) {
    throw toWorktreeRequestError(error);
  }
}
