// Item changes in the Home Chat (spec 37.4.2), ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/native-chat/bot-items/NativeChatBotItemNoteRow.tsx and the status row
// it sits on (messages/events/NativeChatEventRow.tsx, native-chat-inline-chip.ts): icon · words on
// one line, item names as chips that open the item (a one-item line opens it from anywhere on it),
// chips cut short before the words do, a bulk line shows a few chips then "+N more", and a run of
// changes to one item folds into one row that opens into each change.
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronRight, ListTodo } from "lucide-react-native";
import type { Bot, BotItem, BotMessage } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { stripBotEnvelope } from "@/bots/envelope";
import { useBotPanelStore } from "@/bots/panel-store";
import { BotItemStatusIcon } from "@/bots/items/item-parts";
import { itemStatusKey } from "./note-text";
import {
  botItemNoteLine,
  botItemNoteLineLabel,
  botItemNoteRunLine,
  type BotItemNoteLine,
} from "./bot-item-note-lines";

/** Chips a bulk line shows before "+N more". */
const CHIPS_SHOWN = 3;

const ThemedListTodo = withUnistyles(ListTodo);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function openItem(botId: string, itemId: string): void {
  useBotPanelStore.getState().openItem(botId, itemId);
}

function ItemChip({ botId, item }: { botId: string; item: BotItem }) {
  const { t } = useTranslation();
  const open = useCallback(() => openItem(botId, item.id), [botId, item.id]);
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      // The glyph alone shows the status, so the chip says it.
      accessibilityLabel={t("bots.items.chat.chipLabel", {
        title: item.title,
        status: t(itemStatusKey(item.status)),
      })}
      style={styles.chip}
      testID={`bot-note-item-${item.id}`}
    >
      <BotItemStatusIcon status={item.status} />
      <Text style={styles.chipText} numberOfLines={1}>
        {item.title}
      </Text>
    </Pressable>
  );
}

/** The line's parts side by side on its one line; the chips give way first. */
function LineWords({ botId, line }: { botId: string; line: BotItemNoteLine }) {
  const { t } = useTranslation();
  const [allChips, setAllChips] = useState(false);
  const showAll = useCallback(() => setAllChips(true), []);
  const chips = allChips ? line.items : line.items.slice(0, CHIPS_SHOWN);
  const hiddenChips = line.items.length - chips.length;
  return (
    <>
      {line.lead ? (
        <Text style={styles.words} numberOfLines={1}>
          {line.lead}
        </Text>
      ) : null}
      {line.fallback !== undefined ? (
        <Text style={[styles.words, styles.share]} numberOfLines={1}>
          {line.fallback}
        </Text>
      ) : (
        chips.map((item) => <ItemChip key={item.id} botId={botId} item={item} />)
      )}
      {hiddenChips > 0 ? (
        <Pressable onPress={showAll} accessibilityRole="button" style={styles.more}>
          <Text style={styles.moreText} numberOfLines={1}>
            {t("bots.items.chat.moreItems", { count: hiddenChips })}
          </Text>
        </Pressable>
      ) : null}
      {line.tail ? (
        <Text style={styles.words} numberOfLines={1}>
          {line.tail}
        </Text>
      ) : null}
      {line.detail ? (
        <Text style={styles.words} numberOfLines={1}>
          {line.detail}
        </Text>
      ) : null}
    </>
  );
}

/** The chat's status row: a 14 px mark, then the words on one line. */
function EventRow({
  label,
  onPress,
  open,
  children,
  testID,
}: {
  label: string;
  onPress?: () => void;
  /** Set on a row that opens details: the chevron turns with it. */
  open?: boolean;
  children: React.ReactNode;
  testID?: string;
}) {
  const state = useMemo(() => (open === undefined ? undefined : { expanded: open }), [open]);
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={label}
      accessibilityState={state}
      style={styles.row}
      testID={testID}
    >
      <View style={styles.icon}>
        <ThemedListTodo size={14} uniProps={mutedColor} />
      </View>
      <View style={styles.line}>{children}</View>
      {open === undefined ? null : (
        <View style={open ? styles.chevronOpen : styles.chevron}>
          <ThemedChevronRight size={14} uniProps={mutedColor} />
        </View>
      )}
    </Pressable>
  );
}

