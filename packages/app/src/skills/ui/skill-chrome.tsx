import { useCallback, useMemo, type ReactNode } from "react";
import {
  Pressable,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { clickUpChipStyles, clickUpTabStyles } from "@/components/clickup-shell/list-styles";
import { useIsClickUpTheme } from "@/components/clickup-shell/use-clickup-chrome";
import type { Theme } from "@/styles/theme";

/**
 * Small building blocks of the Skills screen. They mirror the Marketplace
 * screen's tab, chip and pill chrome (same theme tokens, ClickUp-aware) so the
 * two stores read as one design (spec 22.6 "reuse marketplace tokens").
 */

interface SkillsTabButtonProps {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}

export function SkillsTabButton({ label, active, onPress, testID }: SkillsTabButtonProps) {
  const isClickUp = useIsClickUpTheme();
  const state = useMemo(() => ({ selected: active }), [active]);
  let tabStyle: StyleProp<ViewStyle> = active ? styles.tabActive : styles.tab;
  let textStyle: StyleProp<TextStyle> = active ? styles.tabTextActive : styles.tabText;
  if (isClickUp) {
    tabStyle = active ? clickUpTabStyles.tabActive : clickUpTabStyles.tab;
    textStyle = active ? clickUpTabStyles.textActive : clickUpTabStyles.text;
  }
  return (
    <Pressable
      onPress={onPress}
      style={tabStyle}
      accessibilityRole="button"
      accessibilityState={state}
      testID={testID}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

export function SkillsTabRow({ children }: { children: ReactNode }) {
  const isClickUp = useIsClickUpTheme();
  return <View style={isClickUp ? clickUpTabStyles.row : styles.tabRow}>{children}</View>;
}

interface FilterChipProps<T extends string> {
  value: T;
  label: string;
  active: boolean;
  onSelect: (value: T) => void;
  testID?: string;
}

export function FilterChip<T extends string>({
  value,
  label,
  active,
  onSelect,
  testID,
}: FilterChipProps<T>) {
  const isClickUp = useIsClickUpTheme();
  const handlePress = useCallback(() => onSelect(value), [onSelect, value]);
  const state = useMemo(() => ({ selected: active }), [active]);
  let chipStyle: StyleProp<ViewStyle> = active ? styles.chipActive : styles.chip;
  let textStyle: StyleProp<TextStyle> = active ? styles.chipTextActive : styles.chipText;
  if (isClickUp) {
    chipStyle = active ? clickUpChipStyles.chipActive : clickUpChipStyles.chip;
    textStyle = active ? clickUpChipStyles.textActive : clickUpChipStyles.text;
  }
  return (
    <Pressable
      onPress={handlePress}
      style={chipStyle}
      accessibilityRole="button"
      accessibilityState={state}
      testID={testID}
    >
      <Text style={textStyle}>{label}</Text>
    </Pressable>
  );
}

export interface ChipOption<T extends string> {
  value: T;
  label: string;
}

interface ChipGroupProps<T extends string> {
  label: string;
  options: ChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  testIDPrefix: string;
}

/** A labelled single-select row of chips (wraps on narrow layouts). */
export function ChipGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  testIDPrefix,
}: ChipGroupProps<T>) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.chips}>
        {options.map((option) => (
          <FilterChip
            key={option.value}
            value={option.value}
            label={option.label}
            active={option.value === value}
            onSelect={onChange}
            testID={`${testIDPrefix}-${option.value}`}
          />
        ))}
      </View>
    </View>
  );
}

export type SkillBadgeTone = "muted" | "accent" | "danger" | "success" | "warning";

export function SkillBadge({ label, tone = "muted" }: { label: string; tone?: SkillBadgeTone }) {
  return (
    <View style={tone === "accent" ? styles.badgeAccent : styles.badge}>
      <Text style={badgeTextStyle(tone)} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

function badgeTextStyle(tone: SkillBadgeTone) {
  switch (tone) {
    case "accent":
      return styles.badgeTextAccent;
    case "danger":
      return styles.badgeTextDanger;
    case "success":
      return styles.badgeTextSuccess;
    case "warning":
      return styles.badgeTextWarning;
    default:
      return styles.badgeText;
  }
}

/** Section title + hairline divider used inside sheets. */
export function SectionTitle({ title }: { title: string }) {
  return (
    <View style={styles.sectionHead}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.divider} />
    </View>
  );
}

export function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={2} selectable>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  tabRow: {
    flexDirection: "row",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    alignSelf: "flex-start",
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  tabText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  tabTextActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  group: { gap: theme.spacing[1] },
  groupLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  chip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipActive: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  chipText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  chipTextActive: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  badge: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    maxWidth: "100%",
  },
  badgeAccent: {
    backgroundColor: theme.colors.accent,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    maxWidth: "100%",
  },
  badgeText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  badgeTextAccent: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  badgeTextDanger: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.statusDanger,
  },
  badgeTextSuccess: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.statusSuccess,
  },
  badgeTextWarning: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.statusWarning,
  },
  sectionHead: { gap: theme.spacing[2] },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  divider: { height: theme.borderWidth[1], backgroundColor: theme.colors.border },
  metaRow: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[3] },
  metaLabel: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  metaValue: {
    flex: 1,
    textAlign: "right",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
}));
