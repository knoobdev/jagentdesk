// Wiring helpers: builds the RemoteExecDeps contract (spec 33) from the existing SSH modules —
// the server store for targets, the same client lease the ssh_* tools use, live connection
// state and the detected environment (spec 25.10). No new state is invented here.
import { ServerEnvironmentSchema } from "@jagentdesk/protocol/ssh/environment-schemas";
import type { Logger } from "pino";
import type { SshService } from "../ssh/ssh-service.js";
import type { RemoteExecDeps, RemoteExecServerConfig } from "./types.js";

function toServerConfig(server: {
  id: string;
  label: string;
  address: string;
  via?: "direct" | "tailnet";
  remoteExec?: { enabled: boolean; workRoot?: string };
}): RemoteExecServerConfig {
  return {
    id: server.id,
    label: server.label,
    address: server.address,
    ...(server.via ? { via: server.via } : {}),
    ...(server.remoteExec ? { remoteExec: server.remoteExec } : {}),
  };
}

export function createRemoteExecDeps(params: {
  sshService: SshService;
  homeDir: string;
  daemonId: string;
  logger: Logger;
}): RemoteExecDeps {
  const { sshService } = params;
  return {
    homeDir: params.homeDir,
    daemonId: params.daemonId,
    async getServer(serverId) {
      const server = sshService.storage.getServer(serverId);
      return server ? toServerConfig(server) : null;
    },
    async listServers() {
      return sshService.storage.listServers().map(toServerConfig);
    },
    // The same authenticated-client lease the ssh_* agent tools use (spec 25.3).
    acquireClient: (serverId) => sshService.acquireClient(serverId),
    connectionState: (serverId) => sshService.serverState(serverId),
    // ServerEnvironment (spec 25.10) as detected onto the server record; null when absent/invalid.
    environment: (serverId) => {
      const parsed = ServerEnvironmentSchema.safeParse(
        sshService.storage.getServer(serverId)?.environment,
      );
      return parsed.success ? parsed.data : null;
    },
    logger: params.logger,
  };
}
