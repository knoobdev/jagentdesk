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
    onCreated,
  } = input;

  const nsPart = namespace ? ` in namespace "${namespace}"` : "";
  const focus = name
    ? `The user is currently looking at ${kind} "${name}"${nsPart}.`
    : `The user is currently browsing ${kind} resources.`;

  // IMPORTANT: do NOT auto-send a prompt. Attach the cluster context so the
  // agent knows which cluster/tools to use, then open the chat with an empty
  // composer so the user asks their own question.
  const context = [
    `You are operating the Kubernetes cluster with clusterId "${clusterId}".`,
    focus,
    `Use the kubectl_get tool (action get/describe/logs/list) and the kubectl_apply tool, always passing clusterId="${clusterId}".`,
    "Wait for the user's question before taking any action.",
    ...(yaml && name ? ["", `Current manifest of ${kind}/${name}:`, yaml] : []),
  ].join("\n");

  try {
    const trimmed = message?.trim();
    const agent = await client.createAgent({
      provider,
      cwd,
      labels: { "jagentdesk.cluster.id": clusterId },
      // When the user typed a question in the composer, send it as the first
      // message; otherwise open an empty chat for them to type.
      ...(trimmed ? { initialPrompt: trimmed } : {}),
      attachments: [
        {
          type: "text" as const,
          mimeType: "text/plain" as const,
          title: `cluster-${clusterId}-context.txt`,
          text: context,
        },
      ],
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
