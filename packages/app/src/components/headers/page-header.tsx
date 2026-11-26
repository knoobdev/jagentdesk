import { useGumloopDesktopShell } from "@/components/gumloop-shell/use-gumloop-chrome";
import { GUMLOOP_PAGE_GUTTER } from "@/components/gumloop-shell/list-styles";
import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { CompactBackButton } from "./compact-back-button";
import { PageHeaderActionContext } from "./page-header-context";

const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

interface PageHeaderProps {
  /** The section's icon — the same one the rail / sidebar uses for it. */
  icon: LucideIcon;
  title: string;
  /**
   * One line saying what the page is for (two on phones). Every top-level page has one, Home
   * included (spec 38 §4.1, A38.4j); plugin screens use their manifest `description`.
   */
  description?: string | null;
  /** Right-side buttons: use `<Button size="sm" leftIcon={…}>`, so every page matches. */
  actions?: ReactNode;
  /** Small status next to the actions (e.g. Docker's "Live"). */
  accessory?: ReactNode;
  /** The page's tab row. Sits right under the title row, on the title's left edge. */
  tabs?: ReactNode;
  testID?: string;
}

/**
 * The one page header every full-screen page uses (Home, History, Docker, Skills, Bots, …):
 * back arrow on phones, the section icon and a bold title on one row with same-size action
 * buttons on the right, a one-line description below, then the page's tabs.
 *
 * In the Gumloop desktop shell the title row is the page's top row: 60 px (72 px with a
 * description), so the title lines up with the sidebar's brand row (spec 38 §4.1, A38.4e). It
 * sits on the shared 32 px page gutter (`GUMLOOP_PAGE_GUTTER`); the page body uses the same one.
 */
export function PageHeader({
  icon,
  title,
  description,
  actions,
  accessory,
  tabs,
  testID,
}: PageHeaderProps) {
  const gumloop = useGumloopDesktopShell(true);
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const ThemedIcon = useMemo(() => withUnistyles(icon), [icon]);
  const containerStyle = useMemo(
    () => [
      styles.container,
      gumloop && styles.gumloopContainer,
      isCompact ? { paddingTop: insets.top + 12 } : null,
    ],
    [gumloop, insets.top, isCompact],
  );
  const rightSide =
    accessory || actions ? (
      <PageHeaderActionContext.Provider value>
        <View style={[styles.actions, gumloop && styles.gumloopActions]}>
          {accessory}
          {actions}
        </View>
      </PageHeaderActionContext.Provider>
    ) : null;
  if (gumloop) {
    return (
      <View style={containerStyle} testID={testID}>
        <View style={description ? styles.gumloopRowWithDescription : styles.gumloopRow}>
          {/* No window title bar in this shell: the title row drags the window and a double
              click zooms it, like the sidebar's brand row (spec 38 §4.1, A38.4h). */}
          <TitlebarDragRegion />
          <View style={styles.gumloopTitleBlock}>
            <Text style={styles.gumloopTitle} numberOfLines={1} testID="page-header-title">
              {title}
            </Text>
            {description ? (
              <Text
                style={styles.gumloopDescription}
                numberOfLines={1}
                testID="page-header-description"
              >
                {description}
              </Text>
            ) : null}
          </View>
          {rightSide}
        </View>
        {tabs ? <View style={styles.gumloopTabs}>{tabs}</View> : null}
      </View>
    );
  }
  return (
    <View style={containerStyle} testID={testID}>
      <View style={styles.row}>
        <View style={styles.titleGroup}>
          <CompactBackButton />
          <ThemedIcon size={20} uniProps={iconColorMapping} />
          <Text style={styles.title} numberOfLines={1} testID="page-header-title">
            {title}
          </Text>
        </View>
        {rightSide}
      </View>
      {description ? <Text style={styles.description}>{description}</Text> : null}
      {tabs ? <View style={styles.tabs}>{tabs}</View> : null}
    </View>
  );
}

/** Height of the Gumloop page title row; equal to the sidebar brand row (spec 38 §4.1). */
const GUMLOOP_TITLE_ROW = 60;
const GUMLOOP_TITLE_ROW_WITH_DESCRIPTION = 72;

const styles = StyleSheet.create((theme: Theme) => ({
  gumloopContainer: {
    paddingHorizontal: GUMLOOP_PAGE_GUTTER,
    paddingTop: 0,
    paddingBottom: 16,
    gap: 0,
  },
  gumloopRow: {
    height: GUMLOOP_TITLE_ROW,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  gumloopRowWithDescription: {
    height: GUMLOOP_TITLE_ROW_WITH_DESCRIPTION,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  gumloopTitleBlock: { flexShrink: 1, minWidth: 0, gap: 2 },
  gumloopTitle: {
    fontSize: 20,
    lineHeight: 28,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
  gumloopDescription: {
    fontSize: 14,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  gumloopActions: { height: 36, gap: 10 },
  gumloopTabs: { marginTop: 8 },
  tabs: { marginTop: theme.spacing[2] },
  container: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    rowGap: theme.spacing[2],
    columnGap: theme.spacing[3],
  },
  titleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  description: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
