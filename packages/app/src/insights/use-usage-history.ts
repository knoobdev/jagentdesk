import { useTranslation } from "react-i18next";
import type { LifetimeUsage, UsageDayRollup } from "@jagentdesk/protocol/usage-history";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export const usageHistoryQueryKey = (serverId: string | null) => ["usage-history", serverId];

export interface UsageHistory {
  days: UsageDayRollup[];
  /** Persistent lifetime total (baseline + all days); survives agent deletion. */
  lifetime: LifetimeUsage;
}

const EMPTY_LIFETIME: LifetimeUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalCostUsd: 0,
  turns: 0,
  byModel: {},
};

/**
 * The daemon-recorded usage time-series (one rollup per UTC day) plus the
 * persistent lifetime total. Hydrates from `usage.history.get` and stays live via
 * the `status:usage_changed` broadcast (routed into this query's cache by
 * push-router). The lifetime total is computed daemon-side from a one-time
 * baseline + every day rollup — never summed over live agents — so the headline
 * Usage & Cost figures don't drop when an agent is deleted.
 */
export function useUsageHistory(serverId: string): UsageHistory {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const query = useReplicaQuery({
    queryKey: usageHistoryQueryKey(serverId),
    enabled: Boolean(serverId && client && isConnected),
    pushEvent: "status:usage_changed",
    queryFn: async () => {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const { days, lifetime } = await client.getUsageHistory();
      return { days, lifetime } satisfies UsageHistory;
    },
  });
  return query.data ?? { days: [], lifetime: EMPTY_LIFETIME };
}
