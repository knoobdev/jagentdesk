import { ForegroundPromptStart } from "./agent-run-state.js";
import { isStaleProviderSessionError } from "./stale-provider-session-error.js";
import { withTimeout } from "../../utils/promise-timeout.js";
import type { Logger } from "pino";

import { randomUUID } from "node:crypto";
import {
  createAgentMessageDelivery,
  isSystemInjectedEnvelope,
  parseAgentMessages,
  prepareAgentMessage,
  type AgentMessage,
  type AgentMessageDelivery,
  type AgentMessageDeliveryDependencies,
  type AgentMessageReceipt,
  type AgentPromptSource,
} from "./agent-messages/index.js";

import type {
  AgentPermissionRequest,
  AgentPromptInput,
  AgentRunOptions,
} from "./agent-sdk-types.js";
import type { AgentManager, ManagedAgent } from "./agent-manager.js";
import type { AgentStorage } from "./agent-storage.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import {
  completePendingFinishNotifications,
  areFinishNotificationsSuspended,
  getFinishSubscriptionStore,
  hasPendingFinishNotifications,
  returnPendingFinishNotifications,
  type PendingFinishNotification,
  takePendingFinishNotifications,
} from "./finish-subscriptions/index.js";
import { getParentAgentIdFromLabels } from "@jagentdesk/protocol/agent-labels";
import type { ActiveTurnBehavior } from "@jagentdesk/protocol/messages";

export type AgentUnarchiveController = Pick<AgentManager, "notifyAgentState" | "unarchiveSnapshot">;

export type AgentRunController = Pick<
  AgentManager,
  | "getAgent"
  | "tryRunOutOfBand"
  | "hasInFlightRun"
  | "reloadStalePluginSession"
  | "replaceAgentRun"
  | "steerOrReplaceActiveTurn"
  | "streamAgent"
> & { reloadAgentSession(agentId: string): Promise<unknown> };

export interface StartAgentRunOptions {
  idleOnly?: boolean;
  admit?: () => boolean;
  replaceRunning?: boolean;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Ask the provider to deny permissions blocking this steer. */
  clearPendingPermissions?: boolean;
}

export class AgentTurnBusyError extends Error {}

export type PromptDispatchDisposition = "out_of_band" | "steered" | "turn_started";
export type PromptDispatchResult =
  | { disposition: "turn_started"; started: Promise<void> }
  | { disposition: Exclude<PromptDispatchDisposition, "turn_started"> };

async function steerOrReplaceActiveRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
  promptStart: ForegroundPromptStart,
): Promise<
  | { disposition: "steered" }
  | {
      disposition: "turn_started";
      iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
    }
  | null
> {
  if (options?.activeTurnBehavior !== "steer") {
    return null;
  }
  const steerOptions = options.clearPendingPermissions
    ? { ...options.runOptions, clearPendingPermissions: true }
    : options.runOptions;
  const result = await agentManager.steerOrReplaceActiveTurn(
    agentId,
    prompt,
    steerOptions,
    promptStart,
  );
  if (result.status === "steered") {
    return { disposition: "steered" };
  }
  if (result.status === "replaced") {
    return { disposition: "turn_started", iterator: result.iterator };
  }
  return null;
}

async function startOrReplaceRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  options: StartAgentRunOptions | undefined,
  promptStart: ForegroundPromptStart,
): Promise<{
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>;
  replaced: boolean;
}> {
  const replaced = Boolean(options?.replaceRunning && agentManager.hasInFlightRun(agentId));
  if (options?.idleOnly && agentManager.hasInFlightRun(agentId)) throw new AgentTurnBusyError();
  const iterator = replaced
    ? await agentManager.replaceAgentRun(agentId, prompt, options?.runOptions, promptStart)
    : agentManager.streamAgent(agentId, prompt, options?.runOptions, promptStart);
  return { iterator, replaced };
}

async function drainAgentRunIterator(
  iterator: AsyncGenerator<import("./agent-sdk-types.js").AgentStreamEvent>,
): Promise<void> {
  for await (const _ of iterator) {
    // Events are broadcast via AgentManager subscribers.
  }
}

