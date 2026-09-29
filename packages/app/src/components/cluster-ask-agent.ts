import { createDockWorkspace } from "@/components/dock-workspace";
import { CLUSTER_AGENT_LABEL } from "@/utils/dock-agents";
import { Alert } from "react-native";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { clusterChatTitle } from "@/utils/cluster-chat-title";

export interface AskAgentAboutResourceInput {
  client: DaemonClient;
  serverId: string;
  clusterId: string;
  kind: string;
  namespace?: string;
  name?: string;
  yaml?: string;
  /** Currently-visible logs for the focused resource, attached as context. */
  logs?: string;
  provider: string;
  cwd: string;
  /** The question the user typed in the cluster composer. Sent as the first message. */
  message?: string;
  /**
   * The cluster's display name. When a first message is present and no explicit
   * title is given, the agent is titled "<cluster>: <message>" so cluster chats
   * read like normal chat agents (title from content) yet stay distinguishable
   * per cluster in the agents list.
   */
  clusterName?: string;
  /**
   * Explicit title override. Normally omitted — the title is derived from the
   * first message + clusterName. Only pass this to force a specific title.
   */
  title?: string;
  /**
   * When provided, the created agent is handed back instead of navigating to a
   * full agent tab. The cluster/workloads view uses this to open the chat in a
   * slide-in dock so the k8s resources stay on screen.
   */
  onCreated?: (agent: { id: string; workspaceId: string | null }) => void;
}

/**
 * The hidden system prompt that binds an agent to one cluster: which clusterId to
 * operate, to prefer the dedicated MCP kubectl tools, and (optionally) the
 * resource/manifest/logs the user is currently viewing. Shared by "Ask AI" and
 * the cluster chat composer so both create identically-grounded agents.
 */
export function buildClusterSystemPrompt(input: {
  clusterId: string;
  kind: string;
  namespace?: string;
  name?: string;
  yaml?: string;
  logs?: string;
}): string {
  const { clusterId, kind, namespace, name, yaml, logs } = input;
  const nsPart = namespace ? ` in namespace "${namespace}"` : "";
  const focus = name
    ? `The user is currently looking at ${kind} "${name}"${nsPart}.`
    : `The user is currently browsing ${kind} resources.`;
  return [
    `You are operating the Kubernetes cluster with clusterId "${clusterId}".`,
    focus,
    "PREFER the dedicated cluster tools for every read or change — they talk to the",
    "exact cluster the user connected in the app, which may not be in any local",
    "kubeconfig. They are provided by the 'jagentdesk' MCP server, so their exact",
    "tool names are:",
    `  • mcp__jagentdesk__kubectl_get   — action get/describe/logs/list, clusterId="${clusterId}"`,
    `  • mcp__jagentdesk__kubectl_apply — for changes, clusterId="${clusterId}"`,
    "If a tool is not already loaded, load it first with the ToolSearch tool using",
    "the exact query `select:mcp__jagentdesk__kubectl_get` (or the apply variant),",
    "then call it. Only if that genuinely fails may you fall back to the kubectl CLI",
    "via Bash — but the dedicated tools are more reliable and target the right cluster.",
    "Wait for the user's question before taking any action.",
    ...(yaml && name ? ["", `Current manifest of ${kind}/${name}:`, yaml] : []),
    ...(logs ? ["", `Current logs the user is viewing for ${name ?? kind}:`, logs] : []),
  ].join("\n");
}

export async function askAgentAboutResource(input: AskAgentAboutResourceInput): Promise<void> {
  const {
    client,
    serverId,
    clusterId,
    kind,
    namespace,
    name,
    yaml,
    provider,
    cwd,
    message,
    logs,
    clusterName,
    title,
    onCreated,
  } = input;

  // The cluster context is a HIDDEN system prompt (appendSystemPrompt), never a
  // visible message/attachment — so the chat opens empty and "ready", not like a
  // conversation already happened. The agent waits for the user's question.
  const context = buildClusterSystemPrompt({ clusterId, kind, namespace, name, yaml, logs });

  try {
    // The first message goes out as `initialPrompt` of the new agent. Skills are
    // not invoked on it: native skills (spec 22.7) ride on `send_agent_message`
    // `skillIds`, which agent creation does not carry. Follow-up messages from the
    // cluster chat dock pass attached/auto-loaded skills as usual.
    const initialPrompt = message?.trim();
    // Title from the first message + cluster (like a normal chat agent's auto-title,
    // but distinguishable per cluster). An explicit `title` still wins.
    const resolvedTitle =
      title ??
      (initialPrompt && clusterName ? clusterChatTitle(clusterName, initialPrompt) : undefined);
    // Its own workspace in the project, so the chat is listed under the project.
    const home = await createDockWorkspace({ client, serverId, cwd, title: resolvedTitle });
    const agent = await client.createAgent({
      provider,
      cwd: home.cwd,
      workspaceId: home.workspaceId,
      systemPrompt: context,
      labels: { [CLUSTER_AGENT_LABEL]: clusterId },
      ...(resolvedTitle ? { title: resolvedTitle } : {}),
      // When the user typed a question in the composer, send it as the first
      // message; otherwise open an empty chat for them to type.
      ...(initialPrompt ? { initialPrompt } : {}),
    });

    if (onCreated) {
      // Keep the k8s view: open the conversation in the cluster chat dock.
      const workspaceId =
        typeof (agent as { workspaceId?: unknown }).workspaceId === "string"
          ? (agent as { workspaceId: string }).workspaceId
          : null;
      onCreated({ id: agent.id, workspaceId });
      return;
    }

    // Land on the chat with the composer focused — the user types the question.
    navigateToAgent({ serverId, agentId: agent.id });
  } catch (e: unknown) {
    const errMessage = e instanceof Error ? e.message : "Failed to create agent";
    Alert.alert("Agent Error", errMessage);
  }
}
