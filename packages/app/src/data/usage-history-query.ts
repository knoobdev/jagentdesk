import type { LifetimeUsage, UsageDayRollup } from "@jagentdesk/protocol/usage-history";

// The push router writes status:usage_changed into this query; Insights reads it.
export const usageHistoryQueryKey = (serverId: string | null) => ["usage-history", serverId];

export interface UsageHistory {
  days: UsageDayRollup[];
  /** Persistent lifetime total (baseline + all days); survives agent deletion. */
  lifetime: LifetimeUsage;
}
