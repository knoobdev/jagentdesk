import { router, usePathname, type Href } from "expo-router";
import { useCallback, useMemo } from "react";
import {
  BarChart3,
  Boxes,
  CalendarClock,
  Container,
  Database,
  GitPullRequest,
  History,
  Home,
  Share2,
  Smartphone,
  Sparkles,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useClusterNavStore } from "@/stores/cluster-nav-store";
import { useDatabaseNavStore } from "@/stores/database-nav-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  buildAgentForumRoute,
  buildClusterWorkloadsRoute,
  buildClustersRoute,
  buildDatabaseBrowseRoute,
  buildDatabasesRoute,
  buildDockerRoute,
  buildForgeRoute,
  buildInsightsRoute,
  buildMarketplaceRoute,
  buildNewWorkspaceRoute,
  buildOpenProjectRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
  buildSharedSessionsRoute,
  buildSimulatorRoute,
  buildSkillsRoute,
} from "@/utils/host-routes";

/** Routes behind the app's primary navigation, shared by the sidebar list and the ClickUp rail. */
export interface AppNavTargets {
  clustersRoute: Href | null;
  databasesRoute: Href | null;
  skillsRoute: Href | null;
  insightsRoute: Href | null;
  forgeRoute: Href | null;
  marketplaceRoute: Href | null;
  dockerRoute: Href | null;
  simulatorRoute: Href | null;
  supportsForgeHub: boolean;
}

export function useAppNavTargets(): AppNavTargets {
  const hosts = useHosts();
  const firstServerId = hosts[0]?.serverId ?? "";
  const lastCluster = useClusterNavStore((s) => s.lastCluster);
  const lastDatabase = useDatabaseNavStore((s) => s.lastDatabase);
  // Forge Hub is a post-ADR-0003 surface gated per release milestone (spec 19.12):
  // only advertise the entry when the first/active daemon reports forgeHub.
  const supportsForgeHub = useSessionStore(
    (state) => state.sessions[firstServerId]?.serverInfo?.features?.forgeHub === true,
  );
  return useMemo(() => {
    const perHost = (build: (serverId: string) => string): Href | null =>
      firstServerId ? (build(firstServerId) as Href) : null;
    // Clusters and databases jump straight back to the resource the user last had open,
    // falling back to the list when there is none.
    let clustersRoute: Href | null = perHost(buildClustersRoute);
    if (lastCluster) {
      clustersRoute = buildClusterWorkloadsRoute(
        lastCluster.serverId,
        lastCluster.clusterId,
      ) as Href;
    }
    let databasesRoute: Href | null = perHost(buildDatabasesRoute);
    if (lastDatabase) {
      databasesRoute = buildDatabaseBrowseRoute(
        lastDatabase.serverId,
        lastDatabase.databaseId,
      ) as Href;
    }
    return {
      clustersRoute,
      databasesRoute,
      skillsRoute: perHost(buildSkillsRoute),
      insightsRoute: perHost(buildInsightsRoute),
      forgeRoute: perHost(buildForgeRoute),
      marketplaceRoute: perHost(buildMarketplaceRoute),
      dockerRoute: perHost(buildDockerRoute),
      simulatorRoute: perHost(buildSimulatorRoute),
      supportsForgeHub,
    };
  }, [firstServerId, lastCluster, lastDatabase, supportsForgeHub]);
}

export interface AppNavItem {
  key: string;
  icon: LucideIcon;
  label: string;
  /** Short label for the ClickUp rail, where the text sits under the icon. */
  shortLabel: string;
  route: Href;
  isActive: boolean;
  testID: string;
}

/** The primary destinations in display order, with the active flag for the current route. */
export function useAppNavItems(): AppNavItem[] {
  const { t } = useTranslation();
  const pathname = usePathname();
  const targets = useAppNavTargets();
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
      {
        key: "shared-sessions",
        icon: Share2,
        label: "Shared sessions",
        shortLabel: "Shared",
        route: buildSharedSessionsRoute() as Href,
        isActive: pathname.includes("/shared-sessions"),
        testID: "rail-shared-sessions",
      },
      {
        key: "team",
        icon: Users,
        label: "Team",
        shortLabel: "Team",
        route: buildAgentForumRoute() as Href,
        isActive: pathname.includes("/agent-forum"),
        testID: "rail-team",
      },
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
      navItem("docker", Container, "Docker", "Docker", targets.dockerRoute, pathname, "/docker"),
      navItem(
        "simulators",
        Smartphone,
        "Simulators",
        "Sims",
        targets.simulatorRoute,
        pathname,
        "/simulator",
      ),
      navItem(
        "databases",
        Database,
        "Databases",
        "Data",
        targets.databasesRoute,
        pathname,
        "/database",
      ),
      navItem(
        "clusters",
        Boxes,
        "Clusters",
        "Clusters",
        targets.clustersRoute,
        pathname,
        "/cluster",
      ),
      navItem(
        "usage",
        BarChart3,
        "Usage & Cost",
        "Usage",
        targets.insightsRoute,
        pathname,
        "/insights",
      ),
      targets.supportsForgeHub
        ? navItem("forge", GitPullRequest, "Forge", "Forge", targets.forgeRoute, pathname, "/forge")
        : null,
    ];
    return items.filter((item): item is AppNavItem => item !== null);
  }, [pathname, t, targets]);
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
