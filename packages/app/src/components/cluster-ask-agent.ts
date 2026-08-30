import { Alert } from "react-native";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { clusterChatTitle } from "@/utils/cluster-chat-title";
import { useSkillsStore } from "@/stores/skills-store";
import { useAgentSkillsStore } from "@/stores/agent-skills-store";
import { matchSkillsForQuery } from "@/skills/match-skills";
import { applySkillPreamble, buildSkillsPreamble } from "@/skills/skill-injection";

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
 * Best-effort skill injection for a message sent as the first prompt of a
 * NOT-YET-CREATED agent. Only auto-load matching (keyed off the message text)
 * can apply pre-creation; attached-skill injection is tracked per agentId, which
 * doesn't exist yet. Reads store snapshots statically so it works outside React.
 */
function resolveAutoLoadInjectedPrompt(text: string): string {
  if (!useAgentSkillsStore.getState().autoLoad) return text;
  const skills = useSkillsStore.getState().skills;
  const matched = matchSkillsForQuery(skills, text);
  return applySkillPreamble(text, buildSkillsPreamble(matched));
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
    const trimmed = message?.trim();
    // Inject auto-load-matched skills into the first message so cluster "Ask AI"
    // reaches parity with the composer send path. The agent id does not exist yet,
    // so attached-skill injection (which is tracked per agentId) can't apply here —
    // only the auto-load matching that keys off the message text.
    const initialPrompt = trimmed ? resolveAutoLoadInjectedPrompt(trimmed) : trimmed;
    // Title from the first message + cluster (like a normal chat agent's auto-title,
    // but distinguishable per cluster). An explicit `title` still wins.
    const resolvedTitle =
      title ?? (trimmed && clusterName ? clusterChatTitle(clusterName, trimmed) : undefined);
    const agent = await client.createAgent({
      provider,
      cwd,
      systemPrompt: context,
      labels: { "jagentdesk.cluster.id": clusterId },
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
