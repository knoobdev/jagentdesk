import { useCallback, useMemo } from "react";
import { Copy, Ellipsis, Import, Settings } from "lucide-react-native";
import { View } from "react-native";
import { router } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { usePluginWorkspaceMenu } from "@/plugins/buttons/view";
import { buildSettingsRoute } from "@/utils/host-routes";
import { useWorkspaceScriptsMenuPages, type UseWorkspaceScriptsMenuPagesInput } from "./scripts";
import type { Theme } from "@/styles/theme";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedCopy = withUnistyles(Copy);
const ThemedImport = withUnistyles(Import);
const ThemedSettings = withUnistyles(Settings);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const IMPORT_ICON = <ThemedImport size={18} uniProps={muted} />;
const COPY_ICON = <ThemedCopy size={18} uniProps={muted} />;
const SETTINGS_ICON = <ThemedSettings size={18} uniProps={muted} />;
export function CompactWorkspaceActions({
  onImport,
  importDisabled,
  onCopyPath,
  copyPathDisabled,
  ...scriptsInput
}: UseWorkspaceScriptsMenuPagesInput & {
  onImport: () => void;
  importDisabled: boolean;
  onCopyPath: () => void;
  copyPathDisabled: boolean;
}) {
  const { t } = useTranslation();
  const scripts = useWorkspaceScriptsMenuPages(scriptsInput);
  const plugins = usePluginWorkspaceMenu(scriptsInput.serverId, scriptsInput.workspaceId);
  const pages = useMemo(() => [...scripts.pages, ...plugins.pages], [scripts.pages, plugins.pages]);
  const settings = useCallback(() => router.push(buildSettingsRoute()), []);
  const label = scripts.needsAttention
    ? t("workspace.header.actions.workspaceActionsUnhealthy")
    : t("workspace.header.actions.workspaceActions");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.trigger}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="workspace-header-menu-trigger"
      >
        <ThemedEllipsis size={20} uniProps={muted} />
        {scripts.needsAttention ? (
          <View style={styles.dot} testID="workspace-scripts-unhealthy" />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        pages={pages}
        sheetTitle={t("workspace.header.actions.workspaceActions")}
        testID="workspace-header-menu"
      >
        {scripts.trigger}
        {plugins.rows}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onImport} disabled={importDisabled} leading={IMPORT_ICON}>
          {t("workspace.header.actions.importSession")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyPath} disabled={copyPathDisabled} leading={COPY_ICON}>
          {t("workspace.header.actions.copyPath")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={settings} leading={SETTINGS_ICON}>
          {t("sidebar.actions.settings")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
const styles = StyleSheet.create((theme: Theme) => ({
  trigger: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  dot: {
    position: "absolute",
    top: 8,
    right: 8,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.destructive,
  },
}));
