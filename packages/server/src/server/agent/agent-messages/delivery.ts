import { randomUUID } from "node:crypto";
import type { AgentPromptContentBlock, AgentPromptInput } from "../agent-sdk-types.js";
import { prepareAgentMessage, type AgentPromptSource } from "./envelope.js";
import { AgentTurnBusyError } from "../agent-prompt.js";

/** Same shape as `PromptDispatchDisposition` in agent-prompt.ts (kept local to avoid a cycle). */
export type AgentMessageDispatchDisposition = "out_of_band" | "steered" | "turn_started";

/** Messages arriving within this quiet window share one recipient turn (ADR-0029 decision 3). */
export const AGENT_MESSAGE_QUIET_MS = 2_000;
/** A steady stream of messages still dispatches this long after the first one. */
export const AGENT_MESSAGE_MAX_WAIT_MS = 10_000;

export interface AgentMessage {
  recipientId: string;
  messageId?: string;
  source: AgentPromptSource;
  prompt: AgentPromptInput;
  sessionMode?: string;
  unarchive?: boolean;
  clearPendingPermissions?: boolean;
  activeTurnBehavior?: "steer" | "interrupt";
  beforeDispatch?: () => void | Promise<void>;
  onDispatch?: (disposition: AgentMessageDispatchDisposition) => void;
}

export interface AgentMessageReceipt {
  status: "queued";
  messageId: string;
  dispatched: Promise<AgentMessageDispatchDisposition>;
}

interface Admitted extends AgentMessage {
  state: "queued" | "claimed" | "withdrawn";
  receipt: AgentMessageReceipt;
  resolve(disposition: AgentMessageDispatchDisposition): void;
  reject(error: unknown): void;
}

export interface AgentMessageDispatchRequest {
  recipientId: string;
  messageIds: readonly string[];
  prompt: AgentPromptInput;
  activeTurnBehavior: "steer" | "interrupt";
  sessionMode?: string;
  clearPendingPermissions: boolean;
  unarchive: boolean;
  idleOnly: boolean;
  admit(): boolean;
  beforeDispatch(): Promise<void>;
}

export interface AgentMessageDeliveryDependencies {
  isRunning?: (recipientId: string) => boolean;
  subscribe?: (listener: (recipientId: string) => void) => () => void;
  dispatch(request: AgentMessageDispatchRequest): Promise<AgentMessageDispatchDisposition>;
  onError(error: unknown, request: AgentMessageDispatchRequest): void;
  /** Fill in the sender title before the envelope is written. */
  resolveSource?: (source: AgentPromptSource) => Promise<AgentPromptSource>;
  /** Return a cancellation function. Production uses the daemon's event loop. */
  schedule?: (delayMs: number, callback: () => void) => () => void;
  now?: () => number;
  quietMs?: number;
  maxWaitMs?: number;
}

export interface AgentMessageDelivery {
  enqueue(message: AgentMessage): AgentMessageReceipt;
  withdrawPending(recipientId: string, matches: (source: AgentPromptSource) => boolean): number;
  hasPending(recipientId: string): boolean;
  /** Stop admission, flush pending messages, and await provider dispatch acknowledgments. */
  close(): Promise<void>;
  /** Completion waits include agent messages admitted before the wait. */
  waitForDispatch(recipientId: string, signal?: AbortSignal): Promise<void>;
}

interface PendingRecipient {
  ready: boolean;
  messages: Admitted[];
  firstAdmittedAt: number;
  cancel(): void;
}

/**
 * Recipient-owned agent delivery. Agent and system messages for one recipient are
 * gathered for a quiet window and dispatched as one prompt (one envelope per
 * message). Human prompts never enter this module.
 */
