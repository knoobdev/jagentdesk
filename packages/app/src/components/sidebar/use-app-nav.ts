import { useBuiltinDestinations } from "@/plugins/builtin/surfaces";
import { useOpenSidebarUsage } from "@/usage/sidebar-item";
import { useBuiltinPluginEnabled } from "@/plugins/builtin/hooks";
import { builtinPluginEnabled } from "@/plugins/builtin/registry";
import { router, usePathname, type Href } from "expo-router";
import { useCallback, useMemo } from "react";
import {
  BarChart3,
  Gauge,
  Bot,
  CalendarClock,
  Figma,
  GitPullRequest,
  History,
  Home,
  KanbanSquare,
  Radar,
  Server,
  Share2,
  Ship,
  Smartphone,
  Sparkles,
  Store,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { hostSupportsCapability } from "@/utils/server-info-capabilities";
import type { HostCapabilityId } from "@jagentdesk/protocol/host-capabilities";

/** Capabilities behind the device fleet: simulators, physical phones (spec 27.2), or sideload (26.9). */
const DEVICE_CAPABILITIES: readonly HostCapabilityId[] = [
  "iosSimulators",
  "androidDevices",
  "androidPhysical",
  "iosPhysical",
  "iosSideload",
];
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  buildArgoCdRoute,
  buildFigmaRoute,
  buildForgeRoute,
  buildInsightsRoute,
  buildJiraRoute,
  buildMarketplaceRoute,
  buildNewWorkspaceRoute,
  buildOpenProjectRoute,
  buildSchedulesRoute,
  buildServersRoute,
  buildSessionsRoute,
  buildSharedSessionsRoute,
  buildSimulatorRoute,
  buildProxyRoute,
  buildSkillsRoute,
} from "@/utils/host-routes";

/** Routes behind the app's primary navigation, shared by the sidebar list and the Gumloop rail. */
export interface AppNavTargets {
  botsRoute: Href | null;
  sharedSessionsRoute: Href | null;
  serversRoute: Href | null;
  skillsRoute: Href | null;
  insightsRoute: Href | null;
  forgeRoute: Href | null;
  marketplaceRoute: Href | null;
  simulatorRoute: Href | null;
  proxyRoute: Href | null;
  /** Spec 30.3: the daemon ships Argo CD; null hides the entry. */
  argoCdRoute: Href | null;
  supportsForgeHub: boolean;
  /** Spec 29: Jira surface, when the daemon advertises `jira`. */
  jiraRoute: Href | null;
  /** Spec 32: Figma section, when the daemon advertises `figma`. */
  figmaRoute: Href | null;
  /** Spec 25: daemon build ships the SSH servers surface (S1+). */
  supportsSshServers: boolean;
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
  const skillsEnabled = useBuiltinPluginEnabled(firstServerId, "skills");
  const insightsEnabled = useBuiltinPluginEnabled(firstServerId, "insights");
  const workbenchEnabled = useBuiltinPluginEnabled(firstServerId, "workbench");
  const sharingEnabled = useBuiltinPluginEnabled(firstServerId, "session-share");
  // Forge Hub is a post-ADR-0003 surface gated per release milestone (spec 19.12):
  // only advertise the entry when the first/active daemon reports forgeHub.
  const supportsForgeHub = useSessionStore(
    (state) => state.sessions[firstServerId]?.serverInfo?.features?.forgeHub === true,
  );
  const supportsJira = useSessionStore(
    (state) => state.sessions[firstServerId]?.serverInfo?.features?.jira === true,
  );
  const supportsFigma = useSessionStore(
    (state) => state.sessions[firstServerId]?.serverInfo?.features?.figma === true,
  );
  const supportsSshServers = useSessionStore(
    (state) => state.sessions[firstServerId]?.serverInfo?.features?.sshServers === true,
  );
  const supportsArgoCd = useSessionStore(
    (state) => state.sessions[firstServerId]?.serverInfo?.features?.argocd === true,
  );
  // Spec 24.4: devices open on the first host that can run simulators; none → no entry.
  const deviceServerId = useSessionStore(
    (state) =>
      hosts.find(
        (host) =>
          host.serverId === firstServerId &&
          builtinPluginEnabled(state.sessions[host.serverId]?.serverInfo, "devices") &&
          hostSupportsCapability(state.sessions[host.serverId]?.serverInfo, DEVICE_CAPABILITIES),
      )?.serverId ?? null,
  );
  return useMemo(() => {
    const perHost = (build: (serverId: string) => string): Href | null =>
      firstServerId ? (build(firstServerId) as Href) : null;
    return {
      botsRoute: supportsBots
        ? perHost((serverId) => `/h/${encodeURIComponent(serverId)}/bots`)
        : null,
      sharedSessionsRoute: sharingEnabled ? (buildSharedSessionsRoute() as Href) : null,
      // Gated at the route: the entry disappears with the daemon feature flag.
      serversRoute: supportsSshServers ? perHost(buildServersRoute) : null,
      skillsRoute: skillsEnabled ? perHost(buildSkillsRoute) : null,
      insightsRoute: insightsEnabled ? perHost(buildInsightsRoute) : null,
      forgeRoute: perHost(buildForgeRoute),
      marketplaceRoute: perHost(buildMarketplaceRoute),
      simulatorRoute: deviceServerId ? (buildSimulatorRoute(deviceServerId) as Href) : null,
      proxyRoute: workbenchEnabled ? perHost(buildProxyRoute) : null,
      argoCdRoute: supportsArgoCd ? perHost(buildArgoCdRoute) : null,
      supportsForgeHub,
      supportsSshServers,
      jiraRoute: supportsJira ? perHost(buildJiraRoute) : null,
      figmaRoute: supportsFigma ? perHost(buildFigmaRoute) : null,
    };
  }, [
    supportsBots,
    skillsEnabled,
    insightsEnabled,
    workbenchEnabled,
    sharingEnabled,
    supportsJira,
    supportsFigma,
    deviceServerId,
    firstServerId,
    supportsArgoCd,
    supportsForgeHub,
    supportsSshServers,
  ]);
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
      targets.sharedSessionsRoute
        ? {
            key: "shared-sessions",
            icon: Share2,
            label: "Shared sessions",
            shortLabel: "Shared",
            route: targets.sharedSessionsRoute,
            isActive: pathname.includes("/shared-sessions"),
            testID: "rail-shared-sessions",
          }
        : null,