export async function startAgentRun(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options?: StartAgentRunOptions,
): Promise<PromptDispatchResult> {
  const snapshot = agentManager.getAgent(agentId);
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
  // Out-of-band commands (e.g. /goal pause) must run WITHOUT canceling an
  // in-flight turn — replaceAgentRun would interrupt the running turn. The
  // intercept lives at this layer so it covers every prompt entrypoint.
  if (
    await agentManager.tryRunOutOfBand(agentId, prompt, options?.runOptions, () => {
      if (options?.admit?.() === false) throw new Error("Queued agent message was withdrawn");
    })
  ) {
    return { disposition: "out_of_band" };
  }
  const promptStart = new ForegroundPromptStart(agentId, options?.admit);
  try {
    try {
      await agentManager.reloadStalePluginSession(agentId);
      return await startAgentRunInner(agentManager, agentId, prompt, logger, options, promptStart);
    } catch (error) {
      if (!isStaleProviderSessionError(error)) throw error;
      logger.info(
        { agentId, err: error },
        "Provider session went stale; reopening from persistence",
      );
      // The live session belongs to a retired plugin runtime. Reload swaps in a
      // fresh session on the current runtime while preserving history and labels.
      await agentManager.reloadAgentSession(agentId);
      return await startAgentRunInner(agentManager, agentId, prompt, logger, options, promptStart);
    }
  } catch (error) {
    promptStart.end();
    throw error;
  }
}

async function startAgentRunInner(
  agentManager: AgentRunController,
  agentId: string,
  prompt: AgentPromptInput,
  logger: Logger,
  options: StartAgentRunOptions | undefined,
  promptStart: ForegroundPromptStart,
): Promise<PromptDispatchResult> {
  const snapshot = agentManager.getAgent(agentId);
  const steered = options?.idleOnly
    ? null
    : await steerOrReplaceActiveRun(agentManager, agentId, prompt, options, promptStart);
  if (steered?.disposition === "steered") {
    return steered;
  }
  const { iterator, replaced } = steered
    ? { iterator: steered.iterator, replaced: true }
    : await startOrReplaceRun(agentManager, agentId, prompt, options, promptStart);
  logger.trace(
    {
      agentId,
      provider: snapshot?.provider,
      providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
      shouldReplace: replaced,
    },
    "agent.session.start_stream.iterator_returned",
  );
  void (async () => {
    try {
      try {
        await drainAgentRunIterator(iterator);
      } catch (error) {
        if (!isStaleProviderSessionError(error)) throw error;
        logger.info(
          { agentId, err: error },
          "Provider session went stale; reopening from persistence",
        );
        await agentManager.reloadAgentSession(agentId);
        const retry = await startOrReplaceRun(agentManager, agentId, prompt, options, promptStart);
        await drainAgentRunIterator(retry.iterator);
      }
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
        },
        "agent.session.iterator.drained",
      );
    } catch (error) {
      logger.trace(
        {
          agentId,
          provider: snapshot?.provider,
          providerSessionId: snapshot?.persistence?.sessionId ?? undefined,
          err: error,
        },
        "agent.session.iterator.error",
      );
      logger.error({ err: error, agentId }, "Agent stream failed");
    } finally {
      promptStart.end();
    }
  })();
  return { disposition: "turn_started", started: promptStart.started };
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

// The legacy hidden envelope lives with the versioned agent-message envelope.
export {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
} from "./agent-messages/index.js";

export interface SkillInvocationResolver {
  buildInvocationPrefix(
    skillIds: readonly string[],
    provider: string,
    cwd?: string | null,
  ): Promise<string>;
}

/** Put the skill invocation line in front of the user's text. */
export function prependInvocation(prompt: AgentPromptInput, line: string): AgentPromptInput {
  if (!line) return prompt;
  if (typeof prompt === "string") {
    return prompt.trim() ? `${line}\n\n${prompt}` : line;
  }
  const firstText = prompt.findIndex((block) => block.type === "text");
  if (firstText === -1) return [{ type: "text", text: line }, ...prompt];
  return prompt.map((block, index) =>
    index === firstText && block.type === "text"
      ? { ...block, text: block.text.trim() ? `${line}\n\n${block.text}` : line }
      : block,
  );
}

