import { Alert } from "react-native";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { navigateToAgent } from "@/utils/navigate-to-agent";

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
   * When provided, the created agent is handed back instead of navigating to a
   * full agent tab. The cluster/workloads view uses this to open the chat in a
   * slide-in dock so the k8s resources stay on screen.
   */
  onCreated?: (agent: { id: string; workspaceId: string | null }) => void;
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
    onCreated,
  } = input;

  const nsPart = namespace ? ` in namespace "${namespace}"` : "";
  const focus = name
    ? `The user is currently looking at ${kind} "${name}"${nsPart}.`
    : `The user is currently browsing ${kind} resources.`;

  // The cluster context is a HIDDEN system prompt (appendSystemPrompt), never a
  // visible message/attachment — so the chat opens empty and "ready", not like a
  // conversation already happened. The agent waits for the user's question.
  const context = [
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

  try {
    const trimmed = message?.trim();
    const agent = await client.createAgent({
      provider,
      cwd,
      systemPrompt: context,
      labels: { "jagentdesk.cluster.id": clusterId },
      // When the user typed a question in the composer, send it as the first
      // message; otherwise open an empty chat for them to type.
      ...(trimmed ? { initialPrompt: trimmed } : {}),
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
