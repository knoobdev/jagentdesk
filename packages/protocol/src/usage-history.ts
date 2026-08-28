import { z } from "zod";

/**
 * Time-stamped usage history, owned by the daemon. The per-agent `usageTotals`
 * are a single running total with no time axis, so a day/month/year dashboard
 * cannot be built from them. This records one compact rollup per UTC day (with a
 * per-model breakdown) from the moment it ships forward — enough to chart usage
 * over time without keeping an unbounded per-turn event log.
 */
export const UsageBucketSchema = z.object({
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  totalCostUsd: z.number(),
  turns: z.number(),
});
export type UsageBucket = z.infer<typeof UsageBucketSchema>;

export const UsageDayRollupSchema = UsageBucketSchema.extend({
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: z.string(),
  /** Per-model breakdown for the day, keyed by model id (or provider fallback). */
  byModel: z.record(z.string(), UsageBucketSchema),
});
export type UsageDayRollup = z.infer<typeof UsageDayRollupSchema>;

export function emptyUsageBucket(): UsageBucket {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalCostUsd: 0, turns: 0 };
}

/** Add one turn's usage into a bucket (mutates and returns it). */
export function addUsageToBucket(
  bucket: UsageBucket,
  usage: {
    inputTokens?: number | null;
    cachedInputTokens?: number | null;
    outputTokens?: number | null;
    totalCostUsd?: number | null;
  },
): UsageBucket {
  bucket.inputTokens += usage.inputTokens ?? 0;
  bucket.cachedInputTokens += usage.cachedInputTokens ?? 0;
  bucket.outputTokens += usage.outputTokens ?? 0;
  bucket.totalCostUsd += usage.totalCostUsd ?? 0;
  bucket.turns += 1;
  return bucket;
}

/** The UTC `YYYY-MM-DD` for a Unix-ms timestamp. */
export function utcDayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

// ── RPC: usage.history.get ───────────────────────────────────────────────────
export const UsageHistoryGetRequestSchema = z.object({
  type: z.literal("usage.history.get.request"),
  requestId: z.string(),
});
export const UsageHistoryGetResponseSchema = z.object({
  type: z.literal("usage.history.get.response"),
  payload: z.object({ requestId: z.string(), days: z.array(UsageDayRollupSchema) }),
});
export type UsageHistoryGetRequest = z.infer<typeof UsageHistoryGetRequestSchema>;

// ── pushEvent: status:usage_changed ──────────────────────────────────────────
export const UsageChangedStatusPayloadSchema = z.object({
  status: z.literal("usage_changed"),
  days: z.array(UsageDayRollupSchema),
});
