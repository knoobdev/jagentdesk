import type { PluginTheme } from "@jagentdesk/plugin";
import type {
  PluginHostProps,
  PluginWorkspaceRowBadgeItemContribution,
} from "@jagentdesk/plugin/client";
import { useMemo, useCallback } from "react";
import { Platform } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { useAppSettings } from "@/hooks/use-settings";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useInstalledPlugins } from "../registry";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import type { Theme } from "@/styles/theme";
import type { InstalledPlugin } from "../types";
import { WorkspaceRowBadgeTitleContext } from "./kit";
import {
  groupPluginWorkspaceRowBadgeItems,
  isWorkspaceRowBadgeItemVisible,
  workspaceRowBadgeItemKey,
  type PluginWorkspaceRowBadgeItemGroup,
} from "./model";

const renderNothing = () => null;
const themeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
function RowBadgeHost({
  plugin,
  item,
  workspaceId,
  theme,
}: {
  plugin: InstalledPlugin;
  item: PluginWorkspaceRowBadgeItemContribution;
  workspaceId: string;
  theme: PluginTheme;
}) {
  const client = useHostRuntimeClient(plugin.serverId);
  const compact = useIsCompactFormFactor();
  const hosts = useHosts();
  const host = useMemo(
    () => ({
      id: plugin.serverId,
      label: hosts.find((entry) => entry.serverId === plugin.serverId)?.label ?? plugin.serverId,
    }),
    [hosts, plugin.serverId],
  );
  const layout = useMemo<PluginHostProps["layout"]>(
    () => ({
      compact,
      platform: Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web",
    }),
    [compact],
  );
  if (!client) return null;
  const Component = item.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Component} renderError={renderNothing}>
      <PluginRuntimeBoundary plugin={plugin} client={client}>
        <WorkspaceRowBadgeTitleContext.Provider value={item.title}>
          <Component host={host} layout={layout} theme={theme} workspaceId={workspaceId} />
        </WorkspaceRowBadgeTitleContext.Provider>
      </PluginRuntimeBoundary>
    </SurfaceErrorBoundary>
  );
}
const ThemedRowBadgeHost = withUnistyles(RowBadgeHost);
export function PluginWorkspaceRowBadgeItems({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const installed = useInstalledPlugins();
  const {
    settings: { sidebarPluginRowBadgeItems },
  } = useAppSettings();
  return installed
    .filter((plugin) => plugin.serverId === serverId)
    .flatMap((plugin) =>
      (plugin.workspaceRowBadgeItems ?? [])
        .filter((item) =>
          isWorkspaceRowBadgeItemVisible(
            sidebarPluginRowBadgeItems,
            workspaceRowBadgeItemKey(plugin.id, item.id),
          ),
        )
        .map((item) => (
          <ThemedRowBadgeHost
            key={workspaceRowBadgeItemKey(plugin.id, item.id)}
            plugin={plugin}
            item={item}
            workspaceId={workspaceId}
            uniProps={themeMapping}
          />
        )),
    );
}
function BadgePreference({
  group,
  visible,
  toggle,
}: {
  group: PluginWorkspaceRowBadgeItemGroup;
  visible: boolean;
  toggle(key: string): void;
}) {
  const select = useCallback(() => toggle(group.key), [group.key, toggle]);
  return (
    <DropdownMenuItem
      selected={visible}
      closeOnSelect={false}
      onSelect={select}
      testID={`sidebar-plugin-badge-${group.key}`}
    >
      {group.title}
    </DropdownMenuItem>
  );
}
export function PluginWorkspaceRowBadgePreferences() {
  const installed = useInstalledPlugins();
  const {
    settings: { sidebarPluginRowBadgeItems },
    updateSettings,
  } = useAppSettings();
  const groups = useMemo(() => groupPluginWorkspaceRowBadgeItems(installed), [installed]);
  const toggle = useCallback(
    (key: string) => {
      void updateSettings({
        sidebarPluginRowBadgeItems: {
          ...sidebarPluginRowBadgeItems,
          [key]: !isWorkspaceRowBadgeItemVisible(sidebarPluginRowBadgeItems, key),
        },
      });
    },
    [sidebarPluginRowBadgeItems, updateSettings],
  );
  if (!groups.length) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>Show</DropdownMenuLabel>
      {groups.map((group) => (
        <BadgePreference
          key={group.key}
          group={group}
          visible={isWorkspaceRowBadgeItemVisible(sidebarPluginRowBadgeItems, group.key)}
          toggle={toggle}
        />
      ))}
    </>
  );
}