async function withSkillInvocation(params: SendPromptToAgentParams): Promise<AgentPromptInput> {
  if (!params.skillIds?.length || !params.skillInvocation) return params.prompt;
  const agent = params.agentManager.getAgent(params.agentId);
  if (!agent) return params.prompt;
  const provider = params.agentManager.getBaseProviderId(agent.provider);
  const line = await params.skillInvocation.buildInvocationPrefix(
    params.skillIds,
    provider,
    agent.cwd,
  );
  return prependInvocation(params.prompt, line);
}

export interface SendPromptToAgentParams {
  idleOnly?: boolean;
  admit?: () => boolean;
  beforeDispatch?: () => Promise<void>;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  agentId: string;
  /** Prompt to dispatch to the provider (may include image blocks or wrapped text). */
  prompt: AgentPromptInput;
  messageId?: string;
  /**
   * Sender of an agent-originated prompt (ADR-0029). When set, the prompt is
   * wrapped in the versioned `<jagentdesk-system version="1">` envelope so the
   * recipient and the app know who sent it.
   */
  source?: AgentPromptSource;
  activeTurnBehavior?: ActiveTurnBehavior;
  runOptions?: AgentRunOptions;
  /** Optional mode to set on the agent before the run starts. */
  sessionMode?: string;
  /**
   * Native skills attached to this turn (spec 22.7). The daemon prefixes the
   * provider's invocation (`/name`, `$name`, `/skill:name`, …) — so the app,
   * the CLI and `send_agent_prompt` all get the same behavior.
   */
  skillIds?: readonly string[];
  skillInvocation?: SkillInvocationResolver | null;
  /**
   * Default true. When false, archived agents are skipped instead of being
   * unarchived. Use false for system-injected prompts (chat mentions,
   * schedule fires, notify-on-finish).
   */
  unarchive?: boolean;
  /** See {@link StartAgentRunOptions.clearPendingPermissions}. */
  clearPendingPermissions?: boolean;
  logger: Logger;
}

export interface StartCreatedAgentInitialPromptParams {
  agentManager: AgentManager;
  agentStorage?: AgentStorage;
  source?: AgentPromptSource;
  agentId: string;
  snapshot?: ManagedAgent;
  prompt: AgentPromptInput | null;
  runOptions?: AgentRunOptions;
  logger: Logger;
}

/**
 * Outer bound on a run reaching "started" after dispatch.
 *
 * This wraps provider startup, so it MUST stay larger than the slowest provider's own
 * startup budget — otherwise it aborts a start the provider was still allowed to be
 * working on, and the provider's budget can never apply. OpenCode is the slowest today:
 * up to 30s for the server to boot (OPENCODE_SERVER_STARTUP_TIMEOUT_MS) and then a
 * session.create on the same budget, so this is deliberately set well above 30s.
 *
 * Not derived from the provider constant on purpose: this module is provider-agnostic
 * and must not depend on a specific provider's internals.
 */
const AGENT_RUN_START_TIMEOUT_MS = 60_000;

export async function waitForAgentRunStartWithTimeout(
  agentManager: AgentManager,
  agentId: string,
  started?: Promise<void>,
): Promise<void> {
  const provider = agentManager.getAgent(agentId)?.provider ?? "provider";
  const abort = new AbortController();
  try {
    await withTimeout(
      started ?? agentManager.waitForAgentRunStart(agentId, { signal: abort.signal }),
      AGENT_RUN_START_TIMEOUT_MS,
      `${provider} run did not start within ${AGENT_RUN_START_TIMEOUT_MS / 1000} seconds (phase: run start)`,
    );
  } finally {
    abort.abort();
  }
}

async function resolvePromptSource(
  source: AgentPromptSource | undefined,
  manager: Pick<AgentManager, "getAgent">,
  storage: AgentStorage | undefined,
): Promise<AgentPromptSource | undefined> {
  if (!source || source.kind === "change-request-update") return source;
  if (source.title) return source;
  const title = (
    manager.getAgent(source.agentId)?.config?.title ??
    (storage ? (await storage.get(source.agentId))?.title : undefined)
  )?.trim();
  return title ? { ...source, title } : source;
}

interface AgentMessageDeliveryContext {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
}

