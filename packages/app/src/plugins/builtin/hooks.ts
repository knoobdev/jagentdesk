import { mergeBuiltinPluginWireState } from "@jagentdesk/protocol/builtin-plugins";
import { useCallback, useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BuiltinPluginId, BuiltinPluginListItem } from "@jagentdesk/protocol/builtin-plugins";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { builtinPluginEnabled } from "./registry";

export function useBuiltinPluginEnabled(
  serverId: string | null | undefined,
  id: BuiltinPluginId,
): boolean {
  return useSessionStore((state) =>
    builtinPluginEnabled(state.sessions[serverId ?? ""]?.serverInfo, id),
  );
}

export const builtinPluginsQueryKey = (serverId: string) => ["builtin-plugins", serverId] as const;
interface State {
  plugins: BuiltinPluginListItem[];
  canManage?: boolean;
}
export function useBuiltinPlugins(serverId: string) {
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "builtinPlugins");
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => builtinPluginsQueryKey(serverId), [serverId]);
  const query = useFetchQuery({
    queryKey,
    queryFn: async () => {
      if (!client) throw new Error("Host disconnected");
      return client.getBuiltinPluginState();
    },
    enabled: Boolean(client && connected && supported),
    dataShape: "value",
    staleTimeMs: 1_000,
  });
  useEffect(() => {
    if (!client || !supported) return;
    return client.on("plugins.builtin.changed", ({ payload }) => {
      queryClient.setQueryData<State>(queryKey, (previous) =>
        previous ? { ...previous, plugins: mergeBuiltinPluginWireState(payload) } : undefined,
      );
    });
  }, [client, supported, queryClient, queryKey]);
  const set = useCallback(
    async (id: BuiltinPluginId, enabled: boolean, cascade: boolean) => {
      if (!client || !connected) throw new Error("Host disconnected");
      const plugins = await client.setBuiltinPlugin(id, enabled, cascade);
      queryClient.setQueryData<State>(queryKey, (previous) => ({ ...previous, plugins }));
    },
    [client, connected, queryClient, queryKey],
  );
  return { ...query, supported, connected, set };
}
