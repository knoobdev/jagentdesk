// bt4 contract: the GitHub, GitLab and Telegram connector RPCs of `bots-hooks-contract.md` (spec
// 37.10-37.12, ADR-0061 §6). Their request schemas live on plat/bt4-hooks and are not in this
// branch's protocol yet, so the shapes below are typed from that contract and every call goes
// through `hooksRequest`. Once plat/bt4-hooks merges, delete these types, import them from
// `@jagentdesk/protocol/bots/rpc-schemas` and call `client.botsRequest` directly.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { i18n } from "@/i18n/i18next";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { botsKey, useBotsConnection } from "@/bots/queries";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

type HookTargetState = "waiting" | "connected" | "manual";
export interface HookAllowedUser {
  id: string;
  name: string;
  username?: string;
}
export interface GitHubStatus {
  relayConnected: boolean;
  signedIn: boolean;
  host: string;
  requestUrl?: string;
  ownerLogin?: string;
  targets: { target: string; state: HookTargetState; lastEventAt_ms?: number }[];
  allowedUsers: HookAllowedUser[];
}
export interface GitLabStatus {
  relayConnected: boolean;
  signedIn: boolean;
  host: string;
  requestUrl?: string;
  ownerUsername?: string;
  targets: {
    host: string;
    path: string;
    scope: "project" | "group";
    state: HookTargetState;
    lastEventAt_ms?: number;
  }[];
  allowedUsers: HookAllowedUser[];
}
export interface TelegramStatus {
  connected: boolean;
  relayConnected: boolean;
  requestUrl?: string;
  botUsername?: string;
  allowedUsers: HookAllowedUser[];
}
/** Shown once when the hook must be made by hand; the secret is never returned again. */
export interface HookManualSetup {
  payloadUrl: string;
  contentType?: string;
  secret: string;
  events: string[];
  settingsUrl?: string;
}

interface GitLabTarget {
  host: string;
  path: string;
}
interface HooksRpc {
  "bots.github.status.request": [{ botId: string }, { status: GitHubStatus }];
  "bots.github.add_repo.request": [
    { botId: string; target: string },
    { status: GitHubStatus; manual?: HookManualSetup },
  ];
  "bots.github.rotate_secret.request": [
    { botId: string; target: string },
    { status: GitHubStatus; manual?: HookManualSetup },
  ];
  "bots.github.remove.request": [{ botId: string; target: string }, { status: GitHubStatus }];
  "bots.github.allowed.add.request": [{ botId: string; login: string }, { status: GitHubStatus }];
  "bots.github.allowed.remove.request": [
    { botId: string; login: string },
    { status: GitHubStatus },
  ];
  "bots.gitlab.status.request": [{ botId: string; host?: string }, { status: GitLabStatus }];
  "bots.gitlab.add_project.request": [
    { botId: string } & GitLabTarget,
    { status: GitLabStatus; manual?: HookManualSetup },
  ];
  "bots.gitlab.rotate_secret.request": [
    { botId: string } & GitLabTarget,
    { status: GitLabStatus; manual?: HookManualSetup },
  ];
  "bots.gitlab.remove.request": [{ botId: string } & GitLabTarget, { status: GitLabStatus }];
  "bots.gitlab.allowed.add.request": [
    { botId: string; username: string },
    { status: GitLabStatus },
  ];
  "bots.gitlab.allowed.remove.request": [
    { botId: string; username: string },
    { status: GitLabStatus },
  ];
  "bots.telegram.status.request": [{ botId: string }, { status: TelegramStatus }];
  "bots.telegram.connect.request": [{ botId: string; token: string }, { status: TelegramStatus }];
  "bots.telegram.link_code.request": [{ botId: string }, { code: string; expiresAt_ms: number }];
  "bots.telegram.allowed.remove.request": [
    { botId: string; userId: string },
    { status: TelegramStatus },
  ];
  "bots.telegram.disconnect.request": [{ botId: string }, { status: TelegramStatus }];
}
export type HooksRequestType = keyof HooksRpc;
export type HooksParams<T extends HooksRequestType> = HooksRpc[T][0];
export type HooksResult<T extends HooksRequestType> = HooksRpc[T][1];

type UntypedBotsRequest = (type: string, params: object) => Promise<unknown>;

/** One bt4 connector RPC through the client's bots entry point (`bots.*.request` → `.response`). */
export async function hooksRequest<T extends HooksRequestType>(
  client: DaemonClient,
  type: T,
  params: HooksParams<T>,
): Promise<HooksResult<T>> {
  const request = client.botsRequest.bind(client) as unknown as UntypedBotsRequest;
  return (await request(type, params)) as HooksResult<T>;
}

/** `server_info.features.botsHooks` (bt4); a host without it has no GitHub/GitLab/Telegram rows. */
export function useBotsHooksSupported(serverId: string): boolean {
  return useSessionStore((state) => {
    const features = state.sessions[serverId]?.serverInfo?.features;
    if (!features || !("botsHooks" in features)) return false;
    return (features as Record<string, unknown>).botsHooks === true;
  });
}

const hooksKey = (serverId: string, type: HooksRequestType, params: object) =>
  [...botsKey(serverId), type, params] as const;

export function useHooksRead<T extends HooksRequestType>(
  serverId: string,
  type: T,
  params: HooksParams<T>,
  options: { enabled?: boolean; pollMs?: number } = {},
) {
  const { client, enabled } = useBotsConnection(serverId);
  const supported = useBotsHooksSupported(serverId);
  return useFetchQuery({
    queryKey: hooksKey(serverId, type, params),
    enabled: enabled && supported && options.enabled !== false,
    dataShape: "value",
    staleTimeMs: 1000,
    refetchInterval: options.pollMs ?? false,
    queryFn: async (): Promise<HooksResult<T>> => {
      if (!client) throw new Error(i18n.t("bots.jad.offline"));
      return hooksRequest(client, type, params);
    },
  });
}

/** A bt4 connector write; on success it refetches that connector's status and the bot list. */
export function useHooksMutation<T extends HooksRequestType>(serverId: string, type: T) {
  const { client, enabled } = useBotsConnection(serverId);
  const queryClient = useQueryClient();
  const connector = type.split(".")[1];
  return useMutation({
    mutationFn: async (params: HooksParams<T>): Promise<HooksResult<T>> => {
      if (!client || !enabled) throw new Error(i18n.t("bots.jad.offline"));
      return hooksRequest(client, type, params);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey;
          if (key[0] !== "bots" || key[1] !== serverId) return false;
          const read = String(key[2]);
          return read === "bots.list.request" || read.startsWith(`bots.${connector}.`);
        },
      });
    },
  });
}
