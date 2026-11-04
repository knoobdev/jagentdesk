// Agent label that binds a chat agent to one Argo CD instance (spec 30.4): the daemon resolves the
// default `instanceId` of every `argocd_*` tool call from it, and the app files the chat under the
// Argo CD screen, like `jagentdesk.cluster.id` does for cluster chats.
export const ARGOCD_INSTANCE_AGENT_LABEL = "jagentdesk.argocd.instance.id";

const TOOL_PREFIX = "mcp__jagentdesk__";

export interface ArgoCdChatContext {
  instanceId: string;
  displayName: string;
  url: string;
  app: { name: string; appNamespace: string | null; project: string } | null;
  resource: { kind: string; namespace: string; name: string } | null;
  // JAgentDesk cluster (`clu_…`) the app's destination is linked to, when known.
  clusterId: string | null;
}

/** The hidden system prompt of an Argo CD chat (spec 30.4). */
export function buildArgoCdChatSystemPrompt(context: ArgoCdChatContext): string {
  const lines = [
    `You are operating the Argo CD instance "${context.displayName}" (instanceId "${context.instanceId}", ${context.url}).`,
    "Every argocd_* tool call defaults to that instanceId.",
  ];
  if (context.app) {
    const namespace = context.app.appNamespace
      ? `, appNamespace "${context.app.appNamespace}"`
      : "";
    lines.push(
      `The user is looking at application "${context.app.name}" (project "${context.app.project}"${namespace}).`,
    );
  }
  if (context.resource) {
    const namespace = context.resource.namespace ? `${context.resource.namespace}/` : "";
    lines.push(`Selected resource: ${context.resource.kind} ${namespace}${context.resource.name}.`);
  }
  if (context.clusterId) {
    lines.push(
      `The app's destination is the JAgentDesk cluster "${context.clusterId}": ${TOOL_PREFIX}kubectl_get with that clusterId shows what Argo CD does not (describe, raw objects).`,
    );
  }
  lines.push(
    "",
    "Tools (MCP server 'jagentdesk'):",
    `  - read, no approval: ${TOOL_PREFIX}argocd_list_apps, argocd_get_app, argocd_resource_tree, argocd_diff, argocd_manifests, argocd_events, argocd_logs, argocd_history, argocd_list_resource_actions, argocd_can_i, argocd_list_projects, argocd_list_appsets, argocd_list_clusters, argocd_list_repos, argocd_refresh (normal)`,
    `  - need the user's approval: argocd_refresh (hard), argocd_sync (also dryRun), argocd_rollback, argocd_terminate_operation, argocd_resource_action, argocd_delete_resource`,
    "There is no tool to delete an application; the user does that in the app.",
    "To explain a Degraded app: argocd_get_app (conditions, operation), argocd_resource_tree (unhealthy nodes), then argocd_events and argocd_logs of the failing pods.",
    "If a tool is not loaded yet, load it with the ToolSearch tool using `select:<exact name>`.",
    "Wait for the user's question before taking any action.",
  );
  return lines.join("\n");
}
