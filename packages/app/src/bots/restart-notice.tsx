// The daemon's continuation after a restart cut a bot's reply, as a notice row instead of a user
// bubble (Orca dfdb4fda (MIT) src/renderer/src/components/native-chat/NativeChatNoticeRow.tsx:320,
// agent-session-restart-note-text.ts). The instruction the agent got is never shown.
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

const ThemedIcon = withUnistyles(RotateCcw);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function BotRestartNotice() {
  const { t } = useTranslation();
  return (
    <View style={styles.row} accessibilityRole="text" testID="bot-restart-notice">
      <ThemedIcon size={12} uniProps={muted} />
      <Text style={styles.text}>{t("bots.jad.restartContinued")}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: theme.spacing[2],
  },
  text: { fontSize: 12, color: theme.colors.foregroundMuted, textAlign: "center", flexShrink: 1 },
}));
