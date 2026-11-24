import type { BuiltinPluginId } from "@jagentdesk/protocol/builtin-plugins";

const RPC_PREFIXES: readonly [BuiltinPluginId, readonly string[]][] = [
  ["bots", ["bots."]],
  ["docker", ["docker/", "docker."]],
  ["clusters", ["cluster/", "cluster."]],
  ["databases", ["database/", "database."]],
  ["ssh-servers", ["ssh."]],
  ["remote-tasks", ["remote_exec."]],
  ["custom-providers", ["providers.custom."]],
  ["figma", ["figma."]],
  ["jira", ["jira."]],
  ["argocd", ["argocd."]],
  ["devices", ["simulator/", "simulator.", "sideload.", "android.install"]],
  ["workbench", ["proxy/", "proxy."]],
  ["forge-hub", ["forge."]],
  ["skills", ["skills/", "skills.", "agent.skills."]],
  ["spec-mode", ["agent.spec_mode."]],
  ["autorun", ["autorun."]],
  ["activity-graph", ["agent.activity_graph."]],
  ["insights", ["usage.history."]],
  ["session-share", ["session.share."]],
  ["browser-tools", ["browser."]],
];
export function builtinPluginForRpc(type: string): BuiltinPluginId | null {
  if (type.startsWith("forge.search.")) return null;
  return (
    RPC_PREFIXES.find(([, prefixes]) => prefixes.some((prefix) => type.startsWith(prefix)))?.[0] ??
    null
  );
}

const TOOL_PREFIXES: readonly [BuiltinPluginId, readonly string[]][] = [
  ["bots", ["bot_"]],
  ["docker", ["docker_"]],
  ["clusters", ["kubectl_", "cluster_"]],
  ["databases", ["sql_", "database_"]],
  ["ssh-servers", ["ssh_"]],
  ["remote-tasks", ["remote_"]],
  ["figma", ["figma_"]],
  ["jira", ["jira_"]],
  ["argocd", ["argocd_"]],
  ["workbench", ["proxy_", "sim_install_batch"]],
  ["devices", ["sim_", "sideload_", "android_install"]],
  ["forge-hub", ["forge_"]],
  ["browser-tools", ["browser_"]],
];
export function builtinPluginForTool(name: string): BuiltinPluginId | null {
  if (/^provider_(add|list|remove|test|update)$/.test(name)) return "custom-providers";
  if (name === "create_skill" || name === "update_skill") return "skills";
  return (
    TOOL_PREFIXES.find(([, prefixes]) => prefixes.some((prefix) => name.startsWith(prefix)))?.[0] ??
    null
  );
}
