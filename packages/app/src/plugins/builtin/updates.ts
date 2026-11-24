import type { QueryClient } from "@tanstack/react-query";
import type { BuiltinPluginListItem } from "@jagentdesk/protocol/builtin-plugins";
import type { SessionOutboundMessage } from "@jagentdesk/protocol/messages";

type Changed = Extract<SessionOutboundMessage, { type: "plugins.builtin.changed" }>;
export interface BuiltinPluginUpdateSource {
  on(type: "plugins.builtin.changed", listener: (event: Changed) => void): () => void;
}
export interface BuiltinPluginQueryState {
  plugins: BuiltinPluginListItem[];
  canManage?: boolean;
}
export const builtinPluginsQueryKey = (serverId: string) => ["builtin-plugins", serverId] as const;

export function observeBuiltinPluginUpdates(
  source: BuiltinPluginUpdateSource,
  queryClient: QueryClient,
  serverId: string,
): () => void {
  return source.on("plugins.builtin.changed", ({ payload }) => {
    queryClient.setQueryData<BuiltinPluginQueryState>(
      builtinPluginsQueryKey(serverId),
      (previous) => (previous ? { ...previous, plugins: payload.plugins } : undefined),
    );
  });
}
