import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  OrchestrationConfig,
  OrchestrationConfigPatch,
  OrchestrationRouteCategory,
} from "@jagentdesk/protocol/orchestration";
import { useReplicaQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

export const orchestrationConfigQueryKey = (serverId: string | null) => [
  "orchestration-config",
  serverId,
];

export function useOrchestration(serverId: string | null) {
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => orchestrationConfigQueryKey(serverId), [serverId]);
  const query = useReplicaQuery({
    queryKey,
    enabled: Boolean(serverId && client && isConnected),
    pushEvent: "status:daemon_config_changed",
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return (await client.getOrchestrationConfig()).config;
    },
  });

  const patchConfig = useCallback(
    async (patch: OrchestrationConfigPatch): Promise<OrchestrationConfig | undefined> => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const config = (await client.patchOrchestrationConfig(patch)).config;
      queryClient.setQueryData(queryKey, config);
      return config;
    },
    [client, queryClient, queryKey],
  );

  const prepareTask = useCallback(
    async (input: {
      rawRequest: string;
      workspaceId?: string;
      cwd?: string;
      routeCategory?: OrchestrationRouteCategory;
    }) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return client.prepareOrchestrationTask(input);
    },
    [client],
  );

  return {
    config: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error instanceof Error ? query.error.message : null,
    patchConfig,
    prepareTask,
  };
}
