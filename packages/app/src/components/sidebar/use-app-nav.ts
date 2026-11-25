import { useBuiltinDestinations } from "@/plugins/builtin/surfaces";
import { orderAppNavItems } from "@/components/sidebar/nav-order";
import { useOpenSidebarUsage } from "@/usage/sidebar-item";
import { router, usePathname, type Href } from "expo-router";
import { useCallback, useMemo } from "react";
import {
  Gauge,
  Bot,
  CalendarClock,
  History,
  Home,
  Store,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

import { useWorkspace } from "@/stores/session-store-hooks";
import {
  buildMarketplaceRoute,
  buildNewWorkspaceRoute,
  buildOpenProjectRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";

/** Routes behind the app's primary navigation, shared by the sidebar list and the Gumloop rail. */
export interface AppNavTargets {
  botsRoute: Href | null;
  marketplaceRoute: Href | null;
}

export function useAppNavTargets(): AppNavTargets {
  const hosts = useHosts();
  const pathname = usePathname();
  const selection = useActiveWorkspaceSelection();
  const routeServerId = /^\/h\/([^/]+)/.exec(pathname)?.[1];
  const firstServerId = routeServerId
    ? decodeURIComponent(routeServerId)
    : (selection?.serverId ?? hosts[0]?.serverId ?? "");
  const supportsBots = useHostFeature(firstServerId, "bots");
  return useMemo(() => {
    const perHost = (build: (serverId: string) => string): Href | null =>
      firstServerId ? (build(firstServerId) as Href) : null;
    return {
      botsRoute: supportsBots
        ? perHost((serverId) => `/h/${encodeURIComponent(serverId)}/bots`)
        : null,
      // Gated at the route: the entry disappears with the daemon feature flag.
      marketplaceRoute: perHost(buildMarketplaceRoute),
    };
  }, [supportsBots, firstServerId]);
}

interface AppNavItemBase {
  group?: "Tools" | "main";
  key: string;
  icon: LucideIcon;
  label: string;
  /** Short label for the Gumloop rail, where the text sits under the icon. */
  shortLabel: string;
  isActive: boolean;
  testID: string;
  /** Built-in destinations: legacy sidebar row test id. */
  sidebarTestID?: string;
}

export type AppNavItem = AppNavItemBase &
  ({ route: Href; onPress?: never } | { route?: never; onPress: () => void });

/** The primary destinations in display order, with the active flag for the current route. */
export function useAppNavItems(): AppNavItem[] {
  const openUsage = useOpenSidebarUsage();
  const { t } = useTranslation();
  const pathname = usePathname();
  const targets = useAppNavTargets();
  const builtinDestinations = useBuiltinDestinations(pathname);
  return useMemo(() => {
    const items: (AppNavItem | null)[] = [
      {
        key: "home",
        icon: Home,
        label: t("sidebar.actions.home"),
        shortLabel: t("sidebar.actions.home"),
        route: buildOpenProjectRoute() as Href,
        isActive: pathname === "/open-project",
        testID: "rail-home",
      },
      {
        key: "sessions",
        icon: History,
        label: t("sidebar.sections.sessions"),
        shortLabel: t("sidebar.sections.sessions"),
        route: buildSessionsRoute() as Href,
        isActive: pathname.includes("/sessions") && !pathname.includes("/shared-sessions"),
        testID: "rail-sessions",
      },
      {
        key: "schedules",
        icon: CalendarClock,
        label: t("sidebar.sections.schedules"),
        shortLabel: t("sidebar.sections.schedules"),
        route: buildSchedulesRoute() as Href,
        isActive: pathname.includes("/schedules"),
        testID: "rail-schedules",
      },
      navItem("bots", Bot, t("bots.title"), t("bots.title"), targets.botsRoute, pathname, "/bots"),

      navItem(
        "marketplace",
        Store,
        t("sidebar.actions.marketplace"),
        "Market",
        targets.marketplaceRoute,
        pathname,
        "/marketplace",
      ),
      ...builtinDestinations,
      {
        key: "usage",
        icon: Gauge,
        label: "Usage",
        shortLabel: "Usage",
        onPress: openUsage,
        isActive: false,
        testID: "rail-usage",
      },
    ];
    return orderAppNavItems(items.filter((item): item is AppNavItem => item !== null));
  }, [openUsage, pathname, t, targets, builtinDestinations]);
}

function navItem(
  key: string,
  icon: LucideIcon,
  label: string,
  shortLabel: string,
  route: Href | null,
  pathname: string,
  segment: string,
): AppNavItem | null {
  if (!route) return null;
  return {
    key,
    icon,
    label,
    shortLabel,
    route,
    isActive: pathname.includes(segment),
    testID: `rail-${key}`,
  };
}

/** Opens a new workspace, reusing the active workspace's project when the host allows it. */
export function useNewWorkspaceNavigate(onBeforeNavigate?: () => void): () => void {
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeWorkspaceServerId = activeWorkspaceSelection?.serverId ?? null;
  const activeWorkspaceId = activeWorkspaceSelection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(activeWorkspaceServerId, activeWorkspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(
    activeWorkspaceServerId,
    "workspaceMultiplicity",
  );
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );
  return useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      activeWorkspaceServerId
        ? buildNewWorkspaceRoute(
            activeWorkspace && canUseActiveWorkspaceContext
              ? {
                  serverId: activeWorkspaceServerId,
                  sourceDirectory: activeWorkspace.projectRootPath,
                  projectId: activeWorkspace.projectId,
                }
              : { serverId: activeWorkspaceServerId },
          )
        : buildNewWorkspaceRoute(),
    );
  }, [activeWorkspace, activeWorkspaceServerId, canUseActiveWorkspaceContext, onBeforeNavigate]);
}
