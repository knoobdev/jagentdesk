// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/BotPausedBanner.tsx:10-34:
// across the top of a paused bot's Home panel until it is resumed (spec 37.4.4 item 2).
import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Pause } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { useBotsMutation } from "../queries";

const ThemedPause = withUnistyles(Pause);
const warning = (theme: Theme) => ({ color: theme.colors.statusWarning });

export function BotPausedBanner({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const pause = useBotsMutation(serverId, "bots.pause.request");
  const resume = useCallback(() => pause.mutate({ botId: bot.id, paused: false }), [pause, bot.id]);
  return (
    <View style={styles.banner} accessibilityRole="alert" testID="bot-paused-banner">
      <ThemedPause size={16} uniProps={warning} />
      <Text style={styles.text}>{t("bots.paused.banner")}</Text>
      <Button
        size="sm"
        variant="outline"
        disabled={pause.isPending}
        onPress={resume}
        testID="bot-paused-resume"
      >
        {t("bots.paused.resume")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 8,
    borderRadius: 8,
    backgroundColor: theme.colors.statusWarningBackground,
  },
  text: { flex: 1, fontSize: 13, fontWeight: "500", color: theme.colors.statusWarning },
}));
