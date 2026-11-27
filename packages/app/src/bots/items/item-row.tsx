// One item row: status glyph (a checkbox on hover or while selecting), number, title, and the age;
// hover swaps the age for Done and More (Cancel…, Snooze, Move to) on open items. Ported from Orca
// dfdb4fda (MIT) src/renderer/src/components/bots/items/BotItemRow.tsx:166-330, with spec 37.4.4's
// More menu and 37.3.7's "Waiting for review" line.
import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, MoreHorizontal } from "lucide-react-native";
import { botItemActivityAt, isOpenBotItemStatus } from "@jagentdesk/protocol/bots/rules";
import type { BotItem, BotItemStatus } from "@jagentdesk/protocol/bots/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import type { Theme } from "@/styles/theme";
import {
  BotItemCheckbox,
  BotItemStatusIcon,
  BotItemStatusMenuItem,
  mutedColor,
  useHoverReveal,
} from "./item-parts";
import {
  BOT_ITEM_PICKER_STATUSES,
  formatBotItemNumber,
  formatBotItemSnoozeTime,
  formatShortTimeAgo,
  isBotItemAwaitingReview,
  isBotItemLive,
} from "./item-rules";
import { SNOOZE_PAGE, botItemSnoozePage, type BotItemSnoozing } from "./snooze";

const ThemedCheck = withUnistyles(Check);
const ThemedMore = withUnistyles(MoreHorizontal);
const MOVE_PAGE = "move";

export type BotItemRowAction = "open" | "done" | "cancel";

export const BotItemRow = memo(function BotItemRow({
  item,
  stale = false,
  snoozed = false,
  unseen,
  selected,
  selecting,
  now,
  snoozing,
  onSelect,
  onAction,
  onMove,
}: {
  item: BotItem;
  stale?: boolean;
  /** In the Snoozed group: grey like Stale, its wake time where the age goes. */
  snoozed?: boolean;
  unseen: boolean;
  selected: boolean;
  /** Some row is checked: every row shows its checkbox. */
  selecting: boolean;
  now: number;
  snoozing: BotItemSnoozing;
  onSelect: (item: BotItem) => void;
  onAction: (item: BotItem, action: BotItemRowAction) => void;
  onMove: (item: BotItem, status: BotItemStatus) => void;
}) {
  const { t, i18n } = useTranslation();
  const { revealed, hovered, handlers } = useHoverReveal();
  const closed = !isOpenBotItemStatus(item.status);
  const showCheckbox = selecting || selected || hovered;
  const awaitingReview = isBotItemAwaitingReview(item);
  const open = useCallback(() => onAction(item, "open"), [item, onAction]);
  const done = useCallback(() => onAction(item, "done"), [item, onAction]);
  const cancel = useCallback(() => onAction(item, "cancel"), [item, onAction]);
  const toggle = useCallback(() => onSelect(item), [item, onSelect]);
  const items = useMemo(() => [item], [item]);
  const pickStatus = useCallback(
    (status: BotItemStatus) => (status === "canceled" ? cancel() : onMove(item, status)),
    [cancel, onMove, item],
  );
  const pages = useMemo<MenuPageDefinition[]>(
    () => [
      botItemSnoozePage(t("bots.items.snooze.menu"), items, snoozing),
      {
        id: MOVE_PAGE,
        title: t("bots.items.pill.moveTo"),
        content: (
          <>
            {BOT_ITEM_PICKER_STATUSES.map((status) => (
              <BotItemStatusMenuItem
                key={status}
                status={status}
                current={item.status}
                onPick={pickStatus}
              />
            ))}
          </>
        ),
      },
    ],
    [t, items, snoozing, item.status, pickStatus],
  );
  const age =
    snoozed && item.snoozedUntil_ms !== undefined
      ? t("bots.items.snooze.rowUntil", {
          when: formatBotItemSnoozeTime(item.snoozedUntil_ms, now, i18n.language),
        })
      : formatShortTimeAgo(botItemActivityAt(item, now), now);
  const actionsShown = revealed && !closed;
  return (
    <View
      style={styles.hoverTarget}
      {...handlers}
      testID={`bot-item-row-${item.number ?? item.id}`}
    >
      <View style={[styles.row, (selected || hovered) && styles.rowActive]}>
        <View style={styles.lead}>
          {showCheckbox ? (
            <BotItemCheckbox
              checked={selected}
              label={t("bots.items.row.select", { title: item.title })}
              onToggle={toggle}
            />
          ) : (
            <BotItemStatusIcon
              status={item.status}
              live={isBotItemLive(item)}
              stale={stale || snoozed}
            />
          )}
        </View>
        <Pressable
          style={styles.body}
          onPress={open}
          accessibilityRole="button"
          accessibilityLabel={item.title}
        >
          {item.number !== undefined ? (
            <Text style={styles.number}>{formatBotItemNumber(item.number)}</Text>
          ) : null}
          <View style={styles.titleColumn}>
            <Text style={[styles.title, closed && styles.titleClosed]} numberOfLines={1}>
              {item.title}
            </Text>
            {awaitingReview ? (
              <Text style={styles.second} numberOfLines={1} testID="bot-item-waiting-review">
                {t("bots.jad.items.waitingForReview")}
              </Text>
            ) : null}
          </View>
          {actionsShown ? null : (
            <View style={styles.meta}>
              {unseen ? <View style={styles.unseen} /> : null}
              <Text style={styles.age}>{age}</Text>
            </View>
          )}
        </Pressable>
        {actionsShown ? (
          <View style={styles.actions}>
            <Pressable
              onPress={done}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel={t("bots.items.row.done")}
              testID="bot-item-row-done"
            >
              <ThemedCheck size={14} uniProps={mutedColor} />
            </Pressable>
            <DropdownMenu>
              <DropdownMenuTrigger
                style={styles.iconButton}
                accessibilityLabel={t("bots.items.row.more")}
                testID="bot-item-row-more"
              >
                <ThemedMore size={14} uniProps={mutedColor} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" width={220} pages={pages}>
                <DropdownMenuItem onSelect={cancel}>{t("bots.items.menu.cancel")}</DropdownMenuItem>
                <DropdownMenuSubTrigger id={SNOOZE_PAGE}>
                  {t("bots.items.snooze.menu")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubTrigger id={MOVE_PAGE}>
                  {t("bots.items.pill.moveTo")}
                </DropdownMenuSubTrigger>
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        ) : null}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme: Theme) => ({
  hoverTarget: { position: "relative" },
  row: {
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  rowActive: { backgroundColor: theme.colors.surface2 },
  lead: { width: 16, height: 20, alignItems: "center", justifyContent: "center" },
  body: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "flex-start", gap: 6 },
  number: {
    minWidth: 28,
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  titleColumn: { flex: 1, minWidth: 0 },
  title: { fontSize: 13, lineHeight: 20, color: theme.colors.foreground },
  titleClosed: { color: theme.colors.foregroundMuted },
  second: { fontSize: 12, lineHeight: 16, color: theme.colors.statusWarning },
  meta: { flexDirection: "row", alignItems: "center", gap: 8, height: 20 },
  unseen: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.foreground },
  age: { fontSize: 12, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  actions: { flexDirection: "row", alignItems: "center", gap: 2 },
  iconButton: {
    width: 24,
    height: 24,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
  },
}));
