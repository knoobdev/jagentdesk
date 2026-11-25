import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "@jagentdesk/protocol/agent-title-limits";

// Keep the message-derived part short (matches the daemon's own initial-title
// clamp) so the cluster prefix stays visible instead of being pushed off-screen.
const MAX_MESSAGE_PART_CHARS = 60;

/**
 * A concise, human-readable cluster label for titles/badges. Kube context names
 * are long (e.g. "gke_musashino-rag_asia-northeast1-a_mrag-live"); the last
 * underscore segment ("mrag-live") is the part a human recognises.
 */
export function shortClusterName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "cluster";
  const seg = trimmed.includes("_") ? trimmed.slice(trimmed.lastIndexOf("_") + 1) : trimmed;
  return seg.trim() || trimmed;
}

function firstContentLine(message: string): string | null {
  const line = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  const normalized = line.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Title for a cluster chat agent: the user's first message (like a normal chat
 * agent's auto-title) prefixed with the cluster it belongs to, so the same
 * question against two clusters is distinguishable in the agents list. Returns
 * undefined when the message has no content, so the caller can let the daemon
 * fall back to its own titling.
 */
export function clusterChatTitle(clusterName: string, message: string): string | undefined {
  const body = firstContentLine(message);
  if (!body) return undefined;
  const combined = `${shortClusterName(clusterName)}: ${body.slice(0, MAX_MESSAGE_PART_CHARS).trim()}`;
  return combined.slice(0, MAX_EXPLICIT_AGENT_TITLE_CHARS);
}
