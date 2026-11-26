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
  /**
   * Set once the child ended a turn while it was still working and the caller was told so.
   * The subscription then follows the child until it settles or the follow limit passes.
   */
  followingSince: z.iso.datetime().optional(),
});
export type FinishSubscriptionRecord = z.infer<typeof FinishSubscriptionRecordSchema>;

const FinishSubscriptionFileSchema = z.object({
  version: z.literal(1),
  subscriptions: z.array(FinishSubscriptionRecordSchema),
});

export const FINISH_SUBSCRIPTIONS_FILE = "finish-subscriptions.json";

/**
 * Work that will start the child's next turn without a new prompt from the caller.
 * Recurring triggers such as heartbeats are not pending work: they never settle.
 */
export type PendingWork = "turn" | "background work" | "queued messages" | "delegated agents";

/** How long a child that is still working is followed before the subscription gives up. */
export const DEFAULT_FOLLOW_LIMIT_MS = 24 * 60 * 60_000;

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

  /** The children this caller still waits on, as last saved. */
  delegatesOf(agentId: string): string[] {
    return (this.cache ?? [])
      .filter((record) => record.callerAgentId === agentId)
      .map((record) => record.childAgentId);
  }

  /** Written before the still-working notice is sent, so a restart never repeats it. */
  markFollowing(ids: readonly string[], followingSince: string): Promise<void> {
    return this.mutate((records) =>
      records.map((record) => (ids.includes(record.id) ? { ...record, followingSince } : record)),
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
  followLimitMs: number;
  /** Rechecks of followed children, by child agent ID. */
  followers: Map<string, Set<() => void>>;
  /** Whether an agent waits on a child on another host; only that host knows its work. */
  awaitsRemoteDelegates?: (agentId: string) => boolean;
}

// Keyed by the daemon's AgentManager, like the delivery queue.
const states = new WeakMap<object, FinishSubscriptionState>();

export function configureFinishSubscriptions(
  agentManager: object,
  store: FinishSubscriptionStore,
): void {
  states.set(agentManager, {
    store,
    suspended: false,
    controller: new AbortController(),
    followLimitMs: DEFAULT_FOLLOW_LIMIT_MS,
    followers: new Map(),
  });
}

/** Test-only: follow a still-working child for a shorter time. */
export function setFinishFollowLimitForTests(agentManager: object, followLimitMs: number): void {
  const state = states.get(agentManager);
  if (state) state.followLimitMs = followLimitMs;
}

export function getFinishFollowLimitMs(agentManager: object): number {
  return states.get(agentManager)?.followLimitMs ?? DEFAULT_FOLLOW_LIMIT_MS;
}

export function setRemoteDelegationProbe(
  agentManager: object,
  probe: (agentId: string) => boolean,
): void {
  const state = states.get(agentManager);
  if (state) state.awaitsRemoteDelegates = probe;
}

export function awaitsRemoteDelegates(agentManager: object, agentId: string): boolean {
  return states.get(agentManager)?.awaitsRemoteDelegates?.(agentId) ?? false;
}

/** Registers a followed child's recheck; returns its removal. */
export function registerFinishFollower(
  agentManager: object,
  childAgentId: string,
  recheck: () => void,
): () => void {
  const followers = states.get(agentManager)?.followers;
  if (!followers) return () => undefined;
  const set = followers.get(childAgentId) ?? new Set();
  set.add(recheck);
  followers.set(childAgentId, set);
  return () => {
    set.delete(recheck);
    if (!set.size && followers.get(childAgentId) === set) followers.delete(childAgentId);
  };
}

/**
 * A subscription of `callerAgentId` ended, so the caller may have nothing left to wait on.
 * Its own followed subscriptions decide its state again.
 */
export function recheckFinishFollowers(agentManager: object, callerAgentId: string): void {
  for (const recheck of states.get(agentManager)?.followers.get(callerAgentId) ?? []) recheck();
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
    const followingSince = records
      .map((entry) => entry.followingSince)
      .filter((value) => value !== undefined)
      .sort()[0];
    const record = {
      ...records[0]!,
      requireParentOwnership: records.every((entry) => entry.requireParentOwnership),
      ...(followingSince ? { followingSince } : {}),
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
