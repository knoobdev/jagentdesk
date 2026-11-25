import {
  useLocalSearchParams,
  usePathname,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { Ship } from "lucide-react-native";
import {
  buildArgoCdRoute,
  type BuiltinClientHost,
  type BuiltinClientProps,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { ArgoCdInstancesScreen } from "./instances-screen";
import { ArgoCdAppsScreen } from "./apps-screen";
import { ArgoCdAppDetailScreen } from "./app-detail-screen";
import { SidebarArgoCdNav } from "./sidebar-argocd-nav";
import { ArgoCdSsoDelegatePrompt } from "./sso-delegate-prompt";

function InstanceRouteScreen({ serverId }: BuiltinClientProps) {
  const params = useLocalSearchParams<{ instanceId?: string }>();
  const instanceId = typeof params.instanceId === "string" ? params.instanceId : "";
  return <ArgoCdAppsScreen key={instanceId} serverId={serverId} instanceId={instanceId} />;
}

function AppRouteScreen({ serverId }: BuiltinClientProps) {
  const params = useLocalSearchParams<{ instanceId?: string; name?: string; ns?: string }>();
  const instanceId = typeof params.instanceId === "string" ? params.instanceId : "";
  const name = typeof params.name === "string" ? params.name : "";
  const appNamespace = typeof params.ns === "string" && params.ns ? params.ns : null;
  return (
    <ArgoCdAppDetailScreen
      key={`${instanceId}/${appNamespace ?? ""}/${name}`}
      serverId={serverId}
      instanceId={instanceId}
      name={name}
      appNamespace={appNamespace}
    />
  );
}

/** `/h/<serverId>/argocd[/<instanceId>[/app]]` → the open instance. */
function ArgoCdNavigationPanel({ serverId }: BuiltinClientProps) {
  const pathname = usePathname();
  const instance = /\/argocd\/([^/?]+)/.exec(pathname)?.[1];
  return (
    <SidebarArgoCdNav
      serverId={serverId}
      instanceId={instance ? decodeURIComponent(instance) : null}
    />
  );
}

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "argocd",
    title: "Argo CD",
    icon: Ship,
    group: "Tools" as const,
    route: buildArgoCdRoute,
    routeSegment: "argocd",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.leftPanel("argocd", ArgoCdNavigationPanel, { ownsNavigation: true, section: true });
  app.screen("argocd", ArgoCdInstancesScreen);
  app.screen("argocd/instance", InstanceRouteScreen);
  app.screen("argocd/app", AppRouteScreen);
  // A desktop client runs the SSO loopback when another device signs in (spec 30.2.2).
  app.hostMount("sso-delegate", ArgoCdSsoDelegatePrompt);
}
