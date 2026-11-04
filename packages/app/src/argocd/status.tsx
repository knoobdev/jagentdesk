import type { ComponentType } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  CircleArrowUp,
  CircleCheck,
  CircleDashed,
  CirclePause,
  CircleQuestionMark,
  Ghost,
  Heart,
  HeartCrack,
} from "lucide-react-native";
import type { Theme } from "@/styles/theme";

// Health and sync badges for Argo CD apps and resources (spec 30.3). The icons follow the
// Argo CD web UI (heart, spinner, broken heart, pause, ghost, question; check, arrow-up).

export type ArgoCdTone = "success" | "info" | "danger" | "warning" | "muted";

const HEALTH_TONES: Record<string, ArgoCdTone> = {
  Healthy: "success",
  Progressing: "info",
  Degraded: "danger",
  Suspended: "muted",
  Missing: "warning",
  Unknown: "muted",
};

const SYNC_TONES: Record<string, ArgoCdTone> = {
  Synced: "success",
  OutOfSync: "warning",
  Unknown: "muted",
};

export function healthTone(status: string): ArgoCdTone {
  return HEALTH_TONES[status] ?? "muted";
}

export function syncTone(status: string): ArgoCdTone {
  return SYNC_TONES[status] ?? "muted";
}

export function toneColor(theme: Theme, tone: ArgoCdTone): string {
  switch (tone) {
    case "success":
      return theme.colors.statusSuccess;
    case "info":
      return theme.colors.palette.blue[500];
    case "danger":
      return theme.colors.statusDanger;
    case "warning":
      return theme.colors.statusWarning;
    case "muted":
      return theme.colors.foregroundMuted;
  }
}

export function healthColor(theme: Theme, status: string): string {
  return toneColor(theme, healthTone(status));
}

export function syncColor(theme: Theme, status: string): string {
  return toneColor(theme, syncTone(status));
}

type BadgeIcon = ComponentType<{ size?: number; uniProps?: (theme: Theme) => object }>;

const HEALTH_ICONS: Record<string, BadgeIcon> = {
  Healthy: withUnistyles(Heart),
  Progressing: withUnistyles(CircleDashed),
  Degraded: withUnistyles(HeartCrack),
  Suspended: withUnistyles(CirclePause),
  Missing: withUnistyles(Ghost),
};
const SYNC_ICONS: Record<string, BadgeIcon> = {
  Synced: withUnistyles(CircleCheck),
  OutOfSync: withUnistyles(CircleArrowUp),
};
const UnknownIcon: BadgeIcon = withUnistyles(CircleQuestionMark);

const TONE_ICON_COLORS: Record<ArgoCdTone, (theme: Theme) => { color: string }> = {
  success: (theme) => ({ color: toneColor(theme, "success") }),
  info: (theme) => ({ color: toneColor(theme, "info") }),
  danger: (theme) => ({ color: toneColor(theme, "danger") }),
  warning: (theme) => ({ color: toneColor(theme, "warning") }),
  muted: (theme) => ({ color: toneColor(theme, "muted") }),
};

const TONE_TEXT_STYLE = {
  success: "textSuccess",
  info: "textInfo",
  danger: "textDanger",
  warning: "textWarning",
  muted: "textMuted",
} as const;

interface ToneBadgeProps {
  icon: BadgeIcon;
  tone: ArgoCdTone;
  label: string;
  testID?: string;
}

function ToneBadge({ icon: Icon, tone, label, testID }: ToneBadgeProps) {
  return (
    <View style={styles.badge} testID={testID} accessibilityLabel={label}>
      <Icon size={13} uniProps={TONE_ICON_COLORS[tone]} />
      <Text style={styles[TONE_TEXT_STYLE[tone]]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function ArgoCdHealthBadge({ status, testID }: { status: string; testID?: string }) {
  return (
    <ToneBadge
      icon={HEALTH_ICONS[status] ?? UnknownIcon}
      tone={healthTone(status)}
      label={status || "Unknown"}
      testID={testID}
    />
  );
}

export function ArgoCdSyncBadge({ status, testID }: { status: string; testID?: string }) {
  return (
    <ToneBadge
      icon={SYNC_ICONS[status] ?? UnknownIcon}
      tone={syncTone(status)}
      label={status || "Unknown"}
      testID={testID}
    />
  );
}

const TONE_DOT_STYLE = {
  success: "dotSuccess",
  info: "dotInfo",
  danger: "dotDanger",
  warning: "dotWarning",
  muted: "dotMuted",
} as const;

/** A 6px status dot for dense lists (the sidebar). */
export function ArgoCdToneDot({ tone, label }: { tone: ArgoCdTone; label: string }) {
  return (
    <View
      style={[styles.dot, styles[TONE_DOT_STYLE[tone]]]}
      accessibilityLabel={label}
      accessibilityRole="image"
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  dot: { width: 6, height: 6, borderRadius: theme.borderRadius.full },
  dotSuccess: { backgroundColor: toneColor(theme, "success") },
  dotInfo: { backgroundColor: toneColor(theme, "info") },
  dotDanger: { backgroundColor: toneColor(theme, "danger") },
  dotWarning: { backgroundColor: toneColor(theme, "warning") },
  dotMuted: { backgroundColor: toneColor(theme, "muted") },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  textSuccess: { fontSize: theme.fontSize.xs, color: toneColor(theme, "success") },
  textInfo: { fontSize: theme.fontSize.xs, color: toneColor(theme, "info") },
  textDanger: { fontSize: theme.fontSize.xs, color: toneColor(theme, "danger") },
  textWarning: { fontSize: theme.fontSize.xs, color: toneColor(theme, "warning") },
  textMuted: { fontSize: theme.fontSize.xs, color: toneColor(theme, "muted") },
}));
