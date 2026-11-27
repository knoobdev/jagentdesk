import { i18n } from "@/i18n/i18next";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { botsKey, useBotsConnection } from "../queries";

/** Whether the host speaks `bots.share.*` (`server_info.features.botsSharing`). */
export function useBotSharingSupported(serverId: string): boolean {
  return useHostFeature(serverId, "botsSharing");
}

/** The bot's link (with its key), whether it changed since, and where a copy came from. */
export function useBotShareStatus(serverId: string, botId: string) {
  const { client, enabled } = useBotsConnection(serverId);
  const sharing = useBotSharingSupported(serverId);
  return useFetchQuery({
    queryKey: [...botsKey(serverId), "share", botId],
    enabled: enabled && sharing,
    dataShape: "value",
    staleTimeMs: 5000,
    queryFn: async () => {
      if (!client) throw new Error(i18n.t("bots.jad.offline"));
      return (await client.botsRequest("bots.share.status.request", { botId })).status;
    },
  });
}
