// The settings view's groups and rows: a card of 44 px rows under a small heading, with an optional
// foot line (spec 37.4.8, cards per 38.4.6). Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/settings-view/BotSettingsRows.tsx:1-195.
import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { Children, isValidElement, useCallback, useMemo } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import type { BotSettingsPage } from "@/bots/panel-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

/** True while the bot's host is unreachable: rows still open their page; their controls are off. */
export const SettingsControlsOffContext = createContext(false);

export function useSettingsControlsOff(): boolean {
  return useContext(SettingsControlsOffContext);
}

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedChevron = withUnistyles(ChevronRight);

export function BotSettingsGroup({
  title,
  aside,
  foot,
  children,
  testID,
}: {
  title?: string;
  /** Muted text at the heading's end, such as a count. */
  aside?: string | null;
  foot?: string;
  children: ReactNode;
  testID?: string;
}) {
  const rows = Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.group} testID={testID}>
      {title || aside ? (
        <View style={styles.heading}>
          <Text style={styles.headingText} numberOfLines={1}>
            {title ?? ""}
          </Text>
          {aside ? <Text style={styles.aside}>{aside}</Text> : null}
        </View>
      ) : null}
      <View style={settingsStyles.card}>
        {rows.map((child, index) => (
          <View
            key={isValidElement(child) && child.key !== null ? child.key : index}
            style={index ? settingsStyles.rowBorder : undefined}
          >
            {child}
          </View>
        ))}
      </View>
      {foot ? <Text style={styles.foot}>{foot}</Text> : null}
    </View>
  );
}

export interface BotSettingsRowProps {
  icon?: ComponentType<{ size: number; color: string }>;
  title: string;
  detail?: string | null;
  /** A short muted value at the row's end ("4h", "Only you"). */
  value?: string | null;
  /** The control at the row's end (a switch, a select). Without one, `onOpen` draws a chevron. */
  children?: ReactNode;
  onOpen?: () => void;
  /** Opens this settings page through `onOpenPage`, so callers pass no closure. */
  page?: BotSettingsPage;
  onOpenPage?: (page: BotSettingsPage) => void;
  muted?: boolean;
  danger?: boolean;
  testID?: string;
}

/** One row: opens a page when it has `onOpen`; otherwise holds its control. */
export function BotSettingsRow({
  icon,
  title,
  detail,
  value,
  children: end,
  onOpen: onOpenProp,
  page,
  onOpenPage,
  muted,
  danger,
  testID,
}: BotSettingsRowProps) {
  const controlsOff = useSettingsControlsOff();
  const openPage = useCallback(() => {
    if (page && onOpenPage) onOpenPage(page);
    else onOpenProp?.();
  }, [onOpenPage, onOpenProp, page]);
  const onOpen = onOpenProp || (page && onOpenPage) ? openPage : undefined;
  const Icon = useMemo(() => (icon ? withUnistyles(icon) : null), [icon]);
  const pressStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (hovered || pressed) && styles.hovered,
    ],
    [],
  );
  const text = (
    <>
      {Icon ? <Icon size={16} uniProps={mutedIcon} /> : null}
      <View style={styles.text}>
        <Text
          style={[styles.title, muted && styles.mutedTitle, danger && styles.dangerTitle]}
          numberOfLines={1}
        >
          {title}
        </Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      </View>
      {value ? (
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
      ) : null}
    </>
  );
  if (onOpen && !end) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={value ? `${title}, ${value}` : title}
        onPress={onOpen}
        style={pressStyle}
        testID={testID}
      >
        {text}
        <ThemedChevron size={14} uniProps={mutedIcon} />
      </Pressable>
    );
  }
  return (
    <View style={styles.row} testID={testID}>
      {onOpen ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={title}
          onPress={onOpen}
          style={styles.openText}
        >
          {text}
        </Pressable>
      ) : (
        text
      )}
      {end ? (
        <View style={styles.end} pointerEvents={controlsOff ? "none" : "auto"}>
          {end}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[1.5], minWidth: 0 },
  heading: {
    minHeight: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
  },
  headingText: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontWeight: "500",
    color: theme.colors.foregroundMuted,
  },
  aside: { fontSize: 11, color: theme.colors.foregroundMuted },
  foot: {
    paddingHorizontal: theme.spacing[3],
    fontSize: theme.fontSize.xs,
    lineHeight: 17,
    color: theme.colors.foregroundMuted,
  },
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: theme.spacing[2],
    paddingLeft: theme.spacing[3],
    paddingRight: 10,
  },
  openText: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10 },
  hovered: { backgroundColor: theme.colors.surface2 },
  text: { flex: 1, minWidth: 0 },
  title: {
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  mutedTitle: { color: theme.colors.foregroundMuted },
  dangerTitle: { color: theme.colors.statusDanger },
  detail: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
    marginTop: 2,
  },
  value: {
    flexShrink: 1,
    maxWidth: "45%",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  end: { flexShrink: 0, flexDirection: "row", alignItems: "center", gap: theme.spacing[1.5] },
}));