type AgentMessageDeliveryTiming = Pick<
  AgentMessageDeliveryDependencies,
  "schedule" | "now" | "quietMs" | "maxWaitMs"
>;

// One recipient-owned delivery queue per daemon (keyed by its AgentManager), so
// every agent/system sender — MCP, CLI, ORC, chat mentions, finish
// notifications — shares the same 2 s window per recipient (ADR-0029 decision 3).
const agentMessageDeliveries = new WeakMap<AgentManager, AgentMessageDelivery>();
const agentMessageDeliveryTimings = new WeakMap<AgentManager, AgentMessageDeliveryTiming>();

let defaultAgentMessageDeliveryTiming: AgentMessageDeliveryTiming = {};

/**
 * Test-only: timing for deliveries created from now on (e.g. `{ quietMs: 0 }` so
 * notification-format tests do not wait two seconds per message).
 */
export function setDefaultAgentMessageDeliveryTimingForTests(
  timing: AgentMessageDeliveryTiming,
): void {
  defaultAgentMessageDeliveryTiming = timing;
}

/** Tests use this to run the quiet window on their own clock. */
export function configureAgentMessageDelivery(
  agentManager: AgentManager,
  timing: AgentMessageDeliveryTiming,
): void {
  agentMessageDeliveryTimings.set(agentManager, timing);
}

export function getAgentMessageDelivery(
  context: AgentMessageDeliveryContext,
): AgentMessageDelivery {
  const existing = agentMessageDeliveries.get(context.agentManager);
  if (existing) return existing;
  const delivery = createAgentMessageDelivery({
    ...defaultAgentMessageDeliveryTiming,
    ...agentMessageDeliveryTimings.get(context.agentManager),
    isRunning: (agentId) => context.agentManager.hasInFlightRun(agentId),
    subscribe: (listener) =>
      context.agentManager.subscribe((event) => {
        if (event.type === "agent_state") listener(event.agent.id);
      }),
    resolveSource: async (source) =>
      (await resolvePromptSource(source, context.agentManager, context.agentStorage)) ?? source,
    dispatch: async (request) => {
      const result = await sendPreparedPromptToAgent({
        agentManager: context.agentManager,
        agentStorage: context.agentStorage,
        agentId: request.recipientId,
        prompt: request.prompt,
        messageId: request.messageIds[0],
        sessionMode: request.sessionMode,
        unarchive: request.unarchive,
        activeTurnBehavior: request.activeTurnBehavior,
        clearPendingPermissions: request.clearPendingPermissions,
        idleOnly: request.idleOnly,
        admit: request.admit,
        beforeDispatch: request.beforeDispatch,
        logger: context.logger,
      });
      if (result.disposition === "turn_started") {
        await waitForAgentRunStartWithTimeout(
          context.agentManager,
          request.recipientId,
          result.started,
        );
      }
      return result.disposition;
    },
    onError: (error, request) =>
      context.logger.error(
        { err: error, agentId: request.recipientId, messageIds: request.messageIds },
        "Agent message batch dispatch failed",
      ),
  });
  agentMessageDeliveries.set(context.agentManager, delivery);
  return delivery;
}

/** Admit an agent/system message for a recipient; returns at once with a queued receipt. */
export function enqueueAgentMessage(
  context: AgentMessageDeliveryContext,
  message: AgentMessage,
): AgentMessageReceipt {
  return getAgentMessageDelivery(context).enqueue(message);
}

/** Resolve once every agent message admitted for the recipient so far has been dispatched. */
export async function waitForAgentMessageDispatch(
  agentManager: AgentManager,
  recipientId: string,
  signal?: AbortSignal,
): Promise<void> {
  await agentMessageDeliveries.get(agentManager)?.waitForDispatch(recipientId, signal);
}

