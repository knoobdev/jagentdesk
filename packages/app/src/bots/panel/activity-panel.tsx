// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/BotActivityPanel.tsx:95-233: the
// Home tab — the header, the Paused banner, Items (Needs you first), Automations, Suggestions; an
// open item or Settings takes the list's place (spec 37.4.4, 37.4.5, 37.4.8).
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { BotItemPane } from "../items/item-pane";
import { BotItemsFilterChips, BotItemsSection } from "../items/items-section";
import { BotSettingsView } from "../settings/settings-view";
import { useBotPanel } from "../panel-store";
import type { BotLiveState } from "../bot-status";
import { BotPanelHeader } from "./panel-header";
import { BotPausedBanner } from "./paused-banner";
import { BotAutomationsSection } from "./automations-section";
import { BotSuggestionsSection } from "./suggestions-section";

export function BotActivityPanel({
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
  const panel = useBotPanel(bot.id);
  if (panel.view.kind === "item")
    return <BotItemPane serverId={serverId} bot={bot} itemId={panel.view.itemId} />;
  if (panel.view.kind === "settings")
    return <BotSettingsView serverId={serverId} bot={bot} page={panel.view.page} />;
  return (
    <ScrollView contentContainerStyle={styles.content} testID="bot-activity-panel">
      <BotPanelHeader serverId={serverId} bot={bot} live={live} now={now} />
      {bot.paused ? <BotPausedBanner serverId={serverId} bot={bot} /> : null}
      <BotItemsFilterChips bot={bot} />
      <BotItemsSection serverId={serverId} bot={bot} />
      <View style={styles.gap} />
      <BotAutomationsSection serverId={serverId} bot={bot} />
      <BotSuggestionsSection serverId={serverId} bot={bot} />
    </ScrollView>
  );
}

const styles = StyleSheet.create((_theme: Theme) => ({
  content: { paddingHorizontal: 16, paddingVertical: 12, gap: 14 },
  gap: { height: 4 },
}));
