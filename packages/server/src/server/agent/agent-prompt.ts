import type { Logger } from "pino";

import type { ActiveTurnBehavior } from "@jagentdesk/protocol/messages";

import type { AgentPromptInput, AgentRunOptions } from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { getParentAgentIdFromLabels } from "@jagentdesk/protocol/agent-labels";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "replaceAgentRun"
  | "streamAgent"
  | "steerActiveTurn"
  | "hasPendingPermissions"
  | "deferPromptUntilPermissionResolved"
>;

export interface StartAgentRunOptions {
  replaceRunning?: boolean;
  /**
   * How to treat the prompt when a turn is already in flight. "steer" injects it
   * into the running turn (falling back to interrupt when the provider/turn can't
   * be steered); "interrupt" (default) cancels and replaces. Only consulted when
   * `replaceRunning` is set and a run is in flight. See ADR-0013.
   */
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
}

function logStartRequest(
  logger: Logger,
  agentId: string,
  prompt: AgentPromptInput,
  snapshot: ManagedAgent | null,
  options?: StartAgentRunOptions,
): void {
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      turnId: snapshot?.activeForegroundTurnId ?? undefined,
      promptType: typeof prompt === "string" ? "string" : "structured",
      hasRunOptions: Boolean(options?.runOptions),
      replaceRunning: Boolean(options?.replaceRunning),
    },
    "agent.session.start_stream.request",
  );
}

/**
 * Attempt to steer the live turn (ADR-0013). Returns true only when the message
 * was injected into the running turn; false means the caller should fall back to
 * the normal interrupt-and-replace path.
 */
async function trySteerActiveTurn(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<boolean> {
  if (
    !options?.replaceRunning ||
    options.activeTurnBehavior !== "steer" ||
    !agentManager.hasInFlightRun(agentId)
  ) {
    return false;
  }
  const steerResult = await agentManager.steerActiveTurn(agentId, prompt, options.runOptions);
  if (steerResult.status !== "accepted") {
    return false;
  }
  logger.trace({ agentId }, "agent.session.start_stream.steered");
  return true;
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<{ outOfBand: boolean; steered?: boolean }> {
  const snapshot = agentManager.getAgent(agentId);
  const provider = snapshot?.provider;
  const providerSessionId = snapshot?.persistence?.sessionId ?? undefined;
  logStartRequest(logger, agentId, prompt, snapshot, options);
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions)) {
    return { outOfBand: true };
  }
  // Do not interrupt an agent that is paused waiting for a user permission
  // (e.g. an orchestration Lead that called ask_user_question): a replace would
  // auto-deny the pending question. Queue the prompt and deliver it once the
  // agent is idle again.
  if (
    options?.replaceRunning &&
    agentManager.hasInFlightRun(agentId) &&
    agentManager.hasPendingPermissions(agentId)
  ) {
    agentManager.deferPromptUntilPermissionResolved(agentId, prompt, options?.runOptions);
    return { outOfBand: false };
  }
  // Steer into the live turn instead of interrupting, when requested and the
  // provider/turn can accept it. On "unavailable" we fall through to the normal
  // interrupt-and-replace path below. (Pending-permission runs already deferred
  // above, so steering never races a paused permission.) See ADR-0013.
  if (await trySteerActiveTurn(agentManager, agentId, prompt, logger, options)) {
    return { outOfBand: false, steered: true };
  }
  const shouldReplace = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  const runOptions = options?.runOptions;
  const iterator = shouldReplace
    ? await agentManager.replaceAgentRun(agentId, prompt, runOptions)
    : agentManager.streamAgent(agentId, prompt, runOptions);
  logger.trace(
    { agentId, provider, providerSessionId, shouldReplace },
    "agent.session.start_stream.iterator_returned",
  );
  void drainAgentRunIterator(iterator, agentId, snapshot, logger);
  return { outOfBand: false };
}

/**
 * Drain a started agent-run iterator in the background. Events are broadcast via
 * AgentManager subscribers, so this only needs to pump the iterator to
 * completion and log the outcome.
 */
async function drainAgentRunIterator(
  iterator: AsyncGenerator<unknown>,
  agentId: string,
  snapshot: ManagedAgent | null,
  logger: Logger,
): Promise<void> {
  const traceBase = {
    agentId,
    provider: snapshot?.provider,
    providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
  };
  try {
    for await (const _ of iterator) {
      // Events are broadcast via AgentManager subscribers.
    }
    logger.trace(traceBase, "agent.session.iterator.drained");
  } catch (error) {
    logger.trace({ ...traceBase, err: error }, "agent.session.iterator.error");
    logger.error({ err: error, agentId }, "Agent stream failed");
  }
}

/**
 * Clear the archived flag from a stored agent record.
 * Shared across Session (app/WS), MCP, and CLI so every surface that acts on
 * an archived agent unarchives it the same way.
 */
export async function unarchiveAgentState(
  _agentStorage: AgentStorage,
  agentManager: AgentUnarchiveController,
  agentId: string,
  updates?: { workspaceId?: string; labels?: Record<string, string | null> },
): Promise<boolean> {
  const unarchived = await agentManager.unarchiveSnapshot(agentId, updates);
  if (!unarchived) return false;
  agentManager.notifyAgentState(agentId);
  return true;
}

