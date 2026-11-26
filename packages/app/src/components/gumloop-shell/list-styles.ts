import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

/**
 * Left and right page gutter of every Gumloop desktop page: the page header, its tabs, filters,
 * search fields, lists and cards all start and end 32 px inside the content pane, with no max
 * width and no centring (spec 38 §4.1, A38.4i). Use `gumloopListStyles.pageContent` (or this
 * number) instead of a page-local padding, so every page shares one left edge.
 */
export const GUMLOOP_PAGE_GUTTER = 32;

/**
 * Shared list geometry and muted column headers for Gumloop screens.
 */
export const gumloopListStyles = StyleSheet.create((theme: Theme) => ({
  /** Home's embedded list: the "Recent activity" label above sets the spacing. */
  embeddedContent: { paddingHorizontal: 0, paddingTop: 0, gap: 0 },
  pageContent: {
    width: "100%",
    maxWidth: "100%",
    alignSelf: "stretch",
    paddingHorizontal: GUMLOOP_PAGE_GUTTER,
  },
  /** Rows sit flush; the page header already leaves 16px above the first group label. */
  listContent: { paddingTop: 0, gap: 0 },
  // Group labels ("Today", a compose project…) are 14/600, 16px under the previous group's last
  // row and 4px above their own first row (spec 38 §4.6 "Bảng").
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
    marginBottom: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  firstGroupRow: { marginTop: 0 },
  /** Home "Recent activity": 12px under the label above (spec 38 §4.1). */
  embeddedFirstGroupRow: { marginTop: theme.spacing[3] },
  groupPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 0,
    borderRadius: 0,
    backgroundColor: "transparent",
  },
  groupPillText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 0.3,
    textTransform: "none",
    color: theme.colors.foreground,
  },
  groupCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  /** Every Gumloop list and table row: 44px with a 1px divider (spec 38 §4.6, A38.4g). */
  row: {
    minHeight: 44,
    borderBottomWidth: 1,
    borderBottomColor: theme.chrome.cardBorder,
  },
  /** Single-line rows let the 44px floor set the height. */
  rowFlush: { paddingVertical: 0 },
  /** Two-line rows (name + a secondary line). */
  rowTwoLine: { minHeight: 56, paddingVertical: theme.spacing[2], justifyContent: "center" },
  /** Row icons sit in a 28px bordered circle holding a 16px glyph. */
  rowIconCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
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
