export type AgentAttentionReason = "finished" | "error" | "permission";

export interface AgentAttentionNotificationData {
  [key: string]: unknown;
  serverId: string;
  workspaceId?: string;
  agentId: string;
  reason: AgentAttentionReason;
}

export interface AgentAttentionNotificationPayload {
  title: string;
  body: string;
  data: AgentAttentionNotificationData;
}

interface BuildAgentAttentionNotificationPayloadInput {
  reason: AgentAttentionReason;
  serverId: string;
  workspaceId: string;
  agentId: string;
  assistantMessage?: string | null;
  permissionRequest?: NotificationPermissionRequest | null;
}

export interface NotificationPermissionRequest {
  id: string;
  provider: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type AssistantTimelineItem =
  | { type: "assistant_message"; text: string }
  | { type: string; text?: string };

export function findLatestAssistantMessageFromTimeline(
  timeline: readonly AssistantTimelineItem[],
): string | null {
  // Providers may stream assistant content in consecutive chunks.
  const chunks: string[] = [];
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const item = timeline[i];
    if (item.type !== "assistant_message" || typeof item.text !== "string") {
      if (chunks.length > 0) {
        break;
      }
      continue;
    }
    chunks.push(item.text);
  }

  if (chunks.length === 0) {
    return null;
  }

  return chunks.toReversed().join("");
}

export function findLatestPermissionRequest(
  pendingPermissions: ReadonlyMap<string, NotificationPermissionRequest>,
): NotificationPermissionRequest | null {
  let latest: NotificationPermissionRequest | null = null;
  for (const request of pendingPermissions.values()) {
    latest = request;
  }
  return latest;
}

function resolveAgentAttentionTitle(reason: AgentAttentionReason): string {
  if (reason === "permission") return "Agent needs permission";
  if (reason === "error") return "Agent needs attention";
  return "Agent finished";
}

function resolveAgentAttentionFallbackBody(reason: AgentAttentionReason): string {
  if (reason === "permission") return "Permission requested.";
  if (reason === "error") return "Encountered an error.";
  return "Finished working.";
}

export function buildAgentAttentionNotificationPayload(
  input: BuildAgentAttentionNotificationPayloadInput,
): AgentAttentionNotificationPayload {
  const title = resolveAgentAttentionTitle(input.reason);
  // Push payloads are content-light by design: never send assistant text,
  // permission descriptions, paths, URLs, or tool input through Expo.
  const body = resolveAgentAttentionFallbackBody(input.reason);

  return {
    title,
    body,
    data: {
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      reason: input.reason,
    },
  };
}
