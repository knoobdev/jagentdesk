import { useCallback, useMemo, useState, type ComponentType } from "react";
import { Image, Text, View, type PressableStateCallbackType } from "react-native";
import { Eye, Globe, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { getIsElectron } from "@/constants/platform";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  useDropdownMenuClose,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useBrowserStore } from "@/desktop/browser/store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import type { Theme } from "@/styles/theme";
import { closeAllBrowserTabs, closeBrowserTab, showBrowserTab } from "./actions";
import { buildBrowserTabRows, type BrowserTabRow, type BrowserTabStatus } from "./model";
import { useLiveBrowserTabsStore, useLiveBrowserTabsSync } from "./store";

const ThemedGlobe = withUnistyles(Globe);
const ThemedEye = withUnistyles(Eye);
const ThemedX = withUnistyles(X);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function resolveWorkspaceName(serverId: string, workspaceId: string): string | null {
  const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
  const key = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId });
  const workspace = key ? workspaces?.get(key) : undefined;
  return workspace ? workspace.title?.trim() || workspace.name : null;
}

function resolveAgentName(serverId: string, agentId: string): string | null {
  const agent = useSessionStore.getState().sessions[serverId]?.agents.get(agentId);
  return agent ? agent.title?.trim() || agent.provider : null;
}

function useBrowserTabRows(): BrowserTabRow[] {
  useLiveBrowserTabsSync();
  const liveTabs = useLiveBrowserTabsStore((state) => state.liveTabs);
  const elements = useLiveBrowserTabsStore((state) => state.elements);
  const browsersById = useBrowserStore((state) => state.browsersById);
  const layoutByWorkspace = useWorkspaceLayoutStore((state) => state.layoutByWorkspace);
  const sheetsByWorkspace = useWorkspaceLayoutStore((state) => state.sheetsByWorkspace);
  const serverIds = useSessionStore((state) => Object.keys(state.sessions).join("\n"));
  return useMemo(
    () =>
      buildBrowserTabRows({
        liveTabs,
        elements,
        browsersById,
        layouts: { layoutByWorkspace, sheetsByWorkspace },
        serverIds: serverIds ? serverIds.split("\n") : [],
        resolveWorkspaceName,
        resolveAgentName,
      }),
    [browsersById, elements, layoutByWorkspace, liveTabs, serverIds, sheetsByWorkspace],
  );
}

function triggerStyle({ hovered, pressed }: { hovered: boolean; pressed: boolean; open: boolean }) {
  return [styles.trigger, (hovered || pressed) && styles.triggerHovered];
}

/**
 * Sidebar footer row "N browser tabs open" and its popover (spec 04 §27d.1). Shown on the
 * desktop app while at least one browser webview is alive, parked ones included.
 */
export function BrowserTabsSidebarRow() {
  if (!getIsElectron()) return null;
  return <BrowserTabsSidebarRowContent />;
}

function BrowserTabsSidebarRowContent() {
  const { t } = useTranslation();
  const rows = useBrowserTabRows();
  if (rows.length === 0) return null;
  const label =
    rows.length === 1
      ? t("browserTabs.footerOne")
      : t("browserTabs.footerMany", { count: rows.length });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={triggerStyle}
        accessibilityLabel={label}
        testID="sidebar-browser-tabs"
      >
        <ThemedGlobe size={16} uniProps={muted} />
        <Text style={styles.triggerLabel} numberOfLines={1}>
          {label}
        </Text>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        width={420}
        maxHeight={480}
        scrollable
        surfaceStyle={styles.popover}
        testID="browser-tabs-popover"
      >
        <BrowserTabsPopoverBody rows={rows} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function BrowserTabsPopoverBody({ rows }: { rows: BrowserTabRow[] }) {
  const { t } = useTranslation();
  const close = useDropdownMenuClose();
  const handleCloseAll = useCallback(() => {
    close();
    void closeAllBrowserTabs(rows);
  }, [close, rows]);
  return (
    <View style={styles.body}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("browserTabs.title")}</Text>
        <Button
          variant="outline"
          size="sm"
          onPress={handleCloseAll}
          testID="browser-tabs-close-all"
        >
          {t("browserTabs.closeAll")}
        </Button>
      </View>
      {rows.map((row) => (
        <BrowserTabPopoverRow key={row.key} row={row} onShown={close} />
      ))}
    </View>
  );
}

