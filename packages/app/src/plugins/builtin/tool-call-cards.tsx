import { useMemo } from "react";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import { useSessionStore } from "@/stores/session-store";
import { builtinClientRegistry } from "./loaded";
import type { BuiltinToolCallPlacement } from "./host";

/**
 * The first enabled feature card that recognizes this tool call, or null for the generic
 * rendering. Call it on every render: callers return early on its result.
 */
export function useBuiltinToolCallCard({
  client,
  toolName,
  detail,
  placement,
}: {
  client: DaemonClient | null | undefined;
  toolName: string;
  detail: ToolCallDetail | undefined;
  placement: BuiltinToolCallPlacement;
}) {
  const serverId = client?.getLastServerInfoMessage()?.serverId ?? "";
  const info = useSessionStore((state) => state.sessions[serverId]?.serverInfo);
  const found = useMemo(() => {
    for (const entry of builtinClientRegistry.visible(info).values()) {
      for (const renderer of entry.toolCalls.values()) {
        if (!renderer.placements.includes(placement)) continue;
        const match = renderer.match(toolName, detail);
        if (match !== null) return { Card: renderer.Card, match };
      }
    }
    return null;
  }, [detail, info, placement, toolName]);
  if (!found) return null;
  const { Card, match } = found;
  return <Card client={client ?? null} toolName={toolName} match={match} placement={placement} />;
}
