import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

/**
 * Shared list geometry and muted column headers for Gumloop screens.
 */
export const gumloopListStyles = StyleSheet.create((theme: Theme) => ({
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
    marginBottom: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  groupPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: 0,
    backgroundColor: "transparent",
  },
  groupPillText: {
    fontSize: 14,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.3,
    textTransform: "none",
    color: theme.colors.foreground,
  },
  groupCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  row: {
    minHeight: 72,
    borderBottomWidth: 1,
    borderBottomColor: theme.chrome.cardBorder,
  },
  columnHeader: {
    fontSize: 16,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    textTransform: "none",
    letterSpacing: 0,
  },
}));

/** Segmented filters share a neutral tray and a raised selected segment. */
export const gumloopTabStyles = StyleSheet.create((theme: Theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    padding: 4,
    borderRadius: 12,
    backgroundColor: theme.colors.surface2,
  },
  tab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  tabActive: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: theme.colors.surface1,
    ...theme.shadow.sm,
  },
  text: { fontSize: 16, color: theme.colors.foregroundMuted },
  textActive: { fontSize: 16, fontWeight: "500", color: theme.colors.foreground },
}));

/**
 * Filters use neutral surfaces and the theme's selected treatment.
 */
export const gumloopChipStyles = StyleSheet.create((theme: Theme) => ({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.chrome.outlineBorder,
    backgroundColor: theme.chrome.outlineBackground,
  },
  chipActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.chrome.chipActiveForeground,
    backgroundColor: theme.chrome.chipActiveBackground,
  },
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  textActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.chrome.chipActiveForeground,
  },
}));
