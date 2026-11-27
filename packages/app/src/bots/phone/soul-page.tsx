// Settings › Soul on a phone (spec 37.6): SOUL.md read as the desktop's Read view shows it, with
// "{{lines}} lines · {{words}} words"; phones don't edit it, so "Change in chat" closes the panel and
// drafts "Change your SOUL.md so that " in the Home Chat composer (not sent).
// Ported from Orca dfdb4fda (MIT) mobile/src/bots/soul-memory/MobileBotSoulAndMemory.tsx:78-147.
import { useCallback, useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MessageSquareText } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { botHomeFileKey, useBotHomeFileStore } from "@/bots/home-file-store";
import { prefillHomeChat } from "@/bots/home-chat-draft";
import { botErrorMessage, useBotsRead } from "@/bots/queries";
import { soulStats } from "@/bots/settings/row-states";
import { closePhoneBotPanel } from "./panel-store";

// File names, never translated.
const SOUL_FILE = "SOUL.md";
const ThemedMessage = withUnistyles(MessageSquareText);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });

export function PhoneSoulPage({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const read = useBotsRead(serverId, "bots.home_file.read.request", {
    botId: bot.id,
    file: SOUL_FILE,
  });
  const diskHash = useBotHomeFileStore(
    (state) => state.diskHashes[botHomeFileKey(bot.id, SOUL_FILE)],
  );
  const { refetch } = read;
  // Read only: whatever lands on disk shows.
  useEffect(() => {
    if (diskHash && read.data && diskHash !== read.data.hash) void refetch();
  }, [diskHash, read.data, refetch]);
  const retry = useCallback(() => void refetch(), [refetch]);
  const changeInChat = useCallback(() => {
    closePhoneBotPanel(bot.id);
    prefillHomeChat(serverId, bot.id, t("bots.phone.bots.soul.changeDraft"));
  }, [bot.id, serverId, t]);

  if (!read.data) {
    return read.isError ? (
      <View style={styles.state}>
        <Text style={styles.muted}>{botErrorMessage(read.error)}</Text>
        <Button size="sm" variant="outline" onPress={retry}>
          {t("bots.phone.bots.homeFile.retry")}
        </Button>
      </View>
    ) : (
      <Text style={styles.muted}>{t("bots.phone.bots.homeFile.reading", { file: SOUL_FILE })}</Text>
    );
  }
  const text = read.data.content;
  const stats = soulStats(text);
  return (
    <View style={styles.page} testID="phone-bot-soul">
      <View style={styles.head}>
        <Text style={styles.file}>{SOUL_FILE}</Text>
        <Text style={styles.muted} testID="phone-bot-soul-stats">
          {t("bots.phone.bots.soul.stats", stats)}
        </Text>
      </View>
      <View style={styles.document}>
        {text.trim() ? (
          <MarkdownRenderer text={text} />
        ) : (
          <Text style={styles.muted}>{t("bots.phone.bots.soul.empty")}</Text>
        )}
      </View>
      <Pressable
        onPress={changeInChat}
        style={styles.row}
        accessibilityRole="button"
        testID="phone-bot-soul-change-in-chat"
      >
        <ThemedMessage size={18} strokeWidth={2} uniProps={foreground} />
        <Text style={styles.rowLabel}>{t("bots.phone.bots.soul.changeInChat")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  page: { gap: 8 },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 4,
  },
  file: { fontSize: 13, fontWeight: "600", color: theme.colors.foregroundMuted },
  document: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    marginTop: 8,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  rowLabel: { fontSize: 15, color: theme.colors.foreground },
  state: { alignItems: "flex-start", gap: 8 },
  muted: { fontSize: 13, color: theme.colors.foregroundMuted },
}));
