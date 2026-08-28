import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  addUsageToBucket,
  emptyUsageBucket,
  LifetimeUsageSchema,
  UsageDayRollupSchema,
  utcDayKey,
  type LifetimeUsage,
  type UsageBucket,
  type UsageDayRollup,
} from "@jagentdesk/protocol/usage-history";
import { writeJsonFileAtomic } from "../atomic-file.js";

// v1 was a bare array of day rollups; v2 wraps it with a one-time lifetime
// baseline so headline totals survive agent deletion. Accept both on load.
const StoredUsageSchema = z.union([
  z.array(UsageDayRollupSchema),
  z.object({
    days: z.array(UsageDayRollupSchema),
    baseline: LifetimeUsageSchema.nullable(),
  }),
]);

/** Retain ~2 years of daily rollups; older days are pruned. */
const MAX_DAYS = 800;

type UsageListener = (days: UsageDayRollup[], lifetime: LifetimeUsage) => void;

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

function emptyLifetime(): LifetimeUsage {
  return { ...emptyUsageBucket(), byModel: {} };
}

/**
 * Build the one-time lifetime baseline from the sum of existing agents' usage
 * totals (with per-model breakdown), so usage that predates the time-series is
 * preserved in the headline totals.
 */
export function buildLifetimeBaseline(
  agents: Array<{ usageTotals?: UsageBucket | null; model: string }>,
): LifetimeUsage {
  const baseline = emptyLifetime();
  for (const agent of agents) {
    if (!agent.usageTotals) continue;
    addBucketInto(baseline, agent.usageTotals);
    const modelBucket = baseline.byModel[agent.model] ?? emptyUsageBucket();
    addBucketInto(modelBucket, agent.usageTotals);
    baseline.byModel[agent.model] = modelBucket;
  }
  return baseline;
}

function addBucketInto(target: UsageBucket, source: UsageBucket): void {
  target.inputTokens += source.inputTokens;
  target.cachedInputTokens += source.cachedInputTokens;
  target.outputTokens += source.outputTokens;
  target.totalCostUsd += source.totalCostUsd;
  target.turns += source.turns;
}

function addModelBreakdownInto(
  target: Record<string, UsageBucket>,
  source: Record<string, UsageBucket>,
): void {
  for (const [model, bucket] of Object.entries(source)) {
    const existing = target[model] ?? emptyUsageBucket();
    addBucketInto(existing, bucket);
    target[model] = existing;
  }
}

/**
 * Daemon-owned time-series of token usage, one rollup per UTC day. Fed from the
 * single usage-billing choke point in the agent manager, so a day/month/year
 * dashboard can be charted from real recorded history (the per-agent
 * `usageTotals` carry no time axis and cannot).
 *
 * It also exposes a persistent LIFETIME total = a one-time `baseline` (a snapshot
 * of every agent's usage the first time this shipped, so pre-history usage isn't
 * lost) plus every day rollup since. The headline Usage & Cost figures read this
 * lifetime instead of summing live agents, so deleting an agent never lowers them.
 */
export class UsageHistoryStorage {
  private readonly storePath: string;
  private readonly logger: Logger;
  private readonly byDate = new Map<string, UsageDayRollup>();
  private baseline: LifetimeUsage | null = null;
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
      const parsed = StoredUsageSchema.parse(JSON.parse(raw));
      const days = Array.isArray(parsed) ? parsed : parsed.days;
      for (const rollup of days) {
        this.byDate.set(rollup.date, rollup);
      }
      this.baseline = Array.isArray(parsed) ? null : parsed.baseline;
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

  /**
   * One-time seed of the lifetime baseline from the sum of existing agents'
   * usage, so usage that predates this time-series isn't lost. No-op once a
   * baseline has been set (persisted), so it never double-counts on restart.
   */
  seedBaselineIfEmpty(baseline: LifetimeUsage): void {
    if (this.baseline !== null) return;
    this.baseline = baseline;
    this.schedulePersist();
  }

  /** All rollups, oldest → newest. */
  get(): UsageDayRollup[] {
    return Array.from(this.byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Persistent lifetime total = baseline + every recorded day. Survives delete. */
  lifetime(): LifetimeUsage {
    const total = this.baseline ? structuredCloneLifetime(this.baseline) : emptyLifetime();
    for (const day of this.byDate.values()) {
      addBucketInto(total, day);
      addModelBreakdownInto(total.byModel, day.byModel);
    }
    return total;
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
    this.notify();
  }

  /** Await any in-flight persist (used by tests to avoid write/cleanup races). */
  async flush(): Promise<void> {
    await this.persistQueue;
  }

  private notify(): void {
    const days = this.get();
    const lifetime = this.lifetime();
    for (const listener of this.listeners) {
      listener(days, lifetime);
    }
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
      .then(() =>
        writeJsonFileAtomic(this.storePath, { days: this.get(), baseline: this.baseline }),
      )
      .catch((error) => {
        this.logger.error(
          { err: error, storePath: this.storePath },
          "Failed to persist usage history",
        );
      });
  }
}

function structuredCloneLifetime(value: LifetimeUsage): LifetimeUsage {
  const byModel: Record<string, UsageBucket> = {};
  for (const [model, bucket] of Object.entries(value.byModel)) {
    byModel[model] = { ...bucket };
  }
  return {
    inputTokens: value.inputTokens,
    cachedInputTokens: value.cachedInputTokens,
    outputTokens: value.outputTokens,
    totalCostUsd: value.totalCostUsd,
    turns: value.turns,
    byModel,
  };
}
