import { createJAgentDeskApi, type JAgentDeskApi } from "@jagentdesk/client";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

export interface PluginSurfaceRuntime {
  jagentdesk: JAgentDeskApi;
  invoke(method: string, input: unknown): Promise<unknown>;
}

export function createPluginSurfaceRuntime(
  client: DaemonClient | null,
  pluginId: string,
): PluginSurfaceRuntime | null {
  if (!client) return null;
  return {
    jagentdesk: createJAgentDeskApi(client),
    invoke: (method, input) => client.invokePluginRpc(pluginId, method, input),
  };
}
