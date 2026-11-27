// Snoozing items from a menu: Later today, Tomorrow, Monday, Pick a time…, and Unsnooze while
// snoozed; the item keeps its status and the bot isn't woken. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/items/BotItemSnooze.tsx:1-126 and BotItemSnoozeDialog.tsx
// (the picker's presets plus a custom day and time).
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { isBotItemSnoozed } from "@jagentdesk/protocol/bots/rules";
import type { BotItem } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { Field, FormTextInput } from "@/components/ui/form-field";
import type { Theme } from "@/styles/theme";
import type { BotItemActions } from "./item-actions";
import {
  botItemSnoozePickerPresets,
  botItemSnoozePresetName,
  botItemSnoozePresets,
  formatBotItemSnoozeTime,
  isValidBotItemSnooze,
  parseBotItemSnoozeInput,
} from "./item-rules";

export interface BotItemSnoozing {
  snooze: (items: readonly BotItem[], until_ms: number | null) => void;
  /** Opens the Snooze until dialog for these items. */
  pick: (items: readonly BotItem[]) => void;
  /** The dialog, mounted once beside the menus that open it. */
  dialog: ReactNode;
}

export function useBotItemSnoozing(actions: BotItemActions, done?: () => void): BotItemSnoozing {
  const [picking, setPicking] = useState<readonly BotItem[] | null>(null);
  const snooze = useCallback(
    (items: readonly BotItem[], until_ms: number | null) => {
      void (async () => {
        if (await actions.snooze(items, until_ms)) done?.();
      })();
    },
    [actions, done],
  );
  const close = useCallback(() => setPicking(null), []);
  const picked = useCallback(
    (until_ms: number) => {
      if (picking) snooze(picking, until_ms);
      setPicking(null);
    },
    [picking, snooze],
  );
  return useMemo(
    () => ({
      snooze,
      pick: setPicking,
      dialog: picking !== null ? <BotItemSnoozeDialog onSnooze={picked} onClose={close} /> : null,
    }),
    [snooze, picking, picked, close],
  );
}

export const SNOOZE_PAGE = "snooze";

/** The Snooze page of a menu, reached from a `DropdownMenuSubTrigger id={SNOOZE_PAGE}`. */
export function botItemSnoozePage(
  title: string,
  items: readonly BotItem[],
  snoozing: BotItemSnoozing,
): MenuPageDefinition {
  return {
    id: SNOOZE_PAGE,
    title,
    content: <BotItemSnoozeMenuItems items={items} snoozing={snoozing} />,
  };
}

