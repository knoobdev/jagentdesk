// A bot's settings inside its right panel (spec 37.4.8): a crumb ("Back to Home" / "Back to
// Settings", bot name / Settings / page), then the root or one drill-in page, scrolling on its own.
// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/settings-view/BotSettingsView.tsx:1-311
// and BotSettingsSubpage.tsx:1-91.
import { useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { useBotPanelStore, type BotSettingsPage } from "@/bots/panel-store";
import { useBotsConnection } from "@/bots/queries";
import { BotSharingRow } from "@/bots/sharing/sharing-row";
import { useBotSharingSupported } from "@/bots/sharing/share-queries";
import type { Theme } from "@/styles/theme";
import { SkillsPage, WhoCanAskPage } from "./access-pages";
import { LookAroundPage } from "./look-around-page";
import { BotMemoryPanel } from "./memory-panel";
import { SettingsControlsOffContext } from "./rows";
import { BotSettingsRoot } from "./settings-root";
import { BotSoulEditor } from "./soul-editor";
import { TidyUpPage } from "./tidy-up-page";

const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const ThemedChevronLeft = withUnistyles(ChevronLeft);

function pageTitleKey(page: Exclude<BotSettingsPage, "root">): string {
  switch (page) {
    case "lookAround":
      return "bots.settingsBots.lookAround.title";
    case "tidyUp":
      return "bots.settingsBots.tidyUp.title";
    case "soul":
      return "bots.settingsBots.soul";
    case "memory":
      return "bots.settingsBots.memory";
    case "whoCanAsk":
      return "bots.settingsView.whoCanAsk";
    case "skills":
      return "bots.settingsBots.skills.title";
    case "share":
      return "bots.settingsView.sharing";
  }
}

function SharePage({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const supported = useBotSharingSupported(serverId);
  if (supported) return <BotSharingRow serverId={serverId} bot={bot} />;
  return (
    <Text style={styles.muted} testID="bot-settings-share-unavailable">
      {t("bots.jad.settings.shareUnavailable")}
    </Text>
  );
}

function Subpage({
  serverId,
  bot,
  page,
}: {
  serverId: string;
  bot: Bot;
  page: Exclude<BotSettingsPage, "root">;
}) {
  switch (page) {
    case "lookAround":
      return <LookAroundPage serverId={serverId} bot={bot} />;
    case "tidyUp":
      return <TidyUpPage serverId={serverId} bot={bot} />;
    case "soul":
      return <BotSoulEditor serverId={serverId} bot={bot} />;
    case "memory":
      return <BotMemoryPanel serverId={serverId} bot={bot} />;
    case "whoCanAsk":
      return <WhoCanAskPage serverId={serverId} bot={bot} />;
    case "skills":
      return <SkillsPage serverId={serverId} bot={bot} />;
    case "share":
      return <SharePage serverId={serverId} bot={bot} />;
  }
}

export function BotSettingsView({
  serverId,
  bot,
  page,
}: {
  serverId: string;
  bot: Bot;
  page: BotSettingsPage;
}) {
  const { t } = useTranslation();
  const { connected } = useBotsConnection(serverId);
  const toRoot = useCallback(
    () => useBotPanelStore.getState().openSettings(bot.id, "root"),
    [bot.id],
  );
  const exit = useCallback(() => useBotPanelStore.getState().backToActivity(bot.id), [bot.id]);
  const open = useCallback(
    (next: BotSettingsPage) => useBotPanelStore.getState().openSettings(bot.id, next),
    [bot.id],
  );
  const sub = page === "root" ? null : page;
  const back = sub ? t("bots.settingsView.backToSettings") : t("bots.settingsView.backToItems");
  const settings = t("bots.panel.settings.title");
  return (
    <View style={styles.view} testID="bot-settings-view">
      <View style={styles.crumb} accessibilityLabel={t("bots.settingsView.crumb")}>
        <Pressable
          style={styles.backButton}
          onPress={sub ? toRoot : exit}
          accessibilityRole="button"
          accessibilityLabel={back}
          testID="bot-settings-back"
        >
          <ThemedChevronLeft size={16} uniProps={foreground} />
        </Pressable>
        <Pressable onPress={exit} accessibilityRole="link" style={styles.crumbPart}>
          <Text style={styles.crumbText} numberOfLines={1}>
            {bot.name}
          </Text>
        </Pressable>
        <Text style={styles.sep}>/</Text>
        {sub ? (
          <>
            <Pressable onPress={toRoot} accessibilityRole="link">
              <Text style={styles.crumbText}>{settings}</Text>
            </Pressable>
            <Text style={styles.sep}>/</Text>
            <Text style={styles.crumbCurrent} numberOfLines={1}>
              {t(pageTitleKey(sub))}
            </Text>
          </>
        ) : (
          <Text style={styles.crumbCurrent}>{settings}</Text>
        )}
      </View>
      <SettingsControlsOffContext.Provider value={!connected}>
        <ScrollView
          key={page}
          style={styles.scroll}
          contentContainerStyle={[styles.content, page === "soul" && styles.grow]}
          keyboardShouldPersistTaps="handled"
          testID={`bot-settings-page-${page}`}
        >
          {sub ? (
            <Subpage serverId={serverId} bot={bot} page={sub} />
          ) : (
            <BotSettingsRoot serverId={serverId} bot={bot} open={open} onDeleted={exit} />
          )}
        </ScrollView>
      </SettingsControlsOffContext.Provider>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  view: { flex: 1, minHeight: 0, minWidth: 0 },
  crumb: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[1.5],
    paddingRight: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  crumbPart: { flexShrink: 1, minWidth: 0 },
  crumbText: { fontSize: 13, color: theme.colors.foregroundMuted },
  crumbCurrent: { fontSize: 13, fontWeight: "600", color: theme.colors.foreground, flexShrink: 0 },
  sep: { fontSize: 13, color: theme.colors.foregroundMuted },
  scroll: { flex: 1, minHeight: 0 },
  content: {
    gap: 18,
    paddingHorizontal: theme.spacing[3],
    paddingTop: 14,
    paddingBottom: theme.spacing[6],
  },
  grow: { flexGrow: 1 },
  muted: {
    paddingHorizontal: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
}));
