// Bots data for the Orca-layout screens (spec 37.4, contract `bots-contract.md`). Every read is one
// `bots.*.request` keyed as ["bots", serverId, <request type>, <params>]; pushes and mutations
// invalidate by request type and bot, so a screen only names the read it shows.
import { i18n } from "@/i18n/i18next";
import { applyAgentDirectoryDelta } from "@/utils/agent-directory-sync";
import { useEffect } from "react";
import { useQueryClient, useMutation, type QueryClient } from "@tanstack/react-query";
import type {
  BotsRequestType,
  BotsRequestParams,
  BotsResponseFor,
} from "@jagentdesk/protocol/bots/rpc-schemas";
import type { Bot, BotItem, BotMessage } from "@jagentdesk/protocol/bots/types";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { mergeMessages } from "./model";
import { useBotHomeFileStore } from "./home-file-store";

export const botsKey = (serverId: string) => ["bots", serverId] as const;
type Payload<T extends BotsRequestType> = BotsResponseFor<T>["payload"];

export function useBotsConnection(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "bots");
  // The Orca-layout RPCs (ADR-0060); a round-1 host gets "update the host", no fallback.
  const orca = useHostFeature(serverId, "botsOrca");
  return {
    client,
    connected,
    supported,
    orca,
    enabled: Boolean(client && connected && supported && orca),
  };
}

export function botsReadKey<T extends BotsRequestType>(
  serverId: string,
  type: T,
  params: BotsRequestParams<T>,
) {
  return [...botsKey(serverId), type, params] as const;
}

/** One `bots.*` read. `select` keeps components on the field they show. */
export function useBotsRead<T extends BotsRequestType, R = Payload<T>>(
  serverId: string,
  type: T,
  params: BotsRequestParams<T>,
  options: {
    enabled?: boolean;
    select?: (payload: Payload<T>) => R;
    refetchIntervalMs?: number;
  } = {},
) {
  const { client, enabled } = useBotsConnection(serverId);
  return useFetchQuery({
    queryKey: botsReadKey(serverId, type, params),
    enabled: enabled && options.enabled !== false,
    dataShape: "value",
    staleTimeMs: 1000,
    refetchInterval: options.refetchIntervalMs ?? false,
    select: options.select,
    queryFn: async (): Promise<Payload<T>> => {
      if (!client) throw new Error(i18n.t("bots.jad.offline"));
      // The client resolves T's payload; TS cannot narrow the generic response union itself.
      return (await client.botsRequest(type, params)) as unknown as Payload<T>;
    },
  });
}

function paramsOf(key: readonly unknown[]): Record<string, unknown> | null {
  const params = key[3];
  return params && typeof params === "object" ? (params as Record<string, unknown>) : null;
}

/** Refetches the reads of `types` (all bots when `botId` is null). */
export function invalidateBotsReads(
  queryClient: QueryClient,
  serverId: string,
  types: readonly BotsRequestType[],
  botId: string | null,
) {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (key[0] !== "bots" || key[1] !== serverId) return false;
      if (!types.includes(key[2] as BotsRequestType)) return false;
      const params = paramsOf(key);
      return botId === null || !params?.botId || params.botId === botId;
    },
  });
}

/** Every read about one bot, plus the bot list: what a write to that bot can change. */
function invalidateBot(queryClient: QueryClient, serverId: string, botId: string | null) {
  return queryClient.invalidateQueries({
    predicate: (query) => {
      const key = query.queryKey;
      if (key[0] !== "bots" || key[1] !== serverId) return false;
      if (key[2] === "bots.list.request" || key[2] === "bots.rooms.list.request") return true;
      if (key[2] === "bots.chat.history.request") return false;
      const params = paramsOf(key);
      return botId === null || params?.botId === botId;
    },
  });
}

export function useBots(serverId: string) {
  return useBotsRead(serverId, "bots.list.request", {}, { select: (payload) => payload.bots });
}
export function useBot(serverId: string, botId: string | null | undefined): Bot | null {
  const bots = useBots(serverId);
  return bots.data?.find((bot) => bot.id === botId) ?? null;
}
export function useRooms(serverId: string) {
  return useBotsRead(
    serverId,
    "bots.rooms.list.request",
    {},
    { select: (payload) => payload.rooms },
  );
}
export function useItems(serverId: string, botId: string) {
  return useBotsRead(
    serverId,
    "bots.items.list.request",
    { botId, includeClosed: true },
    { select: (payload) => payload.items },
  );
}
export function useBotHistory(serverId: string, botId: string, enabled = true) {
  return useBotsRead(
    serverId,
    "bots.chat.history.request",
    { botId, limit: 200 },
    { select: (payload) => payload.messages, enabled },
  );
}
export function useNeedsYou(serverId: string, botId: string) {
  return useBotsRead(
    serverId,
    "bots.needs_you.list.request",
    { botId },
    { select: (payload) => payload.rows },
  );
}
export function useChatTree(serverId: string, botId: string, query?: string) {
  return useBotsRead(serverId, "bots.chats.tree.request", query ? { botId, query } : { botId });
}

/** Slack status of one bot; the setup dialog polls it while the owner connects. */
export function useBotSlackStatus(serverId: string, botId: string, poll = false) {
  return useBotsRead(
    serverId,
    "bots.slack.status.request",
    { botId },
    { select: (payload) => payload.status, refetchIntervalMs: poll ? 2000 : undefined },
  );
}

/**
 * A `bots.*` write. On success it refetches what the write can change: every read about the bot
 * (`params.botId`), or every bot read when it names none.
 */