export function BotItemSnoozeMenuItems({
  items,
  snoozing,
}: {
  items: readonly BotItem[];
  snoozing: BotItemSnoozing;
}) {
  const { t, i18n } = useTranslation();
  // Read as the menu opens; the presets resolve against it.
  const [now] = useState(Date.now);
  const anySnoozed = items.some((item) => isBotItemSnoozed(item, now));
  const pick = useCallback(() => snoozing.pick(items), [snoozing, items]);
  const unsnooze = useCallback(() => snoozing.snooze(items, null), [snoozing, items]);
  return (
    <>
      {botItemSnoozePresets(now).map((preset) => (
        <SnoozePresetItem
          key={preset.id}
          label={botItemSnoozePresetName(preset, t)}
          time={formatBotItemSnoozeTime(preset.at, now, i18n.language)}
          at={preset.at}
          onSnooze={snoozing.snooze}
          items={items}
        />
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={pick}>{t("bots.items.snooze.pick")}</DropdownMenuItem>
      {anySnoozed ? (
        <DropdownMenuItem onSelect={unsnooze}>{t("bots.items.snooze.unsnooze")}</DropdownMenuItem>
      ) : null}
    </>
  );
}

function SnoozePresetItem({
  label,
  time,
  at,
  items,
  onSnooze,
}: {
  label: string;
  time: string;
  at: number;
  items: readonly BotItem[];
  onSnooze: (items: readonly BotItem[], until_ms: number) => void;
}) {
  const trailing = useMemo(() => <Text style={styles.time}>{time}</Text>, [time]);
  const onSelect = useCallback(() => onSnooze(items, at), [onSnooze, items, at]);
  return (
    <DropdownMenuItem onSelect={onSelect} trailing={trailing}>
      {label}
    </DropdownMenuItem>
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** "Snooze until": the picker's presets (In a week too), or a day and time of the owner's own. */
function BotItemSnoozeDialog({
  onSnooze,
  onClose,
}: {
  onSnooze: (until_ms: number) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [now] = useState(Date.now);
  const tomorrow = useMemo(() => new Date(now + 24 * 60 * 60_000), [now]);
  const [date, setDate] = useState(
    `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`,
  );
  const [time, setTime] = useState("09:00");
  const custom = parseBotItemSnoozeInput(date, time);
  const valid = custom !== null && isValidBotItemSnooze(custom, now);
  const header = useMemo(() => ({ title: t("bots.items.snooze.pickTitle") }), [t]);
  const submit = useCallback(() => {
    if (custom !== null && isValidBotItemSnooze(custom, now)) onSnooze(custom);
  }, [custom, now, onSnooze]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="ghost" size="sm" onPress={onClose}>
          {t("bots.items.cancel.keep")}
        </Button>
        <Button
          size="sm"
          variant="default"
          disabled={!valid}
          onPress={submit}
          testID="bot-item-snooze-custom"
        >
          {t("bots.items.snooze.menu")}
        </Button>
      </View>
    ),
    [onClose, t, valid, submit],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      onDismiss={onClose}
      footer={footer}
      desktopMaxWidth={380}
      testID="bot-item-snooze-dialog"
    >
      <View style={styles.presets}>
        {botItemSnoozePickerPresets(now).map((preset) => (
          <SnoozePresetButton
            key={preset.id}
            label={botItemSnoozePresetName(preset, t)}
            time={formatBotItemSnoozeTime(preset.at, now, i18n.language)}
            at={preset.at}
            onSnooze={onSnooze}
          />
        ))}
      </View>
      <Text style={styles.customTitle}>{t("bots.items.snooze.pickCustom")}</Text>
      <View style={styles.customRow}>
        <View style={styles.customField}>
          <Field label={t("bots.jad.items.snoozeDate")}>
            <FormTextInput
              value={date}
              initialValue={date}
              webControlled
              onChangeText={setDate}
              size="sm"
              accessibilityLabel={t("bots.jad.items.snoozeDate")}
              placeholder="YYYY-MM-DD"
              invalid={custom === null}
            />
          </Field>
        </View>
        <View style={styles.customField}>
          <Field label={t("bots.items.snooze.time")}>
            <FormTextInput
              value={time}
              initialValue={time}
              webControlled
              onChangeText={setTime}
              size="sm"
              accessibilityLabel={t("bots.items.snooze.time")}
              placeholder="09:00"
              invalid={custom === null}
              onSubmitEditing={submit}
            />
          </Field>
        </View>
      </View>
      {custom !== null && !valid ? (
        <Text style={styles.error}>{t("bots.jad.items.snoozeRange")}</Text>
      ) : null}
    </AdaptiveModalSheet>
  );
}

function SnoozePresetButton({
  label,
  time,
  at,
  onSnooze,
}: {
  label: string;
  time: string;
  at: number;
  onSnooze: (until_ms: number) => void;
}) {
  const trailing = useMemo(() => <Text style={styles.time}>{time}</Text>, [time]);
  const press = useCallback(() => onSnooze(at), [onSnooze, at]);
  return (
    <Button variant="outline" size="sm" onPress={press} trailing={trailing}>
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  time: { fontSize: 12, color: theme.colors.foregroundMuted, fontVariant: ["tabular-nums"] },
  presets: { gap: 6 },
  customTitle: {
    marginTop: 16,
    marginBottom: 6,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  customRow: { flexDirection: "row", gap: 8 },
  customField: { flex: 1 },
  error: { marginTop: 6, fontSize: 12, color: theme.colors.statusDanger },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 8 },
}));
