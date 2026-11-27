// One row of the phone's Items tab: its status glyph, `#N` and title, the bot's question under a Needs
// you row, the unseen dot and its age (a snoozed row's wake time). Tap opens the item's page; long-press
// opens its actions. Ported from Orca dfdb4fda (MIT) mobile/src/bots/items/MobileBotItemRow.tsx:24-99,
// on a 44 px touch row (spec 38.5).
import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { BotItem } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { BotItemStatusIcon } from "@/bots/items/item-parts";
import {
  botItemStatusName,
  formatBotItemNumber,
  formatBotItemSnoozeTime,
  formatShortTimeAgo,
  isBotItemLive,
} from "@/bots/items/item-rules";

export const PhoneBotItemRow = memo(function PhoneBotItemRow({
  item,
  stale,
  snoozed,
  unseen,
  now,
  disabled,
  onOpen,
  onActions,
}: {
  item: BotItem;
  stale: boolean;
  /** In the Snoozed group: grey like Stale, its wake time where the age goes. */
  snoozed: boolean;
  unseen: boolean;
  now: number;
  disabled: boolean;
  onOpen: (item: BotItem) => void;
  onActions: (item: BotItem) => void;
}) {
  const { t, i18n } = useTranslation();
  const open = useCallback(() => onOpen(item), [onOpen, item]);
  const actions = useCallback(() => onActions(item), [onActions, item]);
  // Only Needs you has a second line, the bot's question.
  const question =
    !stale && !snoozed && item.status === "needs_you" ? item.question?.text : undefined;
  const at = item.lastActivityAt_ms ?? item.updatedAt_ms ?? item.createdAt_ms;
  const age =
    snoozed && item.snoozedUntil_ms
      ? t("bots.phone.bots.items.snooze.rowUntil", {
          when: formatBotItemSnoozeTime(item.snoozedUntil_ms, now, i18n.language),
        })
      : formatShortTimeAgo(at, now);
  const number = formatBotItemNumber(item.number);
  const rowStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [styles.row, pressed && styles.pressed],
    [],
  );
  const titleStyle = useMemo(() => [styles.title, stale && styles.titleStale], [stale]);
  return (
    <Pressable
      onPress={open}
      onLongPress={actions}
      delayLongPress={350}
      disabled={disabled}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={`${number} ${item.title}, ${botItemStatusName(item.status, t)}`}
      accessibilityHint={t("bots.items.row.more")}
      testID={`phone-bot-item-${item.id}`}
    >
      <View style={styles.lead}>
        <BotItemStatusIcon
          status={item.status}
          live={isBotItemLive(item)}
          stale={stale || snoozed}
        />
      </View>
      <View style={styles.body}>
        <Text style={titleStyle} numberOfLines={1}>
          {number ? <Text style={styles.number}>{`${number} `}</Text> : null}
          {item.title}
        </Text>
        {question ? (
          <Text style={styles.question} numberOfLines={1}>
            {question}
          </Text>
        ) : null}
      </View>
      <View style={styles.trailing}>
        {unseen ? <View style={styles.unseen} /> : null}
        <Text style={styles.age}>{age}</Text>
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create((theme: Theme) => ({
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 8,
  },
  pressed: { backgroundColor: theme.colors.surface2 },
  lead: { width: 16, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 15, lineHeight: 20, color: theme.colors.foreground },
  titleStale: { color: theme.colors.foregroundMuted },
  number: { color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  question: { fontSize: 13, lineHeight: 18, color: theme.colors.foregroundMuted },
  trailing: { flexDirection: "row", alignItems: "center", gap: 8 },
  unseen: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.foreground },
  age: { fontSize: 12, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
}));