export function useBotsMutation<T extends BotsRequestType>(serverId: string, type: T) {
  const { client, enabled } = useBotsConnection(serverId);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: BotsRequestParams<T>): Promise<Payload<T>> => {
      if (!client || !enabled) throw new Error(i18n.t("bots.jad.offline"));
      // The client resolves T's payload; TS cannot narrow the generic response union itself.
      return (await client.botsRequest(type, params)) as unknown as Payload<T>;
    },
    onSuccess: async (_result, params) => {
      const botId = (params as { botId?: unknown }).botId;
      await invalidateBot(queryClient, serverId, typeof botId === "string" ? botId : null);
    },
  });
}

const ACTIVITY_READS = {
  needs_you: ["bots.needs_you.list.request"],
  chats: ["bots.chats.tree.request"],
  automations: ["bots.automations.list.request"],
  memory: ["bots.memory.read.request", "bots.memory.history.request"],
  tidy_up: ["bots.tidy_up.status.request"],
} as const satisfies Record<string, readonly BotsRequestType[]>;

function upsertItem(previous: BotItem[] | undefined, item: BotItem): BotItem[] | undefined {
  if (!previous) return previous;
  const index = previous.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...previous, item];
  const next = [...previous];
  next[index] = item;
  return next;
}

/** Keeps the open bot screens current from the daemon's pushes (contract §Pushes). */
export function useBotsPushes(serverId: string) {
  const { client, enabled } = useBotsConnection(serverId);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!client || !enabled) return;
    const refetch = (types: readonly BotsRequestType[], botId: string | null) => {
      void invalidateBotsReads(queryClient, serverId, types, botId);
    };
    const unsubscribes = [
      client.onBotsPush("bots.changed", ({ payload }) => {
        refetch(["bots.list.request"], null);
        // A connector that links a person (Telegram's code) pushes this too: the open dialog
        // and Who can ask refetch so "Linked · {{name}}" shows without reopening.
        if (!payload.deleted)
          refetch(
            [
              "bots.chats.tree.request",
              "bots.telegram.status.request",
              "bots.allowed.list.request",
            ],
            payload.botId,
          );
      }),
      client.onBotsPush("bots.room.changed", () => refetch(["bots.rooms.list.request"], null)),
      client.onBotsPush("bots.item.changed", ({ payload }) => {
        const item = payload.item;
        queryClient.setQueriesData<{ items: BotItem[] }>(
          {
            predicate: (query) =>
              query.queryKey[1] === serverId &&
              query.queryKey[2] === "bots.items.list.request" &&
              paramsOf(query.queryKey)?.botId === item.botId,
          },
          (previous) =>
            previous ? { ...previous, items: upsertItem(previous.items, item) ?? [] } : previous,
        );
        refetch(
          ["bots.items.show.request", "bots.needs_you.list.request", "bots.list.request"],
          item.botId,
        );
      }),
      client.onBotsPush("bots.items_changed", ({ payload }) =>
        refetch(
          [
            "bots.items.list.request",
            "bots.items.show.request",
            "bots.needs_you.list.request",
            "bots.automations.list.request",
          ],
          payload.botId,
        ),
      ),
      client.onBotsPush("bots.suggestions_changed", ({ payload }) =>
        refetch(["bots.suggestions.list.request"], payload.botId),
      ),
      client.onBotsPush("bots.activity_changed", ({ payload }) =>
        refetch(
          payload.parts.flatMap((part) => ACTIVITY_READS[part]),
          payload.botId,
        ),
      ),
      client.onBotsPush("bots.home_file_changed", ({ payload }) => {
        useBotHomeFileStore.getState().noteDiskHash(payload.botId, payload.file, payload.hash);
        refetch(["bots.memory.read.request", "bots.memory.history.request"], payload.botId);
      }),
      client.onBotsPush("bots.chat.message", ({ payload }) => {
        const message = payload.message;
        if (message.roomId) {
          refetch(["bots.rooms.list.request"], null);
          return;
        }
        queryClient.setQueriesData<{ messages: BotMessage[] }>(
          {
            predicate: (query) =>
              query.queryKey[1] === serverId &&
              query.queryKey[2] === "bots.chat.history.request" &&
              paramsOf(query.queryKey)?.botId === message.botId,
          },
          (previous) =>
            previous
              ? { ...previous, messages: mergeMessages(previous.messages, [message]) }
              : previous,
        );
        if (message.note) refetch(["bots.chats.tree.request"], message.botId);
      }),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [client, enabled, queryClient, serverId]);
}

export function useBotAgent(serverId: string, agentId: string | undefined) {
  const { client, connected } = useBotsConnection(serverId);
  return useFetchQuery({
    queryKey: [...botsKey(serverId), "agent", agentId],
    enabled: Boolean(client && connected && agentId),
    dataShape: "value",
    staleTimeMs: 1000,
    queryFn: async () => {
      if (!client || !agentId) throw new Error(i18n.t("bots.jad.offline"));
      const result = await client.fetchAgent(agentId);
      if (!result) throw new Error(i18n.t("bots.jad.agentUnavailable"));
      applyAgentDirectoryDelta({
        serverId,
        delta: { kind: "upsert", agent: result.agent, project: result.project },
      });
      return result;
    },
  });
}

/** The message of a failed bots RPC, as the daemon wrote it (`rpc_error.payload.message`). */
export function botErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const userMessage = (error as { userMessage?: unknown }).userMessage;
    if (typeof userMessage === "string" && userMessage) return userMessage;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** `rpc_error.payload.code` of a failed bots RPC (`already_running`, `review_pending`, …). */
export function botErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
