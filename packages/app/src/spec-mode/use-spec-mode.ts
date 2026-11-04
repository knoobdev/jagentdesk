import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useReplicaQuery } from "@/data/query";
import type { AutorunState } from "@jagentdesk/protocol/messages";
import type { SpecModeState } from "@jagentdesk/protocol/spec-mode";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export function specModeQueryKey(serverId: string, agentId: string) {
  return ["specMode", serverId, agentId] as const;
}

export function autorunQueryKey(serverId: string, agentId: string) {
  return ["autorun", serverId, agentId] as const;
}

/**
 * Spec mode state of one agent (spec 28.5): fetched once, then kept current by the daemon's
 * `agent.spec_mode.state` push. Null until loaded or when the host has no Spec mode.
 */
export function useSpecModeState(serverId: string, agentId: string) {
  const supported = useHostFeature(serverId, "specMode");
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => specModeQueryKey(serverId, agentId), [serverId, agentId]);
  const enabled = supported && client !== null && isConnected;

  const query = useReplicaQuery({
    queryKey,
    enabled,
    pushEvent: "agent.spec_mode.state",
    queryFn: async (): Promise<SpecModeState | null> => {
      if (!client) return null;
      const result = await client.specModeGet(agentId);
      if (result.error) throw new Error(result.error.message);
      return result.state;
    },
  });

  useEffect(() => {
    if (!client || !supported) return undefined;
    return client.subscribeSpecModeState((state) => {
      if (state.agentId === agentId) queryClient.setQueryData(queryKey, state);
    });
  }, [agentId, client, queryClient, queryKey, supported]);

  return { supported, state: query.data ?? null, client, isConnected };
}

/** Autonomous mode state of one agent (spec 20), shared by both composer toggles. */
export function useAutorunState(serverId: string, agentId: string) {
  const supported = useHostFeature(serverId, "autorun");
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => autorunQueryKey(serverId, agentId), [serverId, agentId]);

  const query = useReplicaQuery({
    queryKey,
    enabled: supported && client !== null && isConnected,
    pushEvent: "autorun.stream",
    queryFn: async (): Promise<AutorunState | null> => (client ? client.autorunGet(agentId) : null),
  });

  useEffect(() => {
    if (!client || !supported) return undefined;
    return client.subscribeAutorunStream((state) => {
      if (state.agentId === agentId) queryClient.setQueryData(queryKey, state);
    });
  }, [agentId, client, queryClient, queryKey, supported]);

  return {
    supported,
    state: query.data ?? null,
    client,
    isConnected,
    setState: (state: AutorunState) => queryClient.setQueryData(queryKey, state),
  };
}
