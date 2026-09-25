import { router, usePathname } from "expo-router";
import { useCallback, useMemo } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { resolvePluginIcon } from "./icons";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "./routes";
import {
  getPreferredPluginContributionHost,
  rememberPluginContributionHost,
} from "./contribution-host";
import {
  groupPluginSidebarContributions,
  type PluginSidebarGroup,
  type PluginSidebarTarget,
} from "./sidebar-groups";
import { useInstalledPlugins } from "./registry";

function selectTarget(
  group: PluginSidebarGroup,
  currentHostId: string | null,
): PluginSidebarTarget {
  const current = group.targets.find((target) => target.plugin.serverId === currentHostId);
  if (current) return current;
  const rememberedHostId = getPreferredPluginContributionHost(group.key);
  const remembered = group.targets.find((target) => target.plugin.serverId === rememberedHostId);
  return remembered ?? group.targets[0];
}

/** Where a plugin sidebar contribution navigates, and whether the current route is it. */
export function usePluginSidebarNavigation(
  group: PluginSidebarGroup,
  onBeforeNavigate?: () => void,
): { navigate: () => void; isActive: boolean } {
  const pathname = usePathname();
  const target = selectTarget(group, hostIdFromPathname(pathname));
  const route = buildPluginSurfaceRoute(target.plugin.serverId, group.pluginId, {
    kind: "sidebar",
    id: group.contributionId,
  });
  const isActive = group.targets.some(
    (candidate) =>
      pathname ===
      buildPluginSurfaceRoute(candidate.plugin.serverId, group.pluginId, {
        kind: "sidebar",
        id: group.contributionId,
      }),
  );
  const navigate = useCallback(() => {
    rememberPluginContributionHost(group.key, target.plugin.serverId);
    onBeforeNavigate?.();
    router.push(route);
  }, [group.key, onBeforeNavigate, route, target.plugin.serverId]);
  return { navigate, isActive };
}

export function usePluginSidebarGroups(): PluginSidebarGroup[] {
  const plugins = useInstalledPlugins();
  return useMemo(() => groupPluginSidebarContributions(plugins), [plugins]);
}

export function PluginSidebarItemRow({
  group,
  onBeforeNavigate,
}: {
  group: PluginSidebarGroup;
  onBeforeNavigate?: () => void;
}) {
  const { navigate, isActive } = usePluginSidebarNavigation(group, onBeforeNavigate);
  return (
    <SidebarHeaderRow
      icon={resolvePluginIcon(group.icon)}
      label={group.title}
      onPress={navigate}
      isActive={isActive}
      testID={`plugin-sidebar-${group.pluginId}-${group.contributionId}`}
      variant="compact"
    />
  );
}

// Every plugin sidebar contribution as a row, for the fork's left sidebar (upstream renders
// these through its configurable sidebar-nav model instead).
export function PluginSidebarItems({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const groups = usePluginSidebarGroups();
  return (
    <>
      {groups.map((group) => (
        <PluginSidebarItemRow key={group.key} group={group} onBeforeNavigate={onBeforeNavigate} />
      ))}
    </>
  );
}
