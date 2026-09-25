import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

/**
 * ClickUp's list anatomy, shared by list screens while a ClickUp theme is active: a bordered
 * uppercase group pill ("OPEN 10" in ClickUp), sentence-case gray column headers, and rows
 * separated by a hairline divider instead of floating on the page.
 */
export const clickUpListStyles = StyleSheet.create((theme: Theme) => ({
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
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.chrome.outlineBorder,
    backgroundColor: theme.chrome.outlineBackground,
  },
  groupPillText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    color: theme.colors.foreground,
  },
  groupCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  row: {
    borderBottomWidth: 1,
    borderBottomColor: theme.chrome.cardBorder,
  },
  columnHeader: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "none",
    letterSpacing: 0,
  },
}));

/** ClickUp's text tabs (To Do / Done / Delegated): no pill, an ink underline on the active one. */
export const clickUpTabStyles = StyleSheet.create((theme: Theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.spacing[6],
    borderBottomWidth: 1,
    borderBottomColor: theme.chrome.cardBorder,
  },
  tab: {
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
    marginBottom: -1,
  },
  tabActive: {
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: 2,
    borderBottomColor: theme.colors.foreground,
    marginBottom: -1,
  },
  text: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  textActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
}));

/**
 * ClickUp's filter chips ("Assigned to me" / "Mentions" / "Unread" on iOS, the toolbar pills on
 * web): white with a light border, the selected one lavender with violet text.
 */
export const clickUpChipStyles = StyleSheet.create((theme: Theme) => ({
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