export function createAgentMessageDelivery(
  dependencies: AgentMessageDeliveryDependencies,
): AgentMessageDelivery {
  const schedule =
    dependencies.schedule ??
    ((delayMs, callback) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const now = dependencies.now ?? Date.now;
  const quietMs = dependencies.quietMs ?? AGENT_MESSAGE_QUIET_MS;
  const maxWaitMs = dependencies.maxWaitMs ?? AGENT_MESSAGE_MAX_WAIT_MS;
  const resolveSource = dependencies.resolveSource ?? (async (source) => source);
  const pending = new Map<string, PendingRecipient>();
  const dispatching = new Map<string, Promise<void>>();
  const admitted = new Map<string, Set<Admitted>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  async function buildPrompt(messages: Admitted[]): Promise<AgentPromptInput> {
    const prompts = await Promise.all(
      messages.map(
        async (message) =>
          prepareAgentMessage(
            message.prompt,
            await resolveSource(message.source),
            message.receipt.messageId,
          ).prompt,
      ),
    );
    return prompts.every((entry) => typeof entry === "string")
      ? prompts.join("\n\n")
      : prompts.flatMap((entry): AgentPromptContentBlock[] =>
          typeof entry === "string" ? [{ type: "text", text: entry }] : entry,
        );
  }

  function dispatch(recipientId: string, batch: Admitted[]): void {
    const previous = dispatching.get(recipientId) ?? Promise.resolve();
    const dispatched = previous
      .catch(() => undefined)
      .then(async () => {
        const messages = batch.filter((message) => message.state === "queued");
        if (!messages.length) return;
        const idleOnly =
          !closed && messages.every((message) => message.source.kind === "change-request-update");
        const request: AgentMessageDispatchRequest = {
          recipientId,
          messageIds: messages.map((message) => message.receipt.messageId),
          prompt: "",
          activeTurnBehavior: messages[0]!.activeTurnBehavior ?? "steer",
          sessionMode: messages.find((message) => message.sessionMode)?.sessionMode,
          clearPendingPermissions: messages.some((message) => message.clearPendingPermissions),
          unarchive: messages.some((message) => message.unarchive !== false),
          idleOnly,
          admit() {
            if (messages.some((message) => message.state === "withdrawn")) return false;
            for (const message of messages) message.state = "claimed";
            return true;
          },
          async beforeDispatch() {
            for (const message of messages) await message.beforeDispatch?.();
          },
        };
        try {
          request.prompt = await buildPrompt(messages);
          const disposition = await dependencies.dispatch(request);
          for (const message of messages) {
            message.state = "claimed";
            try {
              message.onDispatch?.(disposition);
            } catch (error) {
              dependencies.onError(error, request);
            }
            message.resolve(disposition);
          }
          return undefined;
        } catch (error) {
          const remaining = messages.filter((message) => message.state !== "withdrawn");
          if (error instanceof AgentTurnBusyError || remaining.length !== messages.length) {
            if (remaining.length) requeue(recipientId, remaining);
            return;
          }
          for (const message of messages) message.reject(error);
          dependencies.onError(error, request);
          throw error;
        }
      });
    dispatching.set(recipientId, dispatched);
    void dispatched
      .finally(() => {
        if (dispatching.get(recipientId) === dispatched) dispatching.delete(recipientId);
      })
      .catch(() => undefined);
  }

  function requeue(recipientId: string, messages: Admitted[]): void {
    for (const message of messages) message.state = "queued";
    const entry = pending.get(recipientId) ?? {
      messages: [],
      firstAdmittedAt: now(),
      ready: true,
      cancel: () => {},
    };
    entry.cancel();
    entry.messages.unshift(...messages);
    entry.ready = true;
    entry.cancel = schedule(quietMs, () => flush(recipientId));
    pending.set(recipientId, entry);
  }

  function flush(recipientId: string): void {
    const entry = pending.get(recipientId);
    if (!entry) return;
    entry.ready = true;
    if (
      !closed &&
      dependencies.isRunning?.(recipientId) &&
      entry.messages.every((message) => message.source.kind === "change-request-update")
    ) {
      entry.cancel();
      entry.cancel = schedule(quietMs, () => flush(recipientId));
      return;
    }
    pending.delete(recipientId);
    entry.cancel();
    let group: Admitted[] = [];
    let mode: string | undefined;
    for (const message of entry.messages) {
      // Steer and interrupt (or conflicting modes) need separate, ordered dispatches.
      if (
        group.length &&
        ((message.activeTurnBehavior ?? "steer") !== (group[0]!.activeTurnBehavior ?? "steer") ||
          (mode && message.sessionMode && mode !== message.sessionMode))
      ) {
        dispatch(recipientId, group);
        group = [];
        mode = undefined;
      }
      group.push(message);
      mode ??= message.sessionMode;
    }
    if (group.length) dispatch(recipientId, group);
  }

  const unsubscribe = dependencies.subscribe?.((recipientId) => {
    if (pending.get(recipientId)?.ready) flush(recipientId);
  });

  return {
    hasPending: (recipientId) => pending.has(recipientId) || dispatching.has(recipientId),
    withdrawPending(recipientId, matches) {
      let removed = 0;
      for (const message of admitted.get(recipientId) ?? []) {
        if (message.state !== "queued" || !matches(message.source)) continue;
        message.state = "withdrawn";
        message.reject(new DOMException("Agent message withdrawn", "AbortError"));
        removed++;
      }
      const entry = pending.get(recipientId);
      if (entry) {
        entry.messages = entry.messages.filter((message) => message.state !== "withdrawn");
        if (!entry.messages.length) {
          entry.cancel();
          pending.delete(recipientId);
        }
      }
      return removed;
    },
    enqueue(message) {
      if (closed) throw new Error("Agent message delivery is closed");
      let resolve!: Admitted["resolve"];
      let reject!: Admitted["reject"];
      const dispatched = new Promise<AgentMessageDispatchDisposition>((accepted, failed) => {
        resolve = accepted;
        reject = failed;
      });
      void dispatched.catch(() => undefined);
      const receipt: AgentMessageReceipt = {
        status: "queued",
        messageId: message.messageId ?? randomUUID(),
        dispatched,
      };
      const admittedAt = now();
      const entry = pending.get(message.recipientId) ?? {
        messages: [],
        ready: false,
        firstAdmittedAt: admittedAt,
        cancel: () => {},
      };
      entry.cancel();
      entry.ready = false;
      const item: Admitted = { ...message, receipt, resolve, reject, state: "queued" };
      const owned = admitted.get(message.recipientId) ?? new Set<Admitted>();
      owned.add(item);
      admitted.set(message.recipientId, owned);
      void dispatched
        .finally(() => {
          owned.delete(item);
          if (!owned.size) admitted.delete(message.recipientId);
        })
        .catch(() => undefined);
      entry.messages.push(item);
      const remaining = Math.max(0, entry.firstAdmittedAt + maxWaitMs - admittedAt);
      entry.cancel = schedule(Math.min(quietMs, remaining), () => flush(message.recipientId));
      pending.set(message.recipientId, entry);
      return receipt;
    },
    async waitForDispatch(recipientId, signal) {
      signal?.throwIfAborted();
      const waitingReceipts =
        pending.get(recipientId)?.messages.map((message) => message.receipt.dispatched) ?? [];
      const settled = Promise.allSettled([dispatching.get(recipientId), ...waitingReceipts]);
      if (!signal) {
        await settled;
        return;
      }
      let aborted!: () => void;
      const cancellation = new Promise<never>((_resolve, rejectWait) => {
        aborted = () => rejectWait(new DOMException("Wait aborted", "AbortError"));
        signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([settled, cancellation]);
      } finally {
        signal.removeEventListener("abort", aborted);
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      unsubscribe?.();
      for (const recipientId of pending.keys()) flush(recipientId);
      // Each failure is reported and rejects its receipts; shutdown still drains other recipients.
      closing = Promise.allSettled(dispatching.values()).then(() => undefined);
      return closing;
    },
  };
}
