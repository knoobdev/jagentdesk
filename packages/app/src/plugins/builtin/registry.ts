import {
  BUILTIN_PLUGIN_FEATURES,
  type BuiltinPluginId,
} from "@jagentdesk/protocol/builtin-plugins";
import type { DaemonServerInfo } from "@/stores/session-store";

// COMPAT(builtinPlugins): features that daemons advertised before built-in plugin state existed.
const LEGACY_FEATURE_GATES: Partial<Record<BuiltinPluginId, string>> = { argocd: "argocd" };

export function builtinPluginEnabled(
  info: DaemonServerInfo | null | undefined,
  id: BuiltinPluginId,
): boolean {
  // COMPAT(builtinPlugins): added in v0.9.59; remove after 2027-05-24 once daemon floor supports feature gates.
  if (info?.features?.builtinPlugins !== true) {
    const legacy = LEGACY_FEATURE_GATES[id];
    const features = info?.features as Readonly<Record<string, unknown>> | undefined;
    return legacy ? features?.[legacy] === true : true;
  }
  const feature = BUILTIN_PLUGIN_FEATURES[id][0];
  return feature !== undefined && info.features[feature] === true;
}

const ROUTE_PLUGINS: Readonly<Record<string, BuiltinPluginId>> = {
  bots: "bots",
  docker: "docker",
  clusters: "clusters",
  cluster: "clusters",
  databases: "databases",
  database: "databases",
  servers: "ssh-servers",
  skills: "skills",
  jira: "jira",
  argocd: "argocd",
  simulator: "devices",
  proxy: "workbench",
  forge: "forge-hub",
  insights: "insights",
};
export function builtinPluginForRoute(pathname: string): BuiltinPluginId | null {
  const hostLeaf = /^\/h\/[^/]+\/([^/?]+)/.exec(pathname)?.[1];
  return hostLeaf ? (ROUTE_PLUGINS[hostLeaf] ?? null) : null;
}
