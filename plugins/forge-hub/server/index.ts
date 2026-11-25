import path from "node:path";
import {
  FileSecretStore,
  type BuiltinServerHost,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { registerForgeTools } from "./agent-tools.js";
import { FORGE_HUB_REQUEST_TYPES, ForgeHubService, ForgeHubSession } from "./forge-hub-session.js";

/** Token secrets and the token-connection index (connections.json) live under <home>/forge. */
function forgeSecretDir(home: string): string {
  return path.resolve(home, "forge");
}

export function register(host: BuiltinServerHost) {
  // One daemon-wide service shared by every agent's forge_* tools (spec 19 / ADR-0015).
  const daemon = host.backgroundService((core) => {
    const directory = forgeSecretDir(core.home);
    return {
      service: new ForgeHubService(new FileSecretStore(directory), directory),
      start() {},
      stop() {},
    };
  });
  // Repo-scoped remote-forge reads and writes; device-flow sign-ins are session-owned.
  host.rpc("forge.", FORGE_HUB_REQUEST_TYPES, (services) => {
    const directory = forgeSecretDir(services.home);
    const session = new ForgeHubSession({
      host: { emit: (message) => services.push(message) },
      secretStore: new FileSecretStore(directory),
      secretStoreDir: directory,
      logger: services.logger,
    });
    return {
      handle: (message) => session.handle(message as Parameters<ForgeHubSession["handle"]>[0]),
      stop: () => session.stop(),
    };
  });
  // Reads auto-run; writes raise the host tool permission card.
  host.agentTools(
    (registerTool, context) =>
      registerForgeTools({
        registerTool,
        options: {
          forgeHub: context.service(daemon)?.service,
          requestHostToolPermission: context.requestPermission,
        },
        callerAgentId: context.callerAgentId ?? undefined,
      }),
    { slot: "late" },
  );
}
