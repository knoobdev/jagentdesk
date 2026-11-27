// A row's long-press actions on a phone (spec 37.6: "Done", "Snooze", "Cancel…", "Move to"), the
// desktop's hover ✓ and ⋯ as a sheet. Snooze and Move to replace the list in place with Back, as
// docs/menus.md has a sheet's pages; Cancel… asks its reason in the cancel sheet.
// Ported from Orca dfdb4fda (MIT) mobile/src/bots/items/MobileBotItemSheets.tsx:1-309 and
// MobileBotItemSnoozeSheets.tsx (presets, Pick a time…, Unsnooze).
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, ChevronRight, CircleCheck, CircleSlash, Clock, Shuffle } from "lucide-react-native";
import { isBotItemSnoozed, isOpenBotItemStatus } from "@jagentdesk/protocol/bots/rules";
import type { BotItem, BotItemStatus } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import type { Theme } from "@/styles/theme";
import { BotItemStatusIcon } from "@/bots/items/item-parts";
import {
  BOT_ITEM_PICKER_STATUSES,
  botItemSnoozePresetName,
  botItemSnoozePresets,
  botItemStatusName,
  formatBotItemNumber,
  formatBotItemSnoozeTime,
} from "@/bots/items/item-rules";

const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedCheck = withUnistyles(Check);
const ThemedChevron = withUnistyles(ChevronRight);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleSlash = withUnistyles(CircleSlash);
const ThemedClock = withUnistyles(Clock);
const ThemedShuffle = withUnistyles(Shuffle);
const DONE_ICON = <ThemedCircleCheck size={18} uniProps={foreground} />;
const SNOOZE_ICON = <ThemedClock size={18} uniProps={foreground} />;
const CANCEL_ICON = <ThemedCircleSlash size={18} uniProps={foreground} />;
const MOVE_ICON = <ThemedShuffle size={18} uniProps={foreground} />;

type Page = "actions" | "snooze" | "move";

export function PhoneBotItemSheet({
  items,
  onClose,
  onDone,
  onMove,
  onSnooze,
  onPickSnooze,
  onCancel,
}: {
  /** The row long-pressed (or the selection); null while closed. */
  items: readonly BotItem[] | null;
  onClose: () => void;
  onDone: (items: readonly BotItem[]) => void;
  onMove: (items: readonly BotItem[], status: BotItemStatus) => void;
  onSnooze: (items: readonly BotItem[], until_ms: number | null) => void;
  /** "Pick a time…": the Snooze until sheet. */
  onPickSnooze: (items: readonly BotItem[]) => void;
  /** "Cancel…": the reason sheet. */
  onCancel: (items: readonly BotItem[]) => void;
}) {
  if (!items || items.length === 0) return null;
  return (
    <ItemSheet
      items={items}
      onClose={onClose}
      onDone={onDone}
      onMove={onMove}
      onSnooze={onSnooze}
      onPickSnooze={onPickSnooze}
      onCancel={onCancel}
    />
  );
}

