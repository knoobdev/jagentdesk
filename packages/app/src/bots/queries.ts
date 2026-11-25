import { i18n } from "@/i18n/i18next";
import { applyAgentDirectoryDelta } from "@/utils/agent-directory-sync";
import { useEffect } from "react";
import { useQueryClient, useMutation } from "@tanstack/react-query";
import type { BotsRequestType, BotsRequestParams } from "@jagentdesk/protocol/bots/rpc-schemas";
import type { BotMessage } from "@jagentdesk/protocol/bots/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { mergeMessages } from "./model";

export const botsKey = (serverId: string) => ["bots", serverId] as const;
export function useBotsConnection(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "bots");
  return { client, connected, supported, enabled: Boolean(client && connected && supported) };
}
export function useBots(serverId: string) {
  const { client, enabled } = useBotsConnection(serverId);
  return useFetchQuery({
    queryKey: [...botsKey(serverId), "list"],
    enabled,
    dataShape: "value",
    staleTimeMs: 1000,
    queryFn: async () => {
      if (!client) throw new Error(i18n.t("bots.offline"));
      return (await client.botsRequest("bots.list.request", {})).bots;
    },
  });
}
export function useRooms(serverId: string) {
  const { client, enabled } = useBotsConnection(serverId);
  return useFetchQuery({
    queryKey: [...botsKey(serverId), "rooms"],
    enabled,
    dataShape: "value",
    staleTimeMs: 1000,
    queryFn: async () => {
      if (!client) throw new Error(i18n.t("bots.offline"));
      return (await client.botsRequest("bots.rooms.list.request", {})).rooms;
    },
  });
}
export function useItems(serverId: string, botId: string) {
  const { client, enabled } = useBotsConnection(serverId);
  return useFetchQuery({
    queryKey: [...botsKey(serverId), "items", botId],
    enabled,
    dataShape: "value",
    staleTimeMs: 1000,
    queryFn: async () => {
      if (!client) throw new Error(i18n.t("bots.offline"));
      return (await client.botsRequest("bots.items.list.request", { botId, includeClosed: true }))
        .items;
    },
  });
}
export function useBotHistory(serverId: string, botId: string) {
  const { client, enabled } = useBotsConnection(serverId);
  return useFetchQuery({
    queryKey: [...botsKey(serverId), "chat", botId],
    enabled,
    dataShape: "value",
    staleTimeMs: 1000,
    queryFn: async () => {
      if (!client) throw new Error(i18n.t("bots.offline"));
      return (await client.botsRequest("bots.chat.history.request", { botId, limit: 200 }))
        .messages;
    },
  });
}
export function useBotSchedules(serverId: string, botId: string) {
  const { client, enabled } = useBotsConnection(serverId);
  return useFetchQuery({
    queryKey: [...botsKey(serverId), "schedules", botId],
    enabled,
    dataShape: "value",
    staleTimeMs: 1000,
    queryFn: async () => {
      if (!client) throw new Error(i18n.t("bots.offline"));
      return (await client.botsRequest("bots.schedules.list.request", { botId })).schedules;
    },
  });
}
export function useBotsMutation<T extends BotsRequestType>(serverId: string, type: T) {
  const { client, enabled } = useBotsConnection(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: BotsRequestParams<T>) => {
      if (!client || !enabled) throw new Error(i18n.t("bots.offline"));
      return client.botsRequest(type, params);
    },
    onSuccess: async () => {
      const domains = ["list"];
      if (type.startsWith("bots.slack.")) domains.push("slack");
      if (type.startsWith("bots.rooms.")) domains.push("rooms");
      if (type.startsWith("bots.chat.")) domains.push("chat", "items");
      if (type.startsWith("bots.items.")) domains.push("items");
      if (type.startsWith("bots.schedules.")) domains.push("schedules");
      await Promise.all(
        domains.map((domain) =>
          queryClient.invalidateQueries({ queryKey: [...botsKey(serverId), domain] }),
        ),
      );
    },
  });
}
export function useBotsPushes(serverId: string) {
  const { client, enabled } = useBotsConnection(serverId);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client || !enabled) return;
    const invalidateBots = () => {
      void queryClient.invalidateQueries({ queryKey: [...botsKey(serverId), "list"] });
    };
    const invalidateRooms = () => {
      void queryClient.invalidateQueries({ queryKey: [...botsKey(serverId), "rooms"] });
    };
    const unsubscribes = [
      client.onBotsPush("bots.changed", invalidateBots),
      client.onBotsPush("bots.room.changed", invalidateRooms),
      client.onBotsPush("bots.item.changed", ({ payload }) => {
        void queryClient.invalidateQueries({
          queryKey: [...botsKey(serverId), "items", payload.item.botId],
        });
      }),
      client.onBotsPush("bots.chat.message", ({ payload }) => {
        const message = payload.message;
        if (message.roomId) {
          void queryClient.invalidateQueries({ queryKey: [...botsKey(serverId), "rooms"] });
          return;
        }
        queryClient.setQueryData<BotMessage[]>(
          [...botsKey(serverId), "chat", message.botId],
          (previous) => (previous ? mergeMessages(previous, [message]) : undefined),
        );
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [client, enabled, queryClient, serverId]);
}
export function useBotAgent(serverId: string, agentId: string | undefined) {
  const { client, enabled } = useBotsConnection(serverId);
  return useFetchQuery({
    queryKey: [...botsKey(serverId), "agent", agentId],
    enabled: enabled && Boolean(agentId),
    dataShape: "value",
    staleTimeMs: 1000,
    queryFn: async () => {
      if (!client || !agentId) throw new Error(i18n.t("bots.offline"));
      const result = await client.fetchAgent(agentId);
      if (!result) throw new Error(i18n.t("bots.agentUnavailable"));
      applyAgentDirectoryDelta({
        serverId,
        delta: { kind: "upsert", agent: result.agent, project: result.project },
      });
      return result;
    },
  });
}