      navItem("skills", Sparkles, "Skills", "Skills", targets.skillsRoute, pathname, "/skills"),
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
      navItem(
        "simulators",
        Smartphone,
        "Simulators",
        "Sims",
        targets.simulatorRoute,
        pathname,
        "/simulator",
      ),
      navItem("workbench", Radar, "Workbench", "WB", targets.proxyRoute, pathname, "/proxy"),
      navItem("servers", Server, "Servers", "Servers", targets.serversRoute, pathname, "/servers"),
      navItem("argocd", Ship, "Argo CD", "Argo CD", targets.argoCdRoute, pathname, "/argocd"),
      {
        key: "usage",
        icon: Gauge,
        label: "Usage",
        shortLabel: "Usage",
        onPress: openUsage,
        isActive: false,
        testID: "rail-usage",
      },
      navItem(
        "insights",
        BarChart3,
        "Insights",
        "Insights",
        targets.insightsRoute,
        pathname,
        "/insights",
      ),
      navItem("jira", KanbanSquare, "Jira", "Jira", targets.jiraRoute, pathname, "/jira"),
      navItem("figma", Figma, "Figma", "Figma", targets.figmaRoute, pathname, "/figma"),
      targets.supportsForgeHub
        ? navItem("forge", GitPullRequest, "Forge", "Forge", targets.forgeRoute, pathname, "/forge")
        : null,
    ];
    return orderAppNavItems(items.filter((item): item is AppNavItem => item !== null));
  }, [openUsage, pathname, t, targets, builtinDestinations]);
}

// Established destination order. Built-in feature destinations keep their positions; any other
// built-in destination follows Marketplace in load order.
const APP_NAV_ORDER: readonly string[] = [
  "home",
  "sessions",
  "schedules",
  "bots",
  "shared-sessions",
  "skills",
  "marketplace",
  "docker",
  "simulators",
  "workbench",
  "databases",
  "servers",
  "clusters",
  "argocd",
  "usage",
  "insights",
  "jira",
  "figma",
  "forge",
];
const UNPLACED_NAV_RANK = APP_NAV_ORDER.indexOf("marketplace") + 0.5;
export function orderAppNavItems(items: AppNavItem[]): AppNavItem[] {
  const rank = (key: string) => {
    const index = APP_NAV_ORDER.indexOf(key);
    return index === -1 ? UNPLACED_NAV_RANK : index;
  };
  // Hermes has no `toSorted`; Array.prototype.sort is stable.
  return [...items].sort((left, right) => rank(left.key) - rank(right.key));
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