function ItemSheet({
  items,
  onClose,
  onDone,
  onMove,
  onSnooze,
  onPickSnooze,
  onCancel,
}: {
  items: readonly BotItem[];
  onClose: () => void;
  onDone: (items: readonly BotItem[]) => void;
  onMove: (items: readonly BotItem[], status: BotItemStatus) => void;
  onSnooze: (items: readonly BotItem[], until_ms: number | null) => void;
  onPickSnooze: (items: readonly BotItem[]) => void;
  onCancel: (items: readonly BotItem[]) => void;
}) {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState<Page>("actions");
  // Read as the sheet opens; the presets resolve against it.
  const [now] = useState(Date.now);
  const one = items.length === 1 ? items[0] : undefined;
  const open = items.some((item) => isOpenBotItemStatus(item.status));
  const snoozed = items.some((item) => isBotItemSnoozed(item, now));
  const toActions = useCallback(() => setPage("actions"), []);
  const header = useMemo<SheetHeader>(() => {
    const title = one
      ? `${formatBotItemNumber(one.number)} ${one.title}`.trim()
      : t("bots.phone.bots.items.selected", { count: items.length });
    if (page === "snooze")
      return { title: t("bots.items.snooze.menu"), back: { onPress: toActions, label: title } };
    if (page === "move")
      return { title: t("bots.items.pill.moveTo"), back: { onPress: toActions, label: title } };
    return { title };
  }, [one, items.length, page, t, toActions]);
  const select = useCallback(
    (id: string) => {
      if (id === "page:snooze") return setPage("snooze");
      if (id === "page:move") return setPage("move");
      onClose();
      if (id === "done") onDone(items);
      else if (id === "cancel" || id === "move:canceled") onCancel(items);
      else if (id === "snooze:pick") onPickSnooze(items);
      else if (id === "snooze:off") onSnooze(items, null);
      else if (id.startsWith("snooze:")) {
        const preset = botItemSnoozePresets(now).find((entry) => `snooze:${entry.id}` === id);
        if (preset) onSnooze(items, preset.at);
      } else if (id.startsWith("move:")) onMove(items, id.slice("move:".length) as BotItemStatus);
    },
    [items, now, onCancel, onClose, onDone, onMove, onPickSnooze, onSnooze],
  );
  let body;
  if (page === "snooze")
    body = (
      <>
        {botItemSnoozePresets(now).map((preset) => (
          <SheetRow
            key={preset.id}
            id={`snooze:${preset.id}`}
            label={botItemSnoozePresetName(preset, t)}
            detail={formatBotItemSnoozeTime(preset.at, now, i18n.language)}
            onSelect={select}
          />
        ))}
        <SheetRow id="snooze:pick" label={t("bots.items.snooze.pick")} onSelect={select} />
        {snoozed ? (
          <SheetRow id="snooze:off" label={t("bots.items.snooze.unsnooze")} onSelect={select} />
        ) : null}
      </>
    );
  else if (page === "move")
    body = BOT_ITEM_PICKER_STATUSES.map((status) => (
      <SheetRow
        key={status}
        id={`move:${status}`}
        label={botItemStatusName(status, t)}
        status={status}
        checked={one?.status === status}
        onSelect={select}
      />
    ));
  else
    body = (
      <>
        {open ? (
          <SheetRow id="done" icon={DONE_ICON} label={t("bots.items.row.done")} onSelect={select} />
        ) : null}
        <SheetRow
          id="page:snooze"
          icon={SNOOZE_ICON}
          label={t("bots.items.snooze.menu")}
          navigates
          onSelect={select}
        />
        {open ? (
          <SheetRow
            id="cancel"
            icon={CANCEL_ICON}
            label={t("bots.items.menu.cancel")}
            onSelect={select}
          />
        ) : null}
        <SheetRow
          id="page:move"
          icon={MOVE_ICON}
          label={t("bots.items.pill.moveTo")}
          navigates
          onSelect={select}
        />
      </>
    );
  return (
    <AdaptiveModalSheet visible onClose={onClose} header={header} testID="phone-bot-item-actions">
      <View style={styles.list}>{body}</View>
    </AdaptiveModalSheet>
  );
}

function SheetRow({
  id,
  icon,
  status,
  label,
  detail,
  checked,
  navigates,
  onSelect,
}: {
  id: string;
  /** A module-level icon element. */
  icon?: ReactNode;
  /** Move to's rows lead with the status glyph. */
  status?: BotItemStatus;
  label: string;
  detail?: string;
  checked?: boolean;
  navigates?: boolean;
  onSelect: (id: string) => void;
}) {
  const press = useCallback(() => onSelect(id), [onSelect, id]);
  const style = useCallback(
    ({ pressed }: { pressed: boolean }) => [styles.row, pressed && styles.rowPressed],
    [],
  );
  return (
    <Pressable
      onPress={press}
      style={style}
      accessibilityRole="button"
      testID={`phone-item-sheet-${id.replace(":", "-")}`}
    >
      <View style={styles.lead}>{status ? <BotItemStatusIcon status={status} /> : icon}</View>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      {checked ? <ThemedCheck size={16} uniProps={foreground} /> : null}
      {navigates ? <ThemedChevron size={16} uniProps={muted} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  list: { paddingBottom: 8 },
  row: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 4,
    borderRadius: 10,
  },
  rowPressed: { backgroundColor: theme.colors.surface2 },
  lead: { width: 20, alignItems: "center", justifyContent: "center" },
  label: { flex: 1, fontSize: 16, color: theme.colors.foreground },
  detail: { fontSize: 13, color: theme.colors.foregroundMuted },
}));