/**
 * Wrap a body in <jagentdesk-system>…</jagentdesk-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by chat mentions, schedule fires, and notify-on-finish.
 */
export function formatSystemNotificationPrompt(reason: string): string {
  return `<jagentdesk-system>\n${reason}\n</jagentdesk-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<jagentdesk-system>\n[\s\S]*\n<\/jagentdesk-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text);
}

export interface SendPromptToAgentParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  runOptions?: AgentRunOptions;
  /** How to treat the prompt when a turn is already in flight (see ADR-0013). */
  activeTurnBehavior?: ActiveTurnBehavior;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

const AGENT_RUN_START_TIMEOUT_MS = 15_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
): Promise<void> {
  const startAbort = new AbortController();
  const startTimeout = setTimeout(() => startAbort.abort("timeout"), AGENT_RUN_START_TIMEOUT_MS);

  try {
    await agentManager.waitForAgentRunStart(agentId, { signal: startAbort.signal });
  } finally {
    clearTimeout(startTimeout);
  }
}

/**
 * Full send-prompt orchestration: (optional unarchive) → load → (optional
 * mode change) → start run.
 *
 * Every surface that sends a prompt to an agent (Session/WS, MCP, CLI-through-MCP,
 * chat mentions, notify-on-finish) MUST go through this so behavior can never
 * drift between them.
 *
 * When `unarchive` is false and the agent is archived, the call is a silent
 * no-op (returns `{ outOfBand: false }`) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<{ outOfBand: boolean }> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  if (record?.archivedAt) {
    if (!unarchive) {
      return { outOfBand: false };
    }
    await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId);
  }

  await ensureAgentLoaded(params.agentId, {
    agentManager: params.agentManager,
    agentStorage: params.agentStorage,
    logger: params.logger,
  });

  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  const runOptions = params.messageId
    ? { ...params.runOptions, clientMessageId: params.messageId }
    : params.runOptions;

  return await startAgentRun(params.agentManager, params.agentId, params.prompt, params.logger, {
    replaceRunning: true,
    activeTurnBehavior: params.activeTurnBehavior,
    runOptions,
  });
}

export async function startCreatedAgentInitialPrompt(
  params: StartCreatedAgentInitialPromptParams,
): Promise<ManagedAgent> {
  const currentSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!currentSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }

  if (params.prompt === null) {
    return currentSnapshot;
  }

  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    params.prompt,
    params.logger,
    {
      runOptions: params.runOptions,
    },
  );

  if (!dispatchResult.outOfBand) {
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId);
  }

  const refreshedSnapshot = params.agentManager.getAgent(params.agentId) ?? params.snapshot ?? null;
  if (!refreshedSnapshot) {
    throw new Error(`Agent ${params.agentId} not found`);
  }
  return refreshedSnapshot;
}

export interface SetupFinishNotificationParams {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  logger: Logger;
}

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: "finished" | "errored" | "needs permission";
  lastAssistantMessage: string | null;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (!lastAssistantMessage) {
    return statusLine;
  }
  return `${statusLine}\n\n<agent-response>\n${lastAssistantMessage}\n</agent-response>`;
}

export function setupFinishNotification(params: SetupFinishNotificationParams): void {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    logger,
  } = params;
  let hasSeenRunning = false;
  let fired = false;
  let unsubscribe: (() => void) | null = null;

  async function notify(reason: "finished" | "errored" | "needs permission"): Promise<void> {
    if (fired) {
      return;
    }
    fired = true;
    unsubscribe?.();

    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      return;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage,
    });

    await sendPromptToAgent({
      agentManager,
      agentStorage,
      agentId: callerAgentId,
      prompt: formatSystemNotificationPrompt(body),
      unarchive: false,
      logger,
    });
  }

  function notifySafely(reason: "finished" | "errored" | "needs permission"): void {
    void notify(reason).catch((error) => {
      logger.error(
        { err: error, childAgentId, callerAgentId, reason },
        "Failed to notify caller agent",
      );
    });
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (fired) {
        return;
      }

      if (event.type === "agent_state") {
        if (event.agent.lifecycle === "running") {
          hasSeenRunning = true;
          return;
        }
        if (event.agent.lifecycle === "error") {
          notifySafely("errored");
          return;
        }
        if (event.agent.lifecycle === "idle" && hasSeenRunning) {
          notifySafely("finished");
          return;
        }
        if (event.agent.lifecycle === "closed") {
          fired = true;
          unsubscribe?.();
          return;
        }
        return;
      }

      if (event.type === "timeline_replacement") {
        return;
      }

      if (event.event.type === "permission_requested") {
        notifySafely("needs permission");
      }
    },
    { agentId: childAgentId, replayState: false },
  );

  // Check if the child is already running (catches the case where
  // the lifecycle flipped before our subscribe call was processed).
  // Do NOT treat an immediate "idle" as "finished" — the agent may
  // not have started yet (streamAgent sets a pending run before
  // transitioning to "running").
  const childSnapshot = agentManager.getAgent(childAgentId);
  if (!childSnapshot || childSnapshot.lifecycle === "closed") {
    unsubscribe();
    return;
  }
  if (childSnapshot.lifecycle === "running") {
    hasSeenRunning = true;
  } else if (childSnapshot.lifecycle === "error") {
    notifySafely("errored");
  }
}
