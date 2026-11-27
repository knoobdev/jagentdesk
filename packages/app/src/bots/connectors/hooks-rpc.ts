// The GitHub, GitLab and Telegram connector RPCs (bt4, spec 37.10-37.12, ADR-0061 §6), typed by
// `@jagentdesk/protocol/bots/rpc-schemas`. The setup dialogs read and write through the shared bots
// queries, gated once on `server_info.features.botsHooks`.
import type { BotsRequestParams, BotsRequestType } from "@jagentdesk/protocol/bots/rpc-schemas";
import { useHostFeature } from "@/runtime/host-features";
import { useBotsMutation, useBotsRead } from "@/bots/queries";

export type {
  GitHubStatus,
  GitLabStatus,
  HookManualSetup,
  TelegramStatus,
} from "@jagentdesk/protocol/bots/rpc-schemas";

/** A Who can ask person of GitHub, GitLab or Telegram (`AllowedUserSchema`). */
export interface HookAllowedUser {
  id: string;
  name: string;
  username?: string;
}

type HooksRequestType = Extract<
  BotsRequestType,
  `bots.github.${string}` | `bots.gitlab.${string}` | `bots.telegram.${string}`
>;

/** `server_info.features.botsHooks`; a host without it shows "Update the host…" on these rows. */
export function useBotsHooksSupported(serverId: string): boolean {
  return useHostFeature(serverId, "botsHooks");
}

export function useHooksRead<T extends HooksRequestType>(
  serverId: string,
  type: T,
  params: BotsRequestParams<T>,
  options: { enabled?: boolean; pollMs?: number } = {},
) {
  const supported = useBotsHooksSupported(serverId);
  return useBotsRead(serverId, type, params, {
    enabled: supported && options.enabled !== false,
    refetchIntervalMs: options.pollMs,
  });
}

/** A connector write; on success every read about the bot refetches (its status, Who can ask, list). */
export function useHooksMutation<T extends HooksRequestType>(serverId: string, type: T) {
  return useBotsMutation(serverId, type);
}