/** Graceful shutdown: flush every pending window and await the dispatches. */
export async function closeAgentMessageDelivery(agentManager: AgentManager): Promise<void> {
  const delivery = agentMessageDeliveries.get(agentManager);
  if (!delivery) return;
  agentMessageDeliveries.delete(agentManager);
  await delivery.close();
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
 * no-op (returns the out-of-band disposition) — the agent is not run.
 */
export async function sendPromptToAgent(
  params: SendPromptToAgentParams,
): Promise<PromptDispatchResult> {
  return await dispatchPrompt(params, { prepared: false });
}

/**
 * Like {@link sendPromptToAgent}, but the prompt is already in its final form and
 * is not wrapped again. Hidden schedule envelopes go through here so they stay
 * hidden instead of being quoted as user text.
 */
export async function sendPreparedPromptToAgent(
  params: Omit<SendPromptToAgentParams, "source">,
): Promise<PromptDispatchResult> {
  return await dispatchPrompt(params, { prepared: true });
}

async function loadPromptRecipient(params: SendPromptToAgentParams): Promise<boolean> {
  const unarchive = params.unarchive ?? true;

  const record = await params.agentStorage.get(params.agentId);
  let archivedAtToRestore: string | null = null;
  if (record?.archivedAt) {
    if (!unarchive) {
      return false;
    }
    if (await unarchiveAgentState(params.agentStorage, params.agentManager, params.agentId)) {
      archivedAtToRestore = record.archivedAt;
    }
  }

  try {
    await ensureAgentLoaded(params.agentId, {
      agentManager: params.agentManager,
      agentStorage: params.agentStorage,
      logger: params.logger,
    });
  } catch (error) {
    // A send that could not load the agent leaves it where it was: still archived.
    // Concurrent sends share this load, so none of them holds a live session.
    if (archivedAtToRestore) {
      await params.agentManager.archiveSnapshot(params.agentId, archivedAtToRestore);
    }
    throw error;
  }

  return true;
}

async function acknowledgeCarriedFinishNotifications(
  params: SendPromptToAgentParams,
  result: PromptDispatchResult,
  carried: PendingFinishNotification[],
): Promise<void> {
  if (carried.length && result.disposition === "turn_started")
    await waitForAgentRunStartWithTimeout(params.agentManager, params.agentId, result.started);
  await completePendingFinishNotifications(params.agentManager, carried);
}

async function runPendingFinishCommand(params: SendPromptToAgentParams): Promise<boolean> {
  if (!params.source && hasPendingFinishNotifications(params.agentManager, params.agentId)) {
    const runOptions = params.messageId
      ? { ...params.runOptions, clientMessageId: params.messageId }
      : params.runOptions;
    if (await params.agentManager.tryRunOutOfBand(params.agentId, params.prompt, runOptions)) {
      return true;
    }
  }
  return false;
}

async function dispatchPrompt(
  params: SendPromptToAgentParams,
  options: { prepared: boolean },
): Promise<PromptDispatchResult> {
  if (!(await loadPromptRecipient(params))) return { disposition: "out_of_band" };

  if (params.idleOnly && params.agentManager.hasInFlightRun(params.agentId))
    throw new AgentTurnBusyError();
  if (params.sessionMode) {
    await params.agentManager.setAgentMode(params.agentId, params.sessionMode);
  }

  await params.beforeDispatch?.();
  if (!params.idleOnly && params.admit?.() === false)
    throw new Error("Queued agent message was withdrawn");

  let prompt: AgentPromptInput;
  let messageId = params.messageId;
  if (await runPendingFinishCommand(params)) return { disposition: "out_of_band" };
  if (options.prepared) {
    prompt = await withSkillInvocation(params);
  } else {
    const source = await resolvePromptSource(
      params.source,
      params.agentManager,
      params.agentStorage,
    );
    const delivery = prepareAgentMessage(params.prompt, source, params.messageId);
    messageId = delivery.messageId;
    // The skill invocation line must stay first for the provider, so it goes in
    // front of the envelope rather than inside it.
    prompt = await withSkillInvocation({ ...params, prompt: delivery.prompt });
  }

  // Notifications kept across a daemon restart ride along with this turn instead of
  // waking the parent on their own (ADR-0029 decision 5).
  const attached = params.skillIds?.length
    ? []
    : takePendingFinishNotifications(params.agentManager, params.agentId);
  let carried: PendingFinishNotification[] = [];
  if (attached.length > 0) {
    const withNotifications = attachFinishNotifications(prompt, messageId, attached);
    if (withNotifications) {
      prompt = withNotifications.prompt;
      messageId = withNotifications.messageId;
      carried = attached;
    } else {
      returnPendingFinishNotifications(params.agentManager, params.agentId, attached);
    }
  }

  const runOptions = messageId
    ? { ...params.runOptions, clientMessageId: messageId }
    : params.runOptions;

  try {
    const result = await startAgentRun(params.agentManager, params.agentId, prompt, params.logger, {
      replaceRunning: !params.idleOnly,
      idleOnly: params.idleOnly,
      admit: params.admit,
      // Agent- and system-sent messages steer by default; user commands keep
      // interrupt (ADR-0029 decision 2, amending ADR-0013).
      activeTurnBehavior: params.activeTurnBehavior ?? (params.source ? "steer" : undefined),
      clearPendingPermissions: params.clearPendingPermissions,
      runOptions,
    });
    await acknowledgeCarriedFinishNotifications(params, result, carried);
    return result;
  } catch (error) {
    returnPendingFinishNotifications(params.agentManager, params.agentId, carried);
    throw error;
  }
}

/**
 * Put kept finish notifications in front of a turn, each as its own envelope, so
 * the app shows "X closed" rows and the user's text stays a user row. Returns null
 * when the prompt cannot carry them (a legacy hidden envelope), so they wait.
 */
function attachFinishNotifications(
  prompt: AgentPromptInput,
  messageId: string | undefined,
  notifications: PendingFinishNotification[],
): { prompt: AgentPromptInput; messageId: string | undefined } | null {
  const envelopes = notifications.map(
    (entry) => prepareAgentMessage(entry.body, entry.source).prompt as string,
  );
  const text =
    typeof prompt === "string"
      ? prompt
      : prompt.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  if (isSystemInjectedEnvelope(text)) return null;
  let body: AgentPromptInput = prompt;
  let id = messageId;
  if (!parseAgentMessages(text)) {
    const wrapped = prepareAgentMessage(prompt, undefined, messageId ?? randomUUID(), {
      wrapUserMessage: true,
    });
    body = wrapped.prompt;
    id = wrapped.messageId;
  }
  if (typeof body === "string") {
    return { prompt: [...envelopes, body].join("\n\n"), messageId: id };
  }
  const [first, ...rest] = body;
  if (first?.type !== "text") return null;
  return {
    prompt: [{ ...first, text: [...envelopes, first.text].join("\n\n") }, ...rest],
    messageId: id,
  };
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

  const delivery = prepareAgentMessage(
    params.prompt,
    await resolvePromptSource(params.source, params.agentManager, params.agentStorage),
    params.runOptions?.clientMessageId,
  );
  const dispatchResult = await startAgentRun(
    params.agentManager,
    params.agentId,
    delivery.prompt,
    params.logger,
    {
      runOptions: delivery.messageId
        ? { ...params.runOptions, clientMessageId: delivery.messageId }
        : params.runOptions,
    },
  );

  if (dispatchResult.disposition === "turn_started") {
    await waitForAgentRunStartWithTimeout(
      params.agentManager,
      params.agentId,
      dispatchResult.started,
    );
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
  waitForTurnStart?: boolean;
  logger: Logger;
}

type FinishNotificationReason =
  | "finished"
  | "errored"
  | "needs permission"
  | "was closed"
  | "was canceled";

const FINISH_NOTIFICATION_MESSAGE_LIMIT = 4000;

const finishNotificationEvents = {
  finished: "finished",
  errored: "errored",
  "needs permission": "permission-required",
  "was closed": "closed",
  // Use the existing failure event so older clients still parse agent-message metadata.
  "was canceled": "errored",
} as const;

interface FinishNotificationBodyInput {
  childAgentId: string;
  title: string;
  reason: FinishNotificationReason;
  lastAssistantMessage: string | null;
  permissionRequest?: AgentPermissionRequest;
}

function formatFinishNotificationBody(params: FinishNotificationBodyInput): string {
  const statusLine = `Agent ${params.childAgentId} (${params.title}) ${params.reason}.`;
  const sections = [statusLine];
  if (params.reason === "needs permission" && params.permissionRequest) {
    sections.push(
      "Respond with `respond_to_permission` using the `agentId` and `requestId` below.",
      `<permission-request>\n${JSON.stringify(
        {
          agentId: params.childAgentId,
          requestId: params.permissionRequest.id,
          request: params.permissionRequest,
        },
        null,
        2,
      )}\n</permission-request>`,
    );
  }
  let lastAssistantMessage = params.lastAssistantMessage?.trim();
  if (lastAssistantMessage) {
    if (lastAssistantMessage.length > FINISH_NOTIFICATION_MESSAGE_LIMIT) {
      const omitted = lastAssistantMessage.length - FINISH_NOTIFICATION_MESSAGE_LIMIT;
      lastAssistantMessage = `${lastAssistantMessage.slice(0, FINISH_NOTIFICATION_MESSAGE_LIMIT)}\n[truncated ${omitted} chars; use get_agent_activity for the full response]`;
    }
    sections.push(`<agent-response>\n${lastAssistantMessage}\n</agent-response>`);
  }
  return sections.join("\n\n");
}

interface NotifySafelyOptions {
  terminal?: boolean;
  permissionRequest?: AgentPermissionRequest;
}

// A caller waits on a child through one armed notification. Arming again, such as a
// follow-up prompt while the child still runs, replaces the earlier one so the child's
// next finish reaches the caller once.
const armedFinishNotifications = new WeakMap<AgentManager, Map<string, () => void>>();

export function setupFinishNotification(
  params: SetupFinishNotificationParams,
): (() => void) & { ready: Promise<void> } {
  const {
    agentManager,
    agentStorage,
    childAgentId,
    callerAgentId,
    requireParentOwnership = false,
    waitForTurnStart = false,
    logger,
  } = params;
  let hasSeenRunning = false;
  let hasSeenTurn = false;
  let stopped = false;
  const notifiedPermissionRequestIds = new Set<string>();
  let unsubscribe: (() => void) | null = null;
  let notificationQueue = Promise.resolve();

  const armedByManager = armedFinishNotifications.get(agentManager) ?? new Map();
  armedFinishNotifications.set(agentManager, armedByManager);
  const armedKey = JSON.stringify([childAgentId, callerAgentId]);
  armedByManager.get(armedKey)?.();
  armedByManager.set(armedKey, stop);

  // Durable record (ADR-0029 decision 4): written now, so a subscription armed
  // before the child's first prompt survives a restart; removed only once the
  // notification has been dispatched or the subscription is dropped on purpose.
  const store = getFinishSubscriptionStore(agentManager);
  const subscriptionId = store
    ? store.add({ childAgentId, callerAgentId, requireParentOwnership })
    : Promise.resolve(null);
  const registration = Object.assign(stop, { ready: subscriptionId.then(() => undefined) });
  void registration.ready.catch((error: unknown) => {
    logger.error({ err: error, childAgentId, callerAgentId }, "Failed to save finish subscription");
    stopObserving();
  });

  function settle(): void {
    void subscriptionId
      .then((id) => (id && store ? store.remove(id) : undefined))
      .catch((error: unknown) => {
        logger.warn(
          { err: error, childAgentId, callerAgentId },
          "Failed to remove finish subscription",
        );
      });
  }

  function stopObserving(): void {
    if (stopped) return;
    stopped = true;
    unsubscribe?.();
    if (armedByManager.get(armedKey) === stop) {
      armedByManager.delete(armedKey);
    }
  }

  function stop(): void {
    if (stopped) return;
    stopObserving();
    settle();
  }

  async function notify(
    reason: FinishNotificationReason,
    permissionRequest?: AgentPermissionRequest,
  ): Promise<boolean> {
    if (areFinishNotificationsSuspended(agentManager)) return false;
    const callerRecord = await agentStorage.get(callerAgentId);
    if (callerRecord?.archivedAt) {
      return true;
    }

    const record = await agentStorage.get(childAgentId);
    if (requireParentOwnership && getParentAgentIdFromLabels(record?.labels) !== callerAgentId) {
      return true;
    }
    const title = record?.title ?? childAgentId;
    const lastAssistantMessage = await agentManager.getLastAssistantMessage(childAgentId);
    const body = formatFinishNotificationBody({
      childAgentId,
      title,
      reason,
      lastAssistantMessage,
      permissionRequest,
    });

    // Rides the recipient's delivery window, so a peer's report and its finish
    // notification reach the caller in one steered prompt (ADR-0029 decision 3).
    const receipt = enqueueAgentMessage(
      { agentManager, agentStorage, logger },
      {
        recipientId: callerAgentId,
        prompt: body,
        source: {
          kind: "agent-notification",
          agentId: childAgentId,
          ...(record?.title ? { title: record.title } : {}),
          event: finishNotificationEvents[reason],
        },
        activeTurnBehavior: "steer",
        unarchive: false,
      },
    );
    await receipt.dispatched;
    return true;
  }

  function notifySafely(reason: FinishNotificationReason, options: NotifySafelyOptions = {}): void {
    if (stopped) return;
    const terminal = options.terminal ?? true;
    if (terminal) stopObserving();
    notificationQueue = notificationQueue
      .then(async () => {
        const delivered = await notify(reason, options.permissionRequest);
        // A failed dispatch keeps the record, so a restart can still report it.
        if (terminal && delivered) settle();
        return undefined;
      })
      .catch((error) => {
        logger.error(
          { err: error, childAgentId, callerAgentId, reason },
          "Failed to notify caller agent",
        );
      });
  }

  function observeState(agent: ManagedAgent): void {
    for (const requestId of notifiedPermissionRequestIds) {
      if (!agent.pendingPermissions.has(requestId)) {
        notifiedPermissionRequestIds.delete(requestId);
      }
    }
    if (agent.lifecycle === "running") {
      if (waitForTurnStart && !hasSeenTurn) return;
      hasSeenTurn = true;
      if (agent.pendingPermissions.size === 0) {
        hasSeenRunning = true;
      }
      return;
    }
    // Prior terminal state is not this task's outcome. A failure before turn start
    // is reported by the dispatch acknowledgement instead of a finish callback.
    if (agent.lifecycle === "error" && hasSeenTurn) {
      notifySafely("errored");
      return;
    }
    // Idle is published before the terminal stream event for both completion
    // and cancellation. Let that event identify the outcome instead.
    if (agent.lifecycle === "closed") {
      notifySafely("was closed");
      return;
    }
    return;
  }

  unsubscribe = agentManager.subscribe(
    (event) => {
      if (stopped) {
        return;
      }

      if (event.type === "agent_state") {
        observeState(event.agent);
        return;
      }

      if (event.type === "timeline_replacement" || event.type === "background_work") {
        return;
      }

      if (event.event.type === "turn_started") {
        hasSeenTurn = true;
        hasSeenRunning = true;
        return;
      }

      if (event.event.type === "turn_completed" || event.event.type === "turn_canceled") {
        // Replacing a turn keeps the child running through the displaced turn's
        // cancellation. The task settles only when the child becomes idle.
        if (agentManager.getAgent(childAgentId)?.lifecycle !== "idle") return;
        if (event.event.type === "turn_completed" && hasSeenRunning) {
          notifySafely("finished");
        } else if (event.event.type === "turn_canceled" && hasSeenTurn) {
          notifySafely("was canceled");
        }
        return;
      }

      if (event.event.type === "permission_requested") {
        // A permission pause is an intermediate checkpoint. Forget the run
        // observed before it so an idle state during follow-up startup cannot
        // masquerade as the final completion.
        hasSeenRunning = false;
        if (!notifiedPermissionRequestIds.has(event.event.request.id)) {
          notifiedPermissionRequestIds.add(event.event.request.id);
          notifySafely("needs permission", {
            terminal: false,
            permissionRequest: event.event.request,
          });
        }
        return;
      }

      if (event.event.type === "permission_resolved") {
        notifiedPermissionRequestIds.delete(event.event.requestId);
        const childAgent = agentManager.getAgent(childAgentId);
        if (childAgent?.pendingPermissions.size === 0) {
          hasSeenRunning = childAgent.lifecycle === "running";
        }
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
    stop();
    return registration;
  }
  if (childSnapshot.lifecycle === "running" && !waitForTurnStart) {
    hasSeenTurn = true;
    hasSeenRunning = true;
  }
  return registration;
}
