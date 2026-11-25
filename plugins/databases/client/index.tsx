import {
  useLocalSearchParams,
  usePathname,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { Database } from "lucide-react-native";
import {
  buildDatabaseBrowseRoute,
  buildDatabasesRoute,
  type BuiltinClientHost,
  type BuiltinClientProps,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { DatabasesScreen } from "./databases-screen";
import { DatabaseBrowseScreen } from "./database-browse-screen";
import { SidebarDatabaseNav } from "./sidebar-database-nav";
import { useDatabaseNavStore } from "./database-nav-store";

// The entry jumps straight back to the database the user last had open on that host.
function databasesRoute(serverId: string): string {
  const last = useDatabaseNavStore.getState().lastDatabase;
  return last && last.serverId === serverId
    ? buildDatabaseBrowseRoute(last.serverId, last.databaseId)
    : buildDatabasesRoute(serverId);
}

function DatabaseRouteScreen({ serverId }: BuiltinClientProps) {
  const params = useLocalSearchParams<{ databaseId?: string }>();
  const databaseId = typeof params.databaseId === "string" ? params.databaseId : "";
  return <DatabaseBrowseScreen serverId={serverId} databaseId={databaseId} />;
}

function DatabaseNavigationPanel({ serverId }: BuiltinClientProps) {
  const pathname = usePathname();
  const match = /\/database\/([^/?]+)/.exec(pathname);
  return match ? (
    <SidebarDatabaseNav serverId={serverId} databaseId={decodeURIComponent(match[1])} />
  ) : null;
}

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "databases",
    title: "Databases",
    shortTitle: "Data",
    icon: Database,
    group: "Tools" as const,
    route: databasesRoute,
    routeSegment: "database",
    routeSegments: ["databases"],
    routeChanges: (listener: () => void) => useDatabaseNavStore.subscribe(listener),
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.leftPanel("database", DatabaseNavigationPanel, { ownsNavigation: true });
  app.screen("databases", DatabasesScreen);
  app.screen("database", DatabaseRouteScreen);
}
