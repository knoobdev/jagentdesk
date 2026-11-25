import type { BuiltinServerHost } from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { createCustomProviderAgentTools } from "./agent-tools.js";
import { handleCustomProvidersMessage } from "./rpc.js";

export const CUSTOM_PROVIDERS_RPC_METHODS = [
  "providers.custom.delete.request",
  "providers.custom.list.request",
  "providers.custom.save.request",
  "providers.custom.test.request",
] as const;

/**
 * Custom API providers (spec 34). The provider records, secrets, SSH forwarders and the
 * spawn-time materializers stay in core with the agent provider runtime; this feature owns
 * their settings RPCs, the provider_* tools and closing the forwarders when it turns off.
 */
export function register(host: BuiltinServerHost) {
  host.rpc("providers.custom.", CUSTOM_PROVIDERS_RPC_METHODS, (services) => ({
    handle: async (message) => {
      await handleCustomProvidersMessage(services.customProviders ?? null, message, services.push);
    },
    stop: () => {},
  }));
  host.backgroundService((services) => ({
    start: () => {},
    stop: () => services.closeCustomProviderForwards?.(),
  }));
  host.agentTools((registerTool, { callerAgentId, services }) => {
    const service = services?.customProviders;
    const agents = services?.agents;
    if (!service || !agents) return;
    for (const tool of createCustomProviderAgentTools({
      service,
      callerAgentId,
      requestPermission: (agentId, request) => agents.requestHostToolPermission(agentId, request),
      sshServerLabel: (id) => services.ssh?.storage.getServer(id)?.label ?? null,
    })) {
      registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
        tool.handler,
      );
    }
  });
}
