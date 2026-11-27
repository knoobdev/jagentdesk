// The bar under the list while rows are checked: "N selected · Move to · ×". Move to also snoozes
// the open ones. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/items/BotItemSelectionPill.tsx:1-87.
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronUp, X } from "lucide-react-native";
import { isOpenBotItemStatus } from "@jagentdesk/protocol/bots/rules";
import type { BotItem, BotItemStatus } from "@jagentdesk/protocol/bots/types";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Theme } from "@/styles/theme";
import { BotItemStatusMenuItem, foregroundColor, mutedColor } from "./item-parts";
import { BOT_ITEM_PICKER_STATUSES } from "./item-rules";
import { SNOOZE_PAGE, botItemSnoozePage, type BotItemSnoozing } from "./snooze";

const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedX = withUnistyles(X);

export function BotItemSelectionPill({
  items,
  snoozing,
  onMove,
  onClear,
}: {
  items: readonly BotItem[];
  snoozing: BotItemSnoozing;
  /** Canceled asks for a reason first. */
  onMove: (status: BotItemStatus) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const count = items.length;
  const open = useMemo(() => items.filter((item) => isOpenBotItemStatus(item.status)), [items]);
  const pages = useMemo(
    () => (open.length > 0 ? [botItemSnoozePage(t("bots.items.snooze.menu"), open, snoozing)] : []),
    [open, snoozing, t],
  );
  return (
    <View style={styles.pill} testID="bot-items-selection">
      <Text style={styles.count}>{t("bots.items.selected", { count })}</Text>
      <DropdownMenu>
        <DropdownMenuTrigger style={styles.move} accessibilityLabel={t("bots.items.pill.moveTo")}>
          <Text style={styles.moveText}>{t("bots.items.pill.moveTo")}</Text>
          <ThemedChevronUp size={12} uniProps={mutedColor} />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center" width={220} pages={pages}>
          <DropdownMenuLabel>{t("bots.items.pill.moveCount", { count })}</DropdownMenuLabel>
          {BOT_ITEM_PICKER_STATUSES.map((status) => (
            <BotItemStatusMenuItem key={status} status={status} onPick={onMove} />
          ))}
          {open.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuSubTrigger id={SNOOZE_PAGE}>
                {t("bots.items.snooze.menu")}
              </DropdownMenuSubTrigger>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      <Pressable
        onPress={onClear}
        style={styles.clear}
        accessibilityRole="button"
        accessibilityLabel={t("bots.items.pill.clear")}
        testID="bot-items-selection-clear"
      >
        <ThemedX size={14} uniProps={foregroundColor} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  pill: {
    alignSelf: "center",
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingLeft: 12,
    paddingRight: 4,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  count: {
    fontSize: 12,
    fontWeight: "500",
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
  move: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    height: 28,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  moveText: { fontSize: 12, color: theme.colors.foreground },
  clear: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
  },
}));
