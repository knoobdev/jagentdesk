// The bot page's inspector (spec 37.4.3, 38.4.5): 525 px, a 64 px tab row Home · Connectors · Chats ·
// Files, ported from Orca dfdb4fda (MIT) src/renderer/src/components/right-sidebar/activity-bar/
// use-right-sidebar-activity-items.ts:116-168 (bot tabs, "{{count}} need you" badges) and
// right-sidebar-activity-visibility.ts:34-35 (a bot page shows only these four).
import { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { useBotPanel, useBotPanelStore, type BotPanelTab } from "../panel-store";
import type { BotLiveState } from "../bot-status";
import { BotActivityPanel } from "./activity-panel";
import { BotChatsPanel } from "./chats-panel";
import { BotConnectorsPanel, useBotConnectorsNeedFix } from "../connectors/connectors-panel";

const TABS: readonly BotPanelTab[] = ["home", "connectors", "chats", "files"];

function TabButton({
  tab,
  label,
  count,
  active,
  onPress,
}: {
  tab: BotPanelTab;
  label: string;
  count: number;
  active: boolean;
  onPress: (tab: BotPanelTab) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(() => onPress(tab), [onPress, tab]);
  const style = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const textStyle = useMemo(() => [styles.tabText, active && styles.tabTextActive], [active]);
  const selectedState = useMemo(() => ({ selected: active }), [active]);
  const badgeLabel = count > 0 ? t("bots.connectors.needYou", { count }) : undefined;
  return (
    <Pressable
      style={style}
      onPress={press}
      accessibilityRole="tab"
      accessibilityState={selectedState}
      accessibilityLabel={badgeLabel ? `${label}, ${badgeLabel}` : label}
      testID={`bot-panel-tab-${tab}`}
    >
      <Text style={textStyle}>{label}</Text>
      {count > 0 ? (
        <View
          style={styles.badge}
          accessibilityLabel={badgeLabel}
          testID={`bot-panel-badge-${tab}`}
        >
          <Text style={styles.badgeText}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function BotRightPanel({
  serverId,
  bot,
  live,
  now,
}: {
  serverId: string;
  bot: Bot;
  live: BotLiveState;
  now: number;
}) {
  const { t } = useTranslation();
  const panel = useBotPanel(bot.id);
  const connectorsNeedFix = useBotConnectorsNeedFix(bot);
  const select = useCallback(
    (tab: BotPanelTab) => useBotPanelStore.getState().setTab(bot.id, tab),
    [bot.id],
  );
  const openFile = useCallback(
    (path: string) => useBotPanelStore.getState().setOpenFile(bot.id, path),
    [bot.id],
  );
  const labels: Record<BotPanelTab, string> = {
    home: t("bots.items.tab"),
    connectors: t("bots.connectors.tab"),
    chats: t("bots.chats.title"),
    files: t("bots.files.tab"),
  };
  const counts: Record<BotPanelTab, number> = {
    home: live.needsYou,
    connectors: connectorsNeedFix,
    chats: 0,
    files: 0,
  };
  let body;
  switch (panel.tab) {
    case "connectors":
      body = <BotConnectorsPanel serverId={serverId} bot={bot} />;
      break;
    case "chats":
      body = <BotChatsPanel serverId={serverId} bot={bot} />;
      break;
    case "files":
      body = bot.home ? (
        <FileExplorerPane serverId={serverId} workspaceRoot={bot.home} onOpenFile={openFile} />
      ) : null;
      break;
    default:
      body = <BotActivityPanel serverId={serverId} bot={bot} live={live} now={now} />;
  }
  return (
    <View style={styles.panel} testID="bot-right-panel">
      <View style={styles.tabs} accessibilityRole="tablist">
        {TABS.map((tab) => (
          <TabButton
            key={tab}
            tab={tab}
            label={labels[tab]}
            count={counts[tab]}
            active={panel.tab === tab}
            onPress={select}
          />
        ))}
      </View>
      <View style={styles.body}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  panel: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  tabs: {
    height: 64,
    flexDirection: "row",
    alignItems: "stretch",
    gap: 20,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: theme.colors.foreground },
  tabText: { fontSize: 16, color: theme.colors.foregroundMuted },
  tabTextActive: { color: theme.colors.foreground },
  // Status chip `38.4.6`, the statusWarning pair.
  badge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    alignItems: "center",
    backgroundColor: theme.colors.statusWarningBackground,
  },
  badgeText: { fontSize: 12, fontWeight: "500", color: theme.colors.statusWarning },
  body: { flex: 1, minHeight: 0 },
}));
