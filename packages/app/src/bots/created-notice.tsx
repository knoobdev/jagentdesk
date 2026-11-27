// The daemon's kickoff turn in a bot's Home Chat, in place of a user bubble. Ported from Orca dfdb4fda
// (MIT) src/renderer/src/components/native-chat/NativeChatBotCreatedRow.tsx:12-38: the first kickoff
// shows only when the chat started; a later one (Try again) is a "{{name}} started setting up again"
// divider. The instruction the agent got is never shown.
import { useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { Theme } from "@/styles/theme";
import { formatMessageTimestamp } from "@/utils/time";
import { useBot } from "./queries";

export function BotCreatedNotice({
  serverId,
  botId,
  timestamp,
  again,
}: {
  serverId: string;
  botId: string;
  timestamp: number;
  /** A kickoff after the first one: the owner pressed Try again. */
  again: boolean;
}) {
  const { t } = useTranslation();
  const bot = useBot(serverId, botId);
  const time = useMemo(() => formatMessageTimestamp(new Date(timestamp)), [timestamp]);
  let label: string | null = null;
  if (again)
    label = bot ? t("bots.jad.botCreatedAgain", { name: bot.name }) : t("bots.jad.botCreated");
  return (
    <View style={styles.row} accessibilityRole="text" testID="bot-created-notice">
      <Text style={styles.text}>{label ? `${label} · ${time}` : time}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[2],
  },
  text: { fontSize: 12, color: theme.colors.foregroundMuted, textAlign: "center", flexShrink: 1 },
}));
