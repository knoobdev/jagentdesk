import { useTranslation } from "react-i18next";
import type { SessionLedger } from "@jagentdesk/protocol/messages";
import { getAgentProviderDefinition } from "@jagentdesk/protocol/provider-manifest";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";

/** The session ledger of an agent (spec 40 §2); refetched whenever the agent's record changes. */
export function useAgentLedger(input: {
  serverId: string;
  agentId: string | null;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  const updatedAt = useSessionStore((state) =>
    input.agentId
      ? (state.sessions[input.serverId]?.agents.get(input.agentId)?.updatedAt.getTime() ?? 0)
      : 0,
  );
  return useFetchQuery<SessionLedger>({
    queryKey: ["agentLedger", input.serverId, input.agentId, updatedAt],
    dataShape: "value",
    staleTimeMs: 0,
    enabled: input.enabled && Boolean(client) && Boolean(input.agentId),
    queryFn: async () => {
      if (!client || !input.agentId) throw new Error(t("common.errors.daemonClientUnavailable"));
      const payload = await client.getAgentLedger(input.agentId);
      if (!payload.ledger) throw new Error(payload.error ?? t("continuity.ledger.loadFailed"));
      return payload.ledger;
    },
  });
}

export function providerDisplayLabel(provider: string): string {
  try {
    return getAgentProviderDefinition(provider).label;
  } catch {
    return provider;
  }
}

/** The daemon wraps handoffs in a tag for the model; the viewer shows the body only. */
export function handoffDisplayText(text: string): string {
  return text
    .replace(/^<jagentdesk-session-handoff>\n?/, "")
    .replace(/\n?<\/jagentdesk-session-handoff>$/, "");
}
