// "Hand to bot…" in a Projects workspace's menu (spec 37.4.11). Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/hand-to-bot/WorktreeHandToBotMenuItem.tsx:1-33. Shown only on a
// host with the Orca-layout bots (`features.botsOrca`); it opens `HandToBotFlow`.
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Bot } from "lucide-react-native";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useHostFeature } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { openBotsDialog } from "@/bots/dialogs-store";

const ThemedBot = withUnistyles(Bot);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const leadingIcon = <ThemedBot size={14} uniProps={muted} />;

/** `workspaceKey` is `<serverId>:<workspaceId>`. */
export function parseWorkspaceKey(key: string): { serverId: string; workspaceId: string } | null {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  return { serverId: key.slice(0, at), workspaceId: key.slice(at + 1) };
}

export function HandToBotMenuItem({
  surface,
  workspaceKey,
}: {
  surface: "context" | "dropdown";
  workspaceKey: string;
}) {
  const { t } = useTranslation();
  const parsed = parseWorkspaceKey(workspaceKey);
  const serverId = parsed?.serverId ?? "";
  const workspaceId = parsed?.workspaceId ?? "";
  const bots = useHostFeature(serverId, "bots");
  const orca = useHostFeature(serverId, "botsOrca");
  const name = useSessionStore((state) => {
    const workspace = state.sessions[serverId]?.workspaces.get(workspaceId);
    return workspace ? workspace.title || workspace.name : null;
  });
  const open = useCallback(() => {
    openBotsDialog({ kind: "handToBot", serverId, workspaceId, name: name ?? workspaceId });
  }, [name, serverId, workspaceId]);
  if (!parsed || !bots || !orca) return null;
  const Item = surface === "context" ? ContextMenuItem : DropdownMenuItem;
  return (
    <Item
      leading={leadingIcon}
      onSelect={open}
      testID={`sidebar-workspace-menu-hand-to-bot-${workspaceKey}`}
    >
      {t("bots.handToBot.menu")}
    </Item>
  );
}
