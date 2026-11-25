import {
  createDaemonSlot,
  type BuiltinServerHost,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { createRemoteExecAgentTools } from "./agent-tools.js";
import { handleRemoteExecMessage, remoteExecJobUpdated } from "./rpc.js";
import { createRemoteExecService } from "./service.js";
import type { RemoteExecService } from "./types.js";
import { createRemoteExecDeps } from "./wiring.js";

export const REMOTE_EXEC_RPC_METHODS = [
  "remote_exec.check_target.request",
  "remote_exec.get_job.request",
  "remote_exec.list_jobs.request",
  "remote_exec.list_targets.request",
  "remote_exec.read_job_output.request",
  "remote_exec.stop_job.request",
] as const;

/** The daemon's one remote execution engine (spec 33 / ADR-0044); null when it failed to build. */
export const remoteExecEngines = createDaemonSlot<RemoteExecService | null>();

export function register(host: BuiltinServerHost) {
  host.backgroundService((services) => {
    const ssh = services.ssh;
    let engine: RemoteExecService | null = null;
    // TEMP(remote-exec-engine): an engine that fails to come up only disables remote tasks.
    try {
      if (!ssh || !services.daemonId) throw new Error("SSH service is unavailable");
      engine = createRemoteExecService(
        createRemoteExecDeps({
          sshService: ssh,
          homeDir: services.home,
          daemonId: services.daemonId,
          logger: services.logger.child({ module: "remote-exec" }),
        }),
      );
      services.logger.info("Remote-exec service initialized");
    } catch (error) {
      services.logger.warn({ err: error }, "Remote-exec service unavailable");
    }
    remoteExecEngines.set(services, engine);
    let unsubscribe: (() => void) | undefined;
    return {
      start: async () => {
        // Job updates fan out to every trusted session; the emit gate drops sessions whose
        // scopes cannot read them (workspace.read).
        unsubscribe ??= engine?.onJobUpdated((job) =>
          services.broadcastToTrustedSessions?.(remoteExecJobUpdated(job)),
        );
        await engine?.start();
      },
      stop: async () => {
        unsubscribe?.();
        unsubscribe = undefined;
        await engine?.stop();
      },
    };
  });
  host.rpc("remote_exec.", REMOTE_EXEC_RPC_METHODS, (services) => ({
    handle: async (message) => {
      await handleRemoteExecMessage(
        remoteExecEngines.get(services) ?? null,
        message,
        services.push,
      );
    },
    // Jobs belong to the daemon engine, not to the connection.
    stop: () => {},
  }));
  host.agentTools((registerTool, { callerAgentId, services }) => {
    const engine = services ? remoteExecEngines.get(services) : undefined;
    const storage = services?.ssh?.storage;
    const agents = services?.agents;
    if (!engine || !storage || !agents) return;
    for (const tool of createRemoteExecAgentTools({
      service: engine,
      // An advertised tool must work, so the whole set is only offered while at least
      // one SSH server opts into remote tasks (spec 33.7).
      hasEnabledTarget: () => storage.listServers().some((server) => server.remoteExec?.enabled),
      callerCwd: () => (callerAgentId ? agents.cwd(callerAgentId) : null),
      callerAgentId,
      requestPermission: (agentId, request) => agents.requestHostToolPermission(agentId, request),
    })) {
      registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
        tool.handler,
      );
    }
  });
}
