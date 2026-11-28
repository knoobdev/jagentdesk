import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SessionLedger } from "@jagentdesk/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

/**
 * The session ledger of an agent (spec 40 §2), fetched when enabled. With `follow`, it is
 * refetched in the background whenever the agent's record changes, and the last ledger stays on
 * screen meanwhile. The key must not carry `updatedAt`: the daemon stamps it on every streamed
 * event, so a new key per update left the ledger empty ("Loading…") on every chunk.
 */
export function useAgentLedger(input: {
  serverId: string;
  agentId: string | null;
  enabled: boolean;
  follow: boolean;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  const enabled = input.enabled && Boolean(client) && Boolean(input.agentId);
  const query = useFetchQuery<SessionLedger>({
    queryKey: ["agentLedger", input.serverId, input.agentId],
    dataShape: "value",
    staleTimeMs: 0,
    enabled,
    queryFn: async () => {
      if (!client || !input.agentId) throw new Error(t("common.errors.daemonClientUnavailable"));
      const payload = await client.getAgentLedger(input.agentId);
      if (!payload.ledger) throw new Error(payload.error ?? t("continuity.ledger.loadFailed"));
      return payload.ledger;
    },
  });
  const updatedAt = useSessionStore((state) =>
    input.follow && input.agentId
      ? (state.sessions[input.serverId]?.agents.get(input.agentId)?.updatedAt.getTime() ?? 0)
      : 0,
  );
  const { refetch } = query;
  const followedAt = useRef(updatedAt);
  useEffect(() => {
    if (followedAt.current === updatedAt) return;
    followedAt.current = updatedAt;
    // One fetch at a time: a streaming agent updates faster than the ledger round trip.
    if (enabled) void refetch({ cancelRefetch: false });
  }, [enabled, refetch, updatedAt]);
  return query;
}

export { providerDisplayLabel } from "./provider-model-choices";

/** The daemon wraps handoffs in a tag for the model; the viewer shows the body only. */
export function handoffDisplayText(text: string): string {
  return text
    .replace(/^<jagentdesk-session-handoff>\n?/, "")
    .replace(/\n?<\/jagentdesk-session-handoff>$/, "");
}