function statusLabelKey(status: BrowserTabStatus): string | null {
  if (status === "loading") return "browserTabs.status.loading";
  if (status === "notResponding") return "browserTabs.status.notResponding";
  if (status === "crashed") return "browserTabs.status.crashed";
  return null;
}

function BrowserTabPopoverRow({ row, onShown }: { row: BrowserTabRow; onShown: () => void }) {
  const { t } = useTranslation();
  const detail = [row.host, row.workspaceName ?? t("browserTabs.notInWorkspace"), row.agentName]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const statusKey = statusLabelKey(row.status);
  const handleShow = useCallback(() => {
    if (showBrowserTab(row)) onShown();
  }, [onShown, row]);
  const handleClose = useCallback(() => {
    void closeBrowserTab(row);
  }, [row]);
  return (
    <View style={styles.row} testID="browser-tabs-row">
      <BrowserTabFavicon faviconUrl={row.faviconUrl} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {row.title || t("browserTabs.untitled")}
        </Text>
        <Text style={styles.rowDetail} numberOfLines={1} testID="browser-tabs-row-detail">
          {detail}
        </Text>
      </View>
      {statusKey ? (
        <View
          style={[
            styles.chip,
            row.status === "crashed" && styles.chipDanger,
            row.status === "notResponding" && styles.chipWarning,
          ]}
          testID="browser-tabs-row-status"
        >
          <Text
            style={[
              styles.chipText,
              row.status === "crashed" && styles.chipTextDanger,
              row.status === "notResponding" && styles.chipTextWarning,
            ]}
          >
            {t(statusKey)}
          </Text>
        </View>
      ) : null}
      <RowIconButton
        icon={ThemedEye}
        label={t("browserTabs.show")}
        onPress={handleShow}
        disabled={row.browserId === null}
        testID="browser-tabs-show"
      />
      <RowIconButton
        icon={ThemedX}
        label={t("browserTabs.close")}
        onPress={handleClose}
        testID="browser-tabs-close"
      />
    </View>
  );
}

function BrowserTabFavicon({ faviconUrl }: { faviconUrl: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const source = useMemo(() => (faviconUrl ? { uri: faviconUrl } : undefined), [faviconUrl]);
  const handleError = useCallback(() => setFailedUrl(faviconUrl), [faviconUrl]);
  if (!source || failedUrl === faviconUrl) {
    return <ThemedGlobe size={16} uniProps={muted} />;
  }
  return (
    <Image
      accessibilityIgnoresInvertColors
      source={source}
      style={styles.favicon}
      onError={handleError}
    />
  );
}

function iconButtonStyle({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.iconButton, (hovered || pressed) && styles.iconButtonHovered];
}

function RowIconButton({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  testID,
}: {
  icon: ComponentType<{ size: number; uniProps: typeof muted }>;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        disabled={disabled}
        style={iconButtonStyle}
        testID={testID}
      >
        <Icon size={16} uniProps={muted} />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={6}>
        <Text style={styles.tooltip}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

// Geometry from spec 04 §27d.1 and spec 38 §4.6 (two-line rows, status chips).
const styles = StyleSheet.create((theme: Theme) => ({
  trigger: {
    width: "100%",
    height: { xs: 44, md: 32 },
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  triggerHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  triggerLabel: { flex: 1, fontSize: 13, color: theme.colors.foregroundMuted },
  // The menu measures its content, not the surface: padding on the surface would make the
  // popover taller than placed and push it down over its trigger.
  popover: {
    borderRadius: theme.borderRadius.xl,
    borderColor: theme.colors.border,
  },
  body: { padding: theme.spacing[4] },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing[2],
  },
  title: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: 14, color: theme.colors.foreground },
  rowDetail: { fontSize: 13, color: theme.colors.foregroundMuted },
  favicon: { width: 16, height: 16, borderRadius: 3 },
  chip: {
    paddingVertical: 2,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.base,
    backgroundColor: theme.colors.surface2,
  },
  chipWarning: { backgroundColor: theme.colors.statusWarningBackground },
  chipDanger: { backgroundColor: theme.colors.statusDangerBackground },
  chipText: { fontSize: 14, fontWeight: "500", color: theme.colors.foregroundMuted },
  chipTextWarning: { color: theme.colors.statusWarning },
  chipTextDanger: { color: theme.colors.statusDanger },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  tooltip: { fontSize: 12, color: theme.colors.foreground },
}));
