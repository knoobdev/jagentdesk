import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { writeJsonFileAtomic } from "../../atomic-file.js";

/** Durable local finish intent survives until the parent accepts dispatch (Paseo #7683). */

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

  hasPendingForCaller(agentId: string): boolean {
    return this.cache?.some((record) => record.callerAgentId === agentId) ?? false;
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
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await writeJsonFileAtomic(this.filePath, { version: 1, subscriptions: records });
      this.cache = records;
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

interface FinishSubscriptionState {
  store: FinishSubscriptionStore;
  suspended: boolean;
  controller: AbortController;
}

// Keyed by the daemon's AgentManager, like the delivery queue.
const states = new WeakMap<object, FinishSubscriptionState>();

export function configureFinishSubscriptions(
  agentManager: object,
  store: FinishSubscriptionStore,
): void {
  states.set(agentManager, { store, suspended: false, controller: new AbortController() });
}

export function suspendFinishNotifications(agentManager: object): void {
  const state = states.get(agentManager);
  if (state) {
    state.suspended = true;
    state.controller.abort();
  }
}

export function areFinishNotificationsSuspended(agentManager: object): boolean {
  return states.get(agentManager)?.suspended === true;
}

export function getFinishSubscriptionSignal(agentManager: object): AbortSignal | undefined {
  return states.get(agentManager)?.controller.signal;
}

export function getFinishSubscriptionStore(agentManager: object): FinishSubscriptionStore | null {
  return states.get(agentManager)?.store ?? null;
}

export interface RestoreFinishSubscriptionsParams {
  agentManager: object;
  store: FinishSubscriptionStore;
  reconcile(
    record: FinishSubscriptionRecord,
    signal: AbortSignal,
    subscriptionIds: readonly string[],
  ): Promise<void>;
  isArchived(agentId: string): Promise<boolean>;
  logger: Logger;
}

/** Reconcile saved local children and deliver their outcomes just like live observations. */
export async function restoreFinishSubscriptions(
  params: RestoreFinishSubscriptionsParams,
): Promise<number> {
  configureFinishSubscriptions(params.agentManager, params.store);
  const state = states.get(params.agentManager)!;
  let restored = 0;
  const groups = new Map<string, FinishSubscriptionRecord[]>();
  for (const record of await params.store.list()) {
    if (await params.isArchived(record.callerAgentId)) {
      await params.store.remove(record.id);
      continue;
    }
    const key = JSON.stringify([record.callerAgentId, record.childAgentId]);
    const records = groups.get(key) ?? [];
    records.push(record);
    groups.set(key, records);
  }
  for (const records of groups.values()) {
    const record = {
      ...records[0]!,
      requireParentOwnership: records.every((entry) => entry.requireParentOwnership),
    };
    void params
      .reconcile(
        record,
        state.controller.signal,
        records.map((entry) => entry.id),
      )
      .catch((error: unknown) => {
        if (!state.controller.signal.aborted)
          params.logger.error(
            { err: error, subscriptionId: record.id },
            "Failed to restore finish subscription",
          );
      });
    restored += records.length;
  }
  if (restored) params.logger.info({ restored }, "Restored local finish subscriptions");
  return restored;
}

export function hasOutstandingFinishSubscriptions(agentManager: object, agentId: string): boolean {
  return states.get(agentManager)?.store.hasPendingForCaller(agentId) ?? false;
}
