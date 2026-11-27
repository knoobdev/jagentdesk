// The phone's bot panel: the desktop's right panel as a full-screen sheet over the Home Chat (spec
// 37.6, 38.5 "Inspector mở thành sheet toàn màn hình có hàng tab và nút đóng"). Head: the bot's name and
// "agent · computer", the Items filter, the gear for Settings; tabs Items · Chats · Files with Items'
// Needs you count. An item or Settings replaces the tabs as a page with its own Back.
// Ported from Orca dfdb4fda (MIT) mobile/src/bots/MobileBotPanel.tsx:62-432 and
// MobileBotPanelHeader.tsx:16-104. Portalled above the compact header like the workspace inspector
// (docs/mobile-panels.md, `GUMLOOP_INSPECTOR_HOST`).
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Portal } from "@gorhom/portal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, ListFilter, Settings, X } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { FileExplorerPane } from "@/components/file-explorer-pane";
import { GUMLOOP_INSPECTOR_HOST } from "@/components/gumloop-shell/sidebar-state";
import { HostRouteProvider } from "@/navigation/host-route-context";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import type { BotLiveState } from "@/bots/bot-status";
import { useBotPanel, useBotPanelStore } from "@/bots/panel-store";
import { BotItemPane } from "@/bots/items/item-pane";
import { BotItemStatusIcon } from "@/bots/items/item-parts";
import { BotChatsPanel } from "@/bots/panel/chats-panel";
import { BotConnectorsPanel } from "@/bots/connectors/connectors-panel";
import { BotSettingsView } from "@/bots/settings/settings-view";
import { useProviderLabel } from "@/bots/settings/agent-group";
import { closePhoneBotPanel, usePhoneBotPanel, type PhoneBotPanelTab } from "./panel-store";
import { PhoneBotItemsTab } from "./items-tab";
import { PhonePageHeader } from "./page-header";

const ThemedX = withUnistyles(X);
const ThemedFilter = withUnistyles(ListFilter);
const ThemedSettings = withUnistyles(Settings);
const ThemedCheck = withUnistyles(Check);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const TABS: readonly PhoneBotPanelTab[] = ["items", "chats", "files"];

export function PhoneBotPanelSheet({
  serverId,
  bot,
  live,
}: {
  serverId: string;
  bot: Bot;
  live: BotLiveState;
}) {
  const openBotId = usePhoneBotPanel((state) => state.openBotId);
  if (openBotId !== bot.id) return null;
  return (
    <Portal hostName={GUMLOOP_INSPECTOR_HOST}>
      {/* The portal mounts at the app root, above the host route's provider. */}
      <HostRouteProvider serverId={serverId}>
        <PanelSurface serverId={serverId} bot={bot} live={live} />
      </HostRouteProvider>
    </Portal>
  );
}

function PanelSurface({ serverId, bot, live }: { serverId: string; bot: Bot; live: BotLiveState }) {
  const insets = useSafeAreaInsets();
  const panel = useBotPanel(bot.id);
  const surfaceStyle = useMemo(
    () => [styles.surface, { paddingTop: insets.top, paddingBottom: insets.bottom }],
    [insets.top, insets.bottom],
  );
  let body;
  if (panel.view.kind === "item")
    body = <BotItemPane serverId={serverId} bot={bot} itemId={panel.view.itemId} />;
  else if (panel.view.kind === "settings")
    body = <BotSettingsView serverId={serverId} bot={bot} page={panel.view.page} />;
  else if (panel.tab === "connectors") body = <ConnectorsPage serverId={serverId} bot={bot} />;
  else body = <PanelMain serverId={serverId} bot={bot} live={live} />;
  return (
    <View style={surfaceStyle} testID="phone-bot-panel">
      {body}
    </View>
  );
}

