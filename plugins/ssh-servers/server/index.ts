import type { BuiltinServerHost } from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { SshSession } from "./session.js";
import { createSshServerTools } from "./tools.js";
import { createSshLifecycle } from "./lifecycle.js";

/** Every inbound ssh.* request (spec 25.12): S1 inventory/keychain/connect and the S2–S8 modules. */
export const SSH_RPC_METHODS = [
  "ssh.auth.respond.request",
  "ssh.docker.attach.request",
  "ssh.docker.detach.request",
  "ssh.environment.detect.request",
  "ssh.forward.delete.request",
  "ssh.forward.list.request",
  "ssh.forward.save.request",
  "ssh.forward.start.request",
  "ssh.forward.stop.request",
  "ssh.groups.delete.request",
  "ssh.groups.get.request",
  "ssh.groups.list.request",
  "ssh.groups.save.request",
  "ssh.history.clear.request",
  "ssh.history.list.request",
  "ssh.hostkey.respond.request",
  "ssh.identities.delete.request",
  "ssh.identities.get.request",
  "ssh.identities.list.request",
  "ssh.identities.save.request",
  "ssh.import.apply.request",
  "ssh.import.preview.request",
  "ssh.keys.delete.request",
  "ssh.keys.export_public.request",
  "ssh.keys.generate.request",
  "ssh.keys.import.request",
  "ssh.keys.install_to_server.request",
  "ssh.keys.list.request",
  "ssh.knownhosts.delete.request",
  "ssh.knownhosts.list.request",
  "ssh.knownhosts.replace.request",
  "ssh.logs.bookmark.request",
  "ssh.logs.list.request",
  "ssh.logs.read.request",
  "ssh.logs.search.request",
  "ssh.logs.set_enabled.request",
  "ssh.logs.update_bookmark.request",
  "ssh.remote_db.prepare.request",
  "ssh.remote_k8s.import.request",
  "ssh.servers.delete.request",
  "ssh.servers.get.request",
  "ssh.servers.list.request",
  "ssh.servers.save.request",
  "ssh.session.broadcast.request",
  "ssh.session.create.request",
  "ssh.session.reconnect.request",
  "ssh.session.type_password.request",
  "ssh.sftp.chmod.request",
  "ssh.sftp.copy.request",
  "ssh.sftp.delete.request",
  "ssh.sftp.download.request",
  "ssh.sftp.list.request",
  "ssh.sftp.mkdir.request",
  "ssh.sftp.read.request",
  "ssh.sftp.rename.request",
  "ssh.sftp.stat.request",
  "ssh.sftp.write.request",
  "ssh.snippet.cancel.request",
  "ssh.snippet.get_run.request",
  "ssh.snippet.list_runs.request",
  "ssh.snippet.run.request",
  "ssh.snippets.delete.request",
  "ssh.snippets.delete_package.request",
  "ssh.snippets.list.request",
  "ssh.snippets.save.request",
  "ssh.snippets.save_package.request",
  "ssh.transfer.cancel.request",
  "ssh.transfer.dismiss.request",
  "ssh.transfer.list.request",
  "ssh.transfer.pause.request",
  "ssh.transfer.resume.request",
  "ssh.transfer.start.request",
  "ssh.workspaces.delete.request",
  "ssh.workspaces.list.request",
  "ssh.workspaces.save.request",
] as const;

export function register(host: BuiltinServerHost) {
  host.rpc("ssh.", SSH_RPC_METHODS, (services) => {
    const sshService = services.ssh;
    if (!sshService) throw new Error("SSH service is unavailable");
    const session = new SshSession({
      host: { emit: (message) => services.push(message) },
      sshService,
      logger: services.logger,
    });
    return {
      handle: (message) => session.handleMessage(message),
      // Connection state lives in the daemon-wide pool; the session owns no resources.
      stop: () => {},
    };
  });
  host.backgroundService((services) => createSshLifecycle(services));
  host.agentTools((registerTool, { callerAgentId, services }) => {
    const service = services?.ssh;
    const modules = service?.modules;
    const agents = services?.agents;
    if (!service || !modules || !agents) return;
    for (const tool of createSshServerTools({
      service,
      forwarding: modules.forwarding,
      docker: modules.docker,
      callerAgentId,
      labels: callerAgentId ? agents.labels(callerAgentId) : null,
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
