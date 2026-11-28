import {
  useGumloopDesktopShell,
  useIsGumloopTheme,
} from "@/components/gumloop-shell/use-gumloop-chrome";
import { GUMLOOP_PAGE_GUTTER } from "@/components/gumloop-shell/list-styles";
import {
  usePublishCompactPageAction,
  type CompactPageAction,
} from "@/components/gumloop-shell/compact-page-action";
import { useMemo, useRef, type ReactNode } from "react";
import { Text, View } from "react-native";
import { usePathname } from "expo-router";
import type { LucideIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { Button } from "@/components/ui/button";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { CompactBackButton } from "./compact-back-button";
import { PageHeaderActionContext } from "./page-header-context";
import { usePageScrolled } from "./use-page-scrolled";

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
  /**
   * The page's main action ("Add memory"). Rendered as the last primary button with the actions;
   * on a Gumloop phone it becomes the top bar's right button instead (spec 38 §5). Memoize it.
   */
  primaryAction?: CompactPageAction | null;
  /** Small status next to the actions (e.g. Docker's "Live"). */
  accessory?: ReactNode;
  /** The page's tab row. Sits right under the title row, on the title's left edge. */
  tabs?: ReactNode;
  testID?: string;
  /**
   * The page body has scrolled: draw the 1 px divider under the header. Web detects it on its
   * own; native cannot see the page's scroll view, so pages pass it from `usePageScroll`
   * (spec 38 §4.4c).
   */
  scrolled?: boolean;
}

/**
 * The one page header every full-screen page uses (Home, History, Docker, Skills, Bots, …):
 * back arrow on phones, the section icon and a bold title on one row with same-size action
 * buttons on the right, a one-line description below, then the page's tabs. Under the Gumloop
 * phone top bar it drops the title row (`PhonePageHeader`).
 *
 * In the Gumloop desktop shell the title row is the page's top row: 60 px (72 px with a
 * description), so the title lines up with the sidebar's brand row (spec 38 §4.1, A38.4e). It
 * sits on the shared 32 px page gutter (`GUMLOOP_PAGE_GUTTER`); the page body uses the same one.
 */
export function PageHeader(props: PageHeaderProps) {
  // Phones in the Gumloop theme sit under the shell's phone top bar (spec 38 §5).
  const gumloop = useIsGumloopTheme();
  const compact = useIsCompactFormFactor();
  return gumloop && compact ? <PhonePageHeader {...props} /> : <StandardPageHeader {...props} />;
}

/**
 * A page under the Gumloop phone top bar. The top bar names the page and carries its primary
 * action as its right button (spec 38 §5), so the page keeps only its description, secondary
 * actions and tabs, on the 16 px page padding; a second title row would repeat the top bar.
 */
function PhonePageHeader({
  description,
  actions,
  primaryAction = null,
  accessory,
  tabs,
  testID,
  scrolled,
}: PageHeaderProps) {
  const pathname = usePathname();
  usePublishCompactPageAction(pathname, primaryAction);
  const headerRef = useRef<View>(null);
  // Solid header with a divider once the page scrolls (spec 38 §4.4c).
  const detectedScrolled = usePageScrolled(headerRef, scrolled === undefined);
  const showDivider = scrolled ?? detectedScrolled;
  return (
    <View ref={headerRef} style={[styles.container, styles.phoneContainer]} testID={testID}>
      {description ? (
        <Text style={styles.description} testID="page-header-description">
          {description}
        </Text>
      ) : null}
      {accessory || actions ? (
        <View style={styles.phoneActions}>
          <PageHeaderActionContext.Provider value>
            <View style={styles.actions}>
              {accessory}
              {actions}
            </View>
          </PageHeaderActionContext.Provider>
        </View>
      ) : null}
      {tabs}
      {showDivider ? (
        <View style={styles.scrollDivider} pointerEvents="none" testID="page-header-divider" />
      ) : null}
    </View>
  );
}

function PrimaryActionButton({ action }: { action: CompactPageAction }) {
  return (
    <Button
      size="sm"
      variant="default"
      leftIcon={action.icon}
      onPress={action.onPress}
      disabled={action.disabled}
      testID={action.testID}
    >
      {action.label}
    </Button>
  );
}

function StandardPageHeader({
  icon,
  title,
  description,
  actions,
  primaryAction = null,
  accessory,
  tabs,
  testID,
  scrolled,
}: PageHeaderProps) {
  const gumloop = useGumloopDesktopShell(true);
  const isCompact = useIsCompactFormFactor();
  const headerRef = useRef<View>(null);
  const detectedScrolled = usePageScrolled(headerRef, gumloop && scrolled === undefined);
  const showDivider = scrolled ?? detectedScrolled;
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
    accessory || actions || primaryAction ? (
      <PageHeaderActionContext.Provider value>
        <View style={[styles.actions, gumloop && styles.gumloopActions]}>
          {accessory}
          {actions}
          {primaryAction ? <PrimaryActionButton action={primaryAction} /> : null}
        </View>
      </PageHeaderActionContext.Provider>
    ) : null;
  if (gumloop) {
    return (
      <View ref={headerRef} style={containerStyle} testID={testID}>
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
        {showDivider ? (
          <View style={styles.scrollDivider} pointerEvents="none" testID="page-header-divider" />
        ) : null}
      </View>
    );
  }
  return (
    <View ref={headerRef} style={containerStyle} testID={testID}>
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
    // Solid behind the title row (spec 38 §4.4c). No z-index: Home pulls its first label up into
    // the header's bottom padding and has to paint over it.
    backgroundColor: theme.colors.surface0,
  },
  phoneContainer: {
    backgroundColor: theme.colors.surface0,
    paddingTop: theme.spacing[1],
    gap: theme.spacing[2],
  },
  phoneActions: { flexDirection: "row" },
  scrollDivider: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 1,
    backgroundColor: theme.colors.border,
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
