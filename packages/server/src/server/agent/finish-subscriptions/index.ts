import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import type { AgentPromptSource } from "../agent-messages/index.js";

/**
 * Durable finish subscriptions (ADR-0029 decisions 4 and 5).
 *
 * A caller that asked to be told when a child finishes keeps that request in
 * `$JAGENTDESK_HOME/finish-subscriptions.json` until the notification has been
 * dispatched. After a daemon restart the parent is NOT woken: each subscription
 * that was still open becomes a pending notification that rides along with the
 * parent's next turn (a user message or another agent message).
 */

const FinishSubscriptionRecordSchema = z.object({
  id: z.string().min(1),
  childAgentId: z.string().min(1),
  callerAgentId: z.string().min(1),
  requireParentOwnership: z.boolean(),
  createdAt_ms: z.number().int(),
});
export type FinishSubscriptionRecord = z.infer<typeof FinishSubscriptionRecordSchema>;

const FinishSubscriptionFileSchema = z.object({
  version: z.literal(1),
  subscriptions: z.array(FinishSubscriptionRecordSchema),
});

export const FINISH_SUBSCRIPTIONS_FILE = "finish-subscriptions.json";

export class FinishSubscriptionStore {
  private writes: Promise<void> = Promise.resolve();
  private cache: FinishSubscriptionRecord[] | null = null;

  constructor(
    private readonly filePath: string,
    private readonly logger: Logger,
  ) {}

  static forHome(jagentdeskHome: string, logger: Logger): FinishSubscriptionStore {
    return new FinishSubscriptionStore(
      path.join(jagentdeskHome, FINISH_SUBSCRIPTIONS_FILE),
      logger,
    );
  }

  async list(): Promise<FinishSubscriptionRecord[]> {
    await this.writes;
    return [...(await this.load())];
  }

  add(input: Omit<FinishSubscriptionRecord, "id" | "createdAt_ms">): Promise<string> {
    const id = randomUUID();
    return this.mutate((records) => [...records, { ...input, id, createdAt_ms: Date.now() }]).then(
      () => id,
    );
  }

  remove(id: string): Promise<void> {
    return this.mutate((records) => records.filter((record) => record.id !== id));
  }

  private mutate(
    update: (records: FinishSubscriptionRecord[]) => FinishSubscriptionRecord[],
  ): Promise<void> {
    const next = this.writes.then(async () => {
      const records = update(await this.load());
      this.cache = records;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await writeJsonFileAtomic(this.filePath, { version: 1, subscriptions: records });
      return undefined;
    });
    this.writes = next.catch((error) => {
      this.logger.error(
        { err: error, filePath: this.filePath },
        "Failed to save finish subscriptions",
      );
    });
    return next;
  }

  private async load(): Promise<FinishSubscriptionRecord[]> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, "utf8")) as unknown;
      const parsed = FinishSubscriptionFileSchema.safeParse(raw);
      this.cache = parsed.success ? parsed.data.subscriptions : [];
      if (!parsed.success) {
        this.logger.warn({ filePath: this.filePath }, "Ignoring unreadable finish subscriptions");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn(
          { err: error, filePath: this.filePath },
          "Failed to read finish subscriptions",
        );
      }
      this.cache = [];
    }
    return this.cache;
  }
}

/** A notification waiting for the parent's next turn. */
export interface PendingFinishNotification {
  subscriptionId: string;
  source: AgentPromptSource;
  body: string;
}

interface FinishSubscriptionState {
  store: FinishSubscriptionStore;
  pending: Map<string, PendingFinishNotification[]>;
}

// Keyed by the daemon's AgentManager, like the delivery queue.
const states = new WeakMap<object, FinishSubscriptionState>();

export function configureFinishSubscriptions(
  agentManager: object,
  store: FinishSubscriptionStore,
): void {
  states.set(agentManager, { store, pending: new Map() });
}

export function getFinishSubscriptionStore(agentManager: object): FinishSubscriptionStore | null {
  return states.get(agentManager)?.store ?? null;
}

/** Take the notifications that ride along with this parent's next turn. */
export function takePendingFinishNotifications(
  agentManager: object,
  parentAgentId: string,
): PendingFinishNotification[] {
  const state = states.get(agentManager);
  const pending = state?.pending.get(parentAgentId);
  if (!state || !pending?.length) return [];
  state.pending.delete(parentAgentId);
  return pending;
}

/** The turn they rode on was not dispatched; keep them for the next one. */
export function returnPendingFinishNotifications(
  agentManager: object,
  parentAgentId: string,
  notifications: PendingFinishNotification[],
): void {
  const state = states.get(agentManager);
  if (!state || notifications.length === 0) return;
  state.pending.set(parentAgentId, [...notifications, ...(state.pending.get(parentAgentId) ?? [])]);
}

/** Dispatched with the parent's turn: the subscription is done. */
export async function completePendingFinishNotifications(
  agentManager: object,
  notifications: PendingFinishNotification[],
): Promise<void> {
  const store = getFinishSubscriptionStore(agentManager);
  if (!store) return;
  await Promise.all(notifications.map((entry) => store.remove(entry.subscriptionId)));
}

export interface RestoreFinishSubscriptionsParams {
  agentManager: object;
  store: FinishSubscriptionStore;
  getAgentTitle(agentId: string): Promise<string | null>;
  isArchived(agentId: string): Promise<boolean>;
  logger: Logger;
}

/**
 * Daemon start: every subscription still open was cut by the restart. Keep it as
 * a pending notification for the parent's next turn — never start a turn here.
 */
export async function restoreFinishSubscriptions(
  params: RestoreFinishSubscriptionsParams,
): Promise<number> {
  configureFinishSubscriptions(params.agentManager, params.store);
  const state = states.get(params.agentManager)!;
  let restored = 0;
  for (const record of await params.store.list()) {
    if (await params.isArchived(record.callerAgentId)) {
      await params.store.remove(record.id);
      continue;
    }
    const title = (await params.getAgentTitle(record.childAgentId)) ?? record.childAgentId;
    const entry: PendingFinishNotification = {
      subscriptionId: record.id,
      source: {
        kind: "agent-notification",
        agentId: record.childAgentId,
        title,
        event: "closed",
      },
      body: `Agent ${record.childAgentId} (${title}) was closed: the daemon restarted before it reported back. Use get_agent_activity to read its latest output.`,
    };
    state.pending.set(record.callerAgentId, [
      ...(state.pending.get(record.callerAgentId) ?? []),
      entry,
    ]);
    restored += 1;
  }
  if (restored > 0) {
    params.logger.info({ restored }, "Restored finish notifications for the parents' next turns");
  }
  return restored;
}
