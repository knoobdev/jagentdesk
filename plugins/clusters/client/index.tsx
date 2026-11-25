import {
  useLocalSearchParams,
  usePathname,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { Boxes } from "lucide-react-native";
import {
  buildClusterWorkloadsRoute,
  buildClustersRoute,
  useClusterNavStore,
  type BuiltinClientHost,
  type BuiltinClientProps,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { ClustersScreen } from "./clusters-screen";
import { ClusterWorkloadsScreen } from "./cluster-workloads-screen";
import { SidebarClusterNav } from "./sidebar-cluster-nav";

// The entry jumps straight back to the cluster the user last had open on that host.
function clustersRoute(serverId: string): string {
  const last = useClusterNavStore.getState().lastCluster;
  return last && last.serverId === serverId
    ? buildClusterWorkloadsRoute(last.serverId, last.clusterId)
    : buildClustersRoute(serverId);
}

function ClusterRouteScreen({ serverId }: BuiltinClientProps) {
  const params = useLocalSearchParams<{ clusterId?: string }>();
  const clusterId = typeof params.clusterId === "string" ? params.clusterId : "";
  return <ClusterWorkloadsScreen serverId={serverId} clusterId={clusterId} />;
}

function ClusterNavigationPanel({ serverId }: BuiltinClientProps) {
  const pathname = usePathname();
  const match = /\/cluster\/([^/?]+)/.exec(pathname);
  return match ? (
    <SidebarClusterNav serverId={serverId} clusterId={decodeURIComponent(match[1])} />
  ) : null;
}

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "clusters",
    title: "Clusters",
    icon: Boxes,
    group: "Tools" as const,
    route: clustersRoute,
    routeSegment: "cluster",
    routeSegments: ["clusters"],
    routeChanges: (listener: () => void) => useClusterNavStore.subscribe(listener),
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.leftPanel("cluster", ClusterNavigationPanel, { ownsNavigation: true });
  app.screen("clusters", ClustersScreen);
  app.screen("cluster", ClusterRouteScreen);
}
