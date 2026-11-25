import { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
import { useMemo, type ReactNode } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

type StatusBadgeVariant = "success" | "error" | "muted";

interface StatusBadgeProps {
  label: string;
  variant?: StatusBadgeVariant;
  leading?: ReactNode;
  size?: "sm" | "xs";
}

export function StatusBadge({ label, variant = "muted", leading, size = "sm" }: StatusBadgeProps) {
  const gumloop = useIsGumloopTheme();
  const pillStyle = useMemo(
    () => [
      styles.pill,
      gumloop && styles.gumloopPill,

      size === "xs" && styles.pillXs,
      variant === "success" && styles.pillSuccess,
      variant === "error" && styles.pillError,
      gumloop && variant === "success" && styles.gumloopSuccess,
      gumloop && variant === "error" && styles.gumloopError,
    ],
    [gumloop, size, variant],
  );
  const textStyle = useMemo(
    () => [
      styles.pillText,
      gumloop && styles.gumloopText,
      variant === "success" && styles.pillTextSuccess,
      variant === "error" && styles.pillTextError,
      gumloop && variant === "success" && styles.gumloopSuccessText,
      gumloop && variant === "error" && styles.gumloopErrorText,
    ],
    [gumloop, variant],
  );

  return (
    <View style={pillStyle}>
      {leading}
      <Text style={textStyle}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  gumloopPill: { borderRadius: 4, paddingVertical: 2, borderWidth: 0 },
  gumloopText: { fontSize: 14, fontWeight: "500" },
  gumloopSuccess: { backgroundColor: theme.colors.statusSuccessBackground },
  gumloopError: { backgroundColor: theme.colors.statusDangerBackground },
  gumloopSuccessText: { color: theme.colors.statusSuccess },
  gumloopErrorText: { color: theme.colors.statusDanger },
  pill: {
    flexDirection: "row",
    gap: 6,
    alignItems: "center",
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  pillXs: { paddingHorizontal: theme.spacing[1.5], paddingVertical: 1 },
  pillSuccess: {
    backgroundColor: theme.colors.palette.green[900],
    borderColor: theme.colors.palette.green[800],
  },
  pillError: {
    backgroundColor: theme.colors.palette.red[900],
    borderColor: theme.colors.palette.red[800],
  },
  pillText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  pillTextSuccess: {
    color: theme.colors.palette.green[400],
  },
  pillTextError: {
    color: theme.colors.palette.red[500],
  },
}));
