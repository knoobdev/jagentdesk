// Small pieces the item surfaces share: the status glyph, the hover reveal, a group header with
// its fold, and the row checkbox. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/items/BotItemStatusIcon.tsx:1-83 and BotPanelSection.tsx
// (BotPanelSectionHeader), drawn with JAgentDesk primitives and Gumloop tokens.
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Check, ChevronDown, ChevronRight, CircleCheck, CircleSlash } from "lucide-react-native";
import type { BotItemStatus } from "@jagentdesk/protocol/bots/types";
import { isNative } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { useTranslation } from "react-i18next";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { botItemStatusName } from "./item-rules";

export const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
export const foregroundColor = (theme: Theme) => ({ color: theme.colors.foreground });
const successColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleSlash = withUnistyles(CircleSlash);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCheck = withUnistyles(Check);

/**
 * An item's status glyph: Planned a dashed ring, In progress a ring (a live worker: a filled ring),
 * Waiting a ring with its lower half filled, Needs you an amber dot (grey once stale or snoozed),
 * Done a check, Canceled a slashed circle. Every glyph sits in the same 10 px box.
 */
export function BotItemStatusIcon({
  status,
  live = false,
  stale = false,
}: {
  status: BotItemStatus;
  live?: boolean;
  stale?: boolean;
}) {
  switch (status) {
    case "needs_you":
      return <View style={[styles.box, styles.dot, stale ? styles.dotStale : styles.dotAsk]} />;
    case "working":
      return (
        <View style={[styles.box, styles.ring, live ? styles.ringLive : styles.ringWorking]} />
      );
    case "waiting":
      return (
        <View style={[styles.box, styles.ring, styles.ringMuted, styles.waiting]}>
          <View style={styles.waitingFill} />
        </View>
      );
    case "planned":
      return <View style={[styles.box, styles.ring, styles.ringMuted, styles.ringDashed]} />;
    case "done":
      return <ThemedCircleCheck size={10} strokeWidth={2.5} uniProps={successColor} />;
    case "canceled":
      return <ThemedCircleSlash size={10} strokeWidth={2.5} uniProps={mutedColor} />;
  }
}

/**
 * Hover on web, always shown on native and compact (CLAUDE.md hover rule). The outer View carries
 * `onPointerEnter`/`onPointerLeave` and nothing else, as docs/hover.md's canonical row does.
 */
export function useHoverReveal() {
  const compact = useIsCompactFormFactor();
  const [hovered, setHovered] = useState(false);
  const onPointerEnter = useCallback(() => setHovered(true), []);
  const onPointerLeave = useCallback(() => setHovered(false), []);
  const handlers = useMemo(
    () => ({ onPointerEnter, onPointerLeave }),
    [onPointerEnter, onPointerLeave],
  );
  return { hovered, revealed: hovered || isNative || compact, handlers };
}

/** A group's title row: the name, its count or "{{count}} new" while folded, the fold, any actions. */
export function BotPanelSectionHeader({
  title,
  summary,
  open,
  onToggle,
  actions,
  testID,
}: {
  title: string;
  summary?: ReactNode;
  open: boolean;
  onToggle?: () => void;
  actions?: ReactNode;
  testID?: string;
}) {
  const Chevron = open ? ThemedChevronDown : ThemedChevronRight;
  const accessibilityState = useMemo(() => ({ expanded: open }), [open]);
  return (
    <View style={styles.header} testID={testID}>
      <Pressable
        style={styles.headerToggle}
        onPress={onToggle}
        disabled={!onToggle}
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={accessibilityState}
      >
        <Text style={styles.headerTitle} numberOfLines={1}>
          {title}
        </Text>
        {summary !== undefined && summary !== null ? (
          <Text style={styles.headerSummary} numberOfLines={1}>
            {summary}
          </Text>
        ) : null}
        {onToggle ? <Chevron size={12} uniProps={mutedColor} /> : null}
      </Pressable>
      {actions}
    </View>
  );
}

export function BotItemCheckbox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  const accessibilityState = useMemo(() => ({ checked }), [checked]);
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      hitSlop={6}
      style={[styles.checkbox, checked && styles.checkboxOn]}
    >
      {checked ? <ThemedCheck size={10} strokeWidth={3} uniProps={checkColor} /> : null}
    </Pressable>
  );
}
const checkColor = (theme: Theme) => ({ color: theme.colors.surface0 });

export const itemStyles = StyleSheet.create((theme: Theme) => ({
  muted: { fontSize: 12, lineHeight: 16, color: theme.colors.foregroundMuted },
  text: { fontSize: 13, lineHeight: 20, color: theme.colors.foreground },
  number: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  linkText: { fontSize: 12, lineHeight: 16, color: theme.colors.foregroundMuted },
  showMore: { alignSelf: "flex-start", paddingVertical: 2, paddingLeft: 32, paddingRight: 8 },
}));

const styles = StyleSheet.create((theme: Theme) => ({
  box: { width: 10, height: 10, flexShrink: 0 },
  dot: { borderRadius: 5 },
  dotAsk: { backgroundColor: theme.colors.palette.amber[500] },
  dotStale: { backgroundColor: theme.colors.foregroundMuted, opacity: 0.6 },
  ring: { borderRadius: 5, borderWidth: 2 },
  ringWorking: { borderColor: theme.colors.palette.amber[500] },
  ringLive: {
    borderColor: theme.colors.palette.amber[500],
    backgroundColor: theme.colors.palette.amber[500],
  },
  ringMuted: { borderColor: theme.colors.foregroundMuted },
  ringDashed: { borderStyle: "dashed" },
  waiting: { overflow: "hidden", justifyContent: "flex-end" },
  waitingFill: { height: 3, backgroundColor: theme.colors.foregroundMuted },
  header: { minHeight: 28, flexDirection: "row", alignItems: "center", gap: 4 },
  headerToggle: {
    flex: 1,
    minWidth: 0,
    minHeight: 28,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    borderRadius: 6,
  },
  headerTitle: { fontSize: 12, fontWeight: "600", color: theme.colors.foregroundMuted },
  headerSummary: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  checkbox: {
    width: 14,
    height: 14,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: theme.colors.foregroundMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxOn: { backgroundColor: theme.colors.foreground, borderColor: theme.colors.foreground },
}));

/** One status of a "Move to" or status menu: its glyph, its name ("Canceled…" asks a reason). */
export function BotItemStatusMenuItem({
  status,
  current,
  onPick,
}: {
  status: BotItemStatus;
  /** The item's own status, checked and not pickable; none for several items. */
  current?: BotItemStatus;
  onPick: (status: BotItemStatus) => void;
}) {
  const { t } = useTranslation();
  const leading = useMemo(() => <BotItemStatusIcon status={status} />, [status]);
  const select = useCallback(() => onPick(status), [onPick, status]);
  return (
    <DropdownMenuItem
      disabled={status === current}
      selected={current !== undefined && status === current}
      showSelectedCheck={current !== undefined}
      leading={leading}
      onSelect={select}
    >
      {status === "canceled" ? t("bots.items.menu.canceled") : botItemStatusName(status, t)}
    </DropdownMenuItem>
  );
}