/** Settings › Access › Connectors: the desktop's Connectors tab as a page (Orca has no phone tab for it). */
function ConnectorsPage({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const back = useCallback(() => {
    const store = useBotPanelStore.getState();
    store.setTab(bot.id, "home");
    store.openSettings(bot.id, "root");
  }, [bot.id]);
  return (
    <>
      <PhonePageHeader
        title={t("bots.connectors.tab")}
        backLabel={t("bots.phone.bots.lookAround.back")}
        onBack={back}
      />
      <View style={styles.body}>
        <BotConnectorsPanel serverId={serverId} bot={bot} />
      </View>
    </>
  );
}

function PanelMain({ serverId, bot, live }: { serverId: string; bot: Bot; live: BotLiveState }) {
  const { t } = useTranslation();
  const tab = usePhoneBotPanel((state) => state.tab);
  const panel = useBotPanel(bot.id);
  const [filtering, setFiltering] = useState(false);
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const agent = useProviderLabel(serverId, bot.provider);
  const close = useCallback(() => closePhoneBotPanel(bot.id), [bot.id]);
  const openSettings = useCallback(
    () => useBotPanelStore.getState().openSettings(bot.id, "root"),
    [bot.id],
  );
  const openFilter = useCallback(() => setFiltering(true), []);
  const closeFilter = useCallback(() => setFiltering(false), []);
  const toggleNeedsYou = useCallback(() => {
    useBotPanelStore
      .getState()
      .setFilters(bot.id, { needsYouOnly: !panel.filters.needsYouOnly, chatId: null });
    setFiltering(false);
  }, [bot.id, panel.filters.needsYouOnly]);
  const openFile = useCallback(
    (path: string) => {
      // The file opens in the centre beside Home Chat, as the desktop's Files tab does.
      useBotPanelStore.getState().setOpenFile(bot.id, path);
      close();
    },
    [bot.id, close],
  );
  const filterOn = panel.filters.needsYouOnly;
  const filterHeader = useMemo(() => ({ title: t("bots.phone.bots.items.filter.label") }), [t]);
  const filterState = useMemo(() => ({ selected: filterOn }), [filterOn]);
  const checkedState = useMemo(() => ({ checked: filterOn }), [filterOn]);
  const filterStyle = useMemo(
    () => [styles.iconButton, filterOn && styles.iconButtonActive],
    [filterOn],
  );
  let body;
  if (tab === "chats")
    body = (
      <View style={styles.body}>
        <BotChatsPanel serverId={serverId} bot={bot} />
      </View>
    );
  else if (tab === "files")
    body = (
      <View style={styles.body}>
        {bot.home ? (
          <FileExplorerPane serverId={serverId} workspaceRoot={bot.home} onOpenFile={openFile} />
        ) : null}
      </View>
    );
  else
    body = (
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.itemsContent}
        keyboardShouldPersistTaps="handled"
        testID="phone-bot-panel-items"
      >
        <PhoneBotItemsTab serverId={serverId} bot={bot} />
      </ScrollView>
    );
  return (
    <>
      <View style={styles.header}>
        <Pressable
          onPress={close}
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel={t("bots.jad.close")}
          testID="phone-bot-panel-close"
        >
          <ThemedX size={20} uniProps={foreground} />
        </Pressable>
        <View style={styles.titleBlock}>
          <Text style={styles.title} numberOfLines={1}>
            {bot.name}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1} testID="phone-bot-panel-sub">
            {`${agent} · ${hostLabel}`}
          </Text>
        </View>
        {tab === "items" ? (
          <Pressable
            onPress={openFilter}
            style={filterStyle}
            accessibilityRole="button"
            accessibilityLabel={t("bots.phone.bots.items.filter.label")}
            accessibilityState={filterState}
            testID="phone-bot-panel-filter"
          >
            <ThemedFilter size={18} uniProps={filterOn ? foreground : muted} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={openSettings}
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel={t("bots.phone.bots.sheet.settings")}
          testID="phone-bot-panel-settings"
        >
          <ThemedSettings size={18} uniProps={foreground} />
        </Pressable>
      </View>
      <PanelTabs needsYou={live.needsYou} tab={tab} />
      {body}
      <AdaptiveModalSheet
        visible={filtering}
        onClose={closeFilter}
        header={filterHeader}
        testID="phone-bot-items-filter"
      >
        <Pressable
          onPress={toggleNeedsYou}
          style={styles.filterRow}
          accessibilityRole="checkbox"
          accessibilityState={checkedState}
          testID="phone-bot-items-filter-needs-you"
        >
          <BotItemStatusIcon status="needs_you" />
          <Text style={styles.filterLabel}>{t("bots.phone.bots.items.filter.needsYou")}</Text>
          {filterOn ? <ThemedCheck size={16} uniProps={foreground} /> : null}
        </Pressable>
      </AdaptiveModalSheet>
    </>
  );
}

function PanelTabs({ needsYou, tab }: { needsYou: number; tab: PhoneBotPanelTab }) {
  const { t } = useTranslation();
  const labels: Record<PhoneBotPanelTab, string> = {
    items: t("bots.phone.bots.items.tab"),
    chats: t("bots.phone.bots.panel.chats"),
    files: t("bots.phone.bots.panel.files"),
  };
  return (
    <View style={styles.tabs} accessibilityRole="tablist">
      {TABS.map((id) => (
        <PanelTab
          key={id}
          id={id}
          label={labels[id]}
          count={id === "items" ? needsYou : 0}
          active={tab === id}
        />
      ))}
    </View>
  );
}

function PanelTab({
  id,
  label,
  count,
  active,
}: {
  id: PhoneBotPanelTab;
  label: string;
  count: number;
  active: boolean;
}) {
  const { t } = useTranslation();
  const select = useCallback(() => usePhoneBotPanel.getState().setTab(id), [id]);
  const style = useMemo(() => [styles.tab, active && styles.tabActive], [active]);
  const textStyle = useMemo(() => [styles.tabText, active && styles.tabTextActive], [active]);
  const state = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={select}
      style={style}
      accessibilityRole="tab"
      accessibilityState={state}
      accessibilityLabel={count > 0 ? t("bots.phone.bots.panel.itemsNeedYou", { count }) : label}
      testID={`phone-bot-panel-tab-${id}`}
    >
      <Text style={textStyle}>{label}</Text>
      {count > 0 ? (
        <View style={styles.count} testID={`phone-bot-panel-count-${id}`}>
          <BotItemStatusIcon status="needs_you" />
          <Text style={styles.countText}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  surface: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonActive: { backgroundColor: theme.colors.surface2 },
  titleBlock: { flex: 1, minWidth: 0, paddingHorizontal: 4 },
  title: { fontSize: 17, fontWeight: "600", color: theme.colors.foreground },
  subtitle: { fontSize: 13, color: theme.colors.foregroundMuted },
  // The inspector's tab row (spec 38.4.5), at the phone's 44 px touch height (38.5).
  tabs: {
    height: 44,
    flexDirection: "row",
    alignItems: "stretch",
    gap: 20,
    paddingHorizontal: 16,
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
  tabText: { fontSize: 15, color: theme.colors.foregroundMuted },
  tabTextActive: { color: theme.colors.foreground, fontWeight: "500" },
  count: { flexDirection: "row", alignItems: "center", gap: 3 },
  countText: { fontSize: 12, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  body: { flex: 1, minHeight: 0 },
  itemsContent: { paddingHorizontal: 12, paddingTop: 8, paddingBottom: 24, gap: 4 },
  filterRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 4,
  },
  filterLabel: { flex: 1, fontSize: 15, color: theme.colors.foreground },
}));
