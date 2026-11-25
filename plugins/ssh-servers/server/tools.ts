import { SSH_SERVER_AGENT_LABEL } from "@jagentdesk/protocol/ssh/server-chat-prompt";
import type {
  ForwardingService,
  RemoteDockerHosts,
  SshService,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import {
  createSshAgentTools,
  type RequestToolPermission,
  type SshAgentTool,
  type SshForwardAccess,
  type SshServerDirectory,
  type SshTerminalAccess,
} from "./agent-tools.js";
import { createRemoteDockerTools } from "./remote-docker-tools.js";

function terminalAccess(service: SshService): SshTerminalAccess {
  function session(terminalId: string) {
    const found = service.getSshTerminalSession(terminalId);
    if (!found) throw new Error(`SSH terminal ${terminalId} is not open`);
    return found;
  }
  return {
    list(serverId) {
      return service
        .listSessions()
        .filter((info) => info.serverId === serverId)
        .map((info) => ({
          terminalId: info.terminalId,
          serverId: info.serverId,
          title: service.getSshTerminalSession(info.terminalId)?.getTitle() ?? info.serverId,
        }));
    },
    async send(terminalId, data) {
      session(terminalId).typeInput(data);
    },
    async capture(terminalId, { lines }) {
      const captured = session(terminalId).captureLines({
        start: -lines,
        stripAnsi: true,
      });
      return captured.lines.join("\n");
    },
  };
}

function serverDirectory(service: SshService): SshServerDirectory {
  return {
    async list() {
      const servers = await service.listServerInfos();
      return servers.map((server) => {
        const resolved = service.resolveConfig(server.id);
        return {
          serverId: server.id,
          label: server.label,
          address: server.address,
          port: resolved?.port ?? 22,
          username: resolved?.username ?? null,
          state: server.state,
        };
      });
    },
    async openTerminal(serverId) {
      const terminalId = service.createSession(serverId, { cols: 120, rows: 32 });
      return {
        terminalId,
        serverId,
        title: service.storage.getServer(serverId)?.label ?? serverId,
      };
    },
  };
}

/**
 * ssh_forward_* (spec 25.11) over S3: an agent's forward is a saved rule labelled for the agent,
 * started at once; stopping it removes the rule again.
 */
function forwardAccess(forwarding: ForwardingService): SshForwardAccess {
  return {
    async start(input) {
      const destination =
        input.kind === "dynamic" ? "SOCKS5" : `${input.destHost ?? ""}:${input.destPort ?? 0}`;
      const describe = (port: number) =>
        `${input.kind} ${input.bindAddress}:${port} → ${destination}`;
      const rule = await forwarding.save({
        label: `Agent: ${describe(input.bindPort)}`,
        kind: input.kind,
        serverId: input.serverId,
        bindAddress: input.bindAddress,
        bindPort: input.bindPort,
        ...(input.destHost ? { destHost: input.destHost } : {}),
        ...(input.destPort ? { destPort: input.destPort } : {}),
      });
      const state = await forwarding.start(rule.id);
      if (state.status === "error") {
        await forwarding.delete(rule.id);
        throw new Error(state.error?.message ?? "The forward could not start");
      }
      return { forwardId: rule.id, description: describe(state.boundPort ?? input.bindPort) };
    },
    async stop(forwardId) {
      await forwarding.delete(forwardId);
    },
  };
}

export interface SshToolOwner {
  service: SshService;
  forwarding: ForwardingService;
  docker: RemoteDockerHosts;
  callerAgentId: string | null;
  /** Labels of the caller, to find the server a server-chat agent is bound to. */
  labels: Record<string, string> | null;
  requestPermission: RequestToolPermission;
}

/** The `ssh_*` and server-aware `docker_*` tools for one agent's catalog (spec 25.11). */
export function createSshServerTools(owner: SshToolOwner): SshAgentTool[] {
  const { service, callerAgentId, requestPermission } = owner;
  const defaultServerId = owner.labels?.[SSH_SERVER_AGENT_LABEL] ?? null;
  return [
    ...createSshAgentTools({
      acquire: service.acquireClient,
      callerAgentId,
      defaultServerId,
      requestPermission,
      remoteExecEnabledServers: () => {
        const enabled = new Set<string>();
        for (const server of service.storage.listServers()) {
          if (server.remoteExec?.enabled === true) enabled.add(server.id);
        }
        return enabled;
      },
      terminals: terminalAccess(service),
      forwards: forwardAccess(owner.forwarding),
      servers: serverDirectory(service),
    }),
    ...createRemoteDockerTools({
      hosts: owner.docker,
      callerAgentId,
      defaultServerId,
      requestPermission,
    }),
  ];
}
