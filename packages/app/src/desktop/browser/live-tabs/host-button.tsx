import { useCallback } from "react";
import { Text, View } from "react-native";
import { Globe } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { getIsElectron } from "@/constants/platform";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";
import { summarizeBrowserTabRows, type BrowserTabsTone } from "./model";
import {
  BROWSER_TABS_POPOVER_MAX_HEIGHT,
  BROWSER_TABS_POPOVER_WIDTH,
  BrowserTabsPopoverBody,
  browserTabsPopoverStyles,
} from "./popover";
import { useBrowserTabRows } from "./rows";

const ThemedGlobe = withUnistyles(Globe);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export type BrowserTabsHostButtonVariant = "gumloop" | "classic";

/**
 * "Browser tabs" icon button in the sidebar host row, right before Notifications, with a count
 * badge (spec 04 §27d.1, spec 38 §4.2). Desktop only, and only while at least one browser webview
 * is alive, parked ones included. Opens the list of every live tab.
 */
export function BrowserTabsHostButton({
  variant = "gumloop",
}: {
  variant?: BrowserTabsHostButtonVariant;
}) {
  if (!getIsElectron()) return null;
  return <BrowserTabsHostButtonContent variant={variant} />;
}

function BrowserTabsHostButtonContent({ variant }: { variant: BrowserTabsHostButtonVariant }) {
  const { t } = useTranslation();
  const rows = useBrowserTabRows();
  const summary = summarizeBrowserTabRows(rows);
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: { hovered: boolean; pressed: boolean; open: boolean }) => [
      variant === "classic" ? styles.buttonClassic : styles.button,
      (hovered || pressed || open) && styles.buttonHovered,
    ],
    [variant],
  );
  if (summary.count === 0) return null;
  const label =
    summary.count === 1
      ? t("browserTabs.openOne")
      : t("browserTabs.openMany", { count: summary.count });
  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <View style={styles.anchor}>
            <DropdownMenuTrigger
              style={triggerStyle}
              accessibilityRole="button"
              accessibilityLabel={label}
              testID="sidebar-browser-tabs"
            >
              <ThemedGlobe size={variant === "classic" ? 16 : 18} uniProps={muted} />
              <BrowserTabsBadge text={summary.badgeText} tone={summary.tone} />
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltip}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        width={BROWSER_TABS_POPOVER_WIDTH}
        maxHeight={BROWSER_TABS_POPOVER_MAX_HEIGHT}
        scrollable
        surfaceStyle={browserTabsPopoverStyles.surface}
        testID="browser-tabs-popover"
      >
        <BrowserTabsPopoverBody rows={rows} includeAgent />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrowserTabsBadge({ text, tone }: { text: string; tone: BrowserTabsTone }) {
  return (
    <View style={styles.badge} pointerEvents="none" testID="sidebar-browser-tabs-badge">
      <Text
        style={[
          styles.badgeText,
          tone === "warning" && styles.badgeTextWarning,
          tone === "danger" && styles.badgeTextDanger,
        ]}
      >
        {text}
      </Text>
    </View>
  );
}

// Button geometry matches the host row's other icon buttons (`AccountButton`, 32 × 32, radius 8);
// the badge is `StatusBadge` muted (paseo-design-system §4.5) shrunk to 16 px, 2 px outside.
const styles = StyleSheet.create((theme: Theme) => ({
  anchor: { flexShrink: 0 },
  button: {
    width: { xs: 44, md: 32 },
    height: { xs: 44, md: 32 },
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonClassic: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  badge: {
    position: "absolute",
    top: -2,
    right: -2,
    height: 16,
    minWidth: 16,
    paddingHorizontal: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: "400",
    color: theme.colors.foregroundMuted,
  },
  badgeTextWarning: { color: theme.colors.statusWarning },
  badgeTextDanger: { color: theme.colors.statusDanger },
  tooltip: { fontSize: theme.fontSize.sm, color: theme.colors.popoverForeground },
}));
