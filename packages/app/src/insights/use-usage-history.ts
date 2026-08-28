import { useTranslation } from "react-i18next";
import type { UsageDayRollup } from "@jagentdesk/protocol/usage-history";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export const usageHistoryQueryKey = (serverId: string | null) => ["usage-history", serverId];

/**
 * The daemon-recorded usage time-series (one rollup per UTC day). Hydrates from
 * `usage.history.get` and stays live via the `status:usage_changed` broadcast
 * (routed into this query's cache by push-router). This is real recorded history
 * — the per-agent running totals have no time axis — so it can drive a
 * day/month/year chart.
 */
export function useUsageHistory(serverId: string): UsageDayRollup[] {
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
      return (await client.getUsageHistory()).days;
    },
  });
  return query.data ?? [];
}
