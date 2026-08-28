import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  addUsageToBucket,
  emptyUsageBucket,
  UsageDayRollupSchema,
  utcDayKey,
  type UsageDayRollup,
} from "@jagentdesk/protocol/usage-history";
import { writeJsonFileAtomic } from "../atomic-file.js";

const StoredUsageSchema = z.array(UsageDayRollupSchema);

/** Retain ~2 years of daily rollups; older days are pruned. */
const MAX_DAYS = 800;

type UsageListener = (days: UsageDayRollup[]) => void;

interface BilledUsage {
  timestampMs: number;
  model: string;
  usage: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
    totalCostUsd?: number | null;
  };
}

/**
 * Daemon-owned time-series of token usage, one rollup per UTC day. Fed from the
 * single usage-billing choke point in the agent manager, so a day/month/year
 * dashboard can be charted from real recorded history (the per-agent
 * `usageTotals` carry no time axis and cannot).
 */
export class UsageHistoryStorage {
  private readonly storePath: string;
  private readonly logger: Logger;
  private readonly byDate = new Map<string, UsageDayRollup>();
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<UsageListener>();

  constructor(jagentdeskHome: string, logger: Logger) {
    this.storePath = path.join(jagentdeskHome, "usage", "usage-history.json");
    this.logger = logger.child({ module: "usage", component: "usage-history-storage" });
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      for (const rollup of StoredUsageSchema.parse(JSON.parse(raw))) {
        this.byDate.set(rollup.date, rollup);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error(
          { err: error, storePath: this.storePath },
          "Failed to load usage history",
        );
      }
    }
    this.loaded = true;
  }

  /** All rollups, oldest → newest. */
  get(): UsageDayRollup[] {
    return Array.from(this.byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  onChange(listener: UsageListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fold one billed turn into today's rollup (and its per-model breakdown). */
  record(input: BilledUsage): void {
    const date = utcDayKey(input.timestampMs);
    let rollup = this.byDate.get(date);
    if (!rollup) {
      rollup = { date, ...emptyUsageBucket(), byModel: {} };
      this.byDate.set(date, rollup);
    }
    addUsageToBucket(rollup, input.usage);
    const modelKey = input.model || "unknown";
    const modelBucket = rollup.byModel[modelKey] ?? emptyUsageBucket();
    addUsageToBucket(modelBucket, input.usage);
    rollup.byModel[modelKey] = modelBucket;
    this.prune();
    this.schedulePersist();
    const days = this.get();
    for (const listener of this.listeners) {
      listener(days);
    }
  }

  /** Await any in-flight persist (used by tests to avoid write/cleanup races). */
  async flush(): Promise<void> {
    await this.persistQueue;
  }

  private prune(): void {
    if (this.byDate.size <= MAX_DAYS) return;
    const dates = Array.from(this.byDate.keys()).sort();
    for (const date of dates.slice(0, this.byDate.size - MAX_DAYS)) {
      this.byDate.delete(date);
    }
  }

  private schedulePersist(): void {
    // Serialize writes; never let a failed write reject the chain (it would
    // surface as an unhandled rejection when persist races store teardown).
    this.persistQueue = this.persistQueue
      .then(() => writeJsonFileAtomic(this.storePath, this.get()))
      .catch((error) => {
        this.logger.error(
          { err: error, storePath: this.storePath },
          "Failed to persist usage history",
        );
      });
  }
}