export function BotItemNoteRow({
  bot,
  message,
  items,
}: {
  bot: Bot;
  message: BotMessage;
  items: ReadonlyMap<string, BotItem>;
}) {
  const { t } = useTranslation();
  const line = useMemo(
    () =>
      message.note
        ? botItemNoteLine({
            note: message.note,
            items,
            fallback: stripBotEnvelope(message.text),
            t,
          })
        : null,
    [items, message.note, message.text, t],
  );
  // A one-item line opens its item from anywhere on it; the chip stays the precise target.
  const soleId = line?.items.length === 1 ? line.items[0]?.id : undefined;
  const openSole = useCallback(() => {
    if (soleId) openItem(bot.id, soleId);
  }, [bot.id, soleId]);
  if (!line) return null;
  return (
    <EventRow
      label={botItemNoteLineLabel(line)}
      onPress={soleId ? openSole : undefined}
      testID={`bot-note-${message.id}`}
    >
      <LineWords botId={bot.id} line={line} />
    </EventRow>
  );
}

/** A run of changes to one item: its last change and the count, opening into each change. */
export function BotItemNoteRunRow({
  bot,
  messages,
  items,
}: {
  bot: Bot;
  messages: readonly BotMessage[];
  items: ReadonlyMap<string, BotItem>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((current) => !current), []);
  const last = messages.at(-1);
  const notes = messages.flatMap((message) => (message.note ? [message.note] : []));
  if (!last || notes.length === 0) return null;
  const line = botItemNoteRunLine({
    notes,
    items,
    fallback: stripBotEnvelope(last.text),
    t,
  });
  return (
    <View testID={`bot-note-run-${messages[0]?.id ?? last.id}`}>
      <EventRow label={botItemNoteLineLabel(line)} onPress={toggle} open={open}>
        <LineWords botId={bot.id} line={line} />
      </EventRow>
      {open ? (
        <View style={styles.details}>
          {messages.map((message) => (
            <BotItemNoteRow key={message.id} bot={bot} message={message} items={items} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A Look around / Tidy memory run on the same row type, opening its conversation. */
export function BotRunNoteRow({
  label,
  failed,
  running,
  onPress,
  testID,
}: {
  label: string;
  failed: boolean;
  running: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : undefined}
      style={styles.row}
      testID={testID}
    >
      {running ? (
        <View style={styles.icon}>
          <View style={styles.runningDot} />
        </View>
      ) : null}
      <Text style={[styles.words, styles.share, failed && styles.failed]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

// Orca's event row: text-sm leading-relaxed in the chat's faint foreground, min-h-6, gap-1.5, a
// 14 px mark; chips text-xs leading-5 on a quiet fill (spec 38 §2 tokens).
const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 24,
  },
  icon: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  line: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "nowrap",
    gap: 4,
    overflow: "hidden",
  },
  words: {
    flexShrink: 0,
    fontSize: 14,
    lineHeight: 22,
    color: theme.colors.foregroundMuted,
  },
  /** Gives way before the chips: its width while it fits, then what is left. */
  share: {
    flexShrink: 1,
    minWidth: 0,
  },
  failed: { color: theme.colors.statusDanger },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 1,
    // A few letters stay when the chip cuts short.
    minWidth: 64,
    paddingHorizontal: 6,
    borderRadius: 6,
    backgroundColor: theme.colors.surface2,
  },
  chipText: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  more: { flexShrink: 0 },
  moreText: { fontSize: 12, lineHeight: 20, color: theme.colors.foreground },
  chevron: { flexShrink: 0 },
  chevronOpen: { flexShrink: 0, transform: [{ rotate: "90deg" }] },
  details: {
    marginLeft: 20,
    marginTop: 2,
    gap: 2,
  },
  runningDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.palette.amber[500],
  },
}));
