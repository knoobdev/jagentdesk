import path from "node:path";
import type { Logger } from "pino";
import type { SessionOutboundMessage } from "../messages.js";
import type { SshModuleHandler } from "../session/ssh/ssh-session.js";
import { handleForwardingMessage } from "./forwarding/rpc.js";
import { ForwardingService } from "./forwarding/service.js";
import { handleSftpMessage } from "./sftp/rpc.js";
import { SftpService } from "./sftp/service.js";
import type { SshService } from "./ssh-service.js";

// Wires the milestone modules (CONTRACT.md) onto the S1 SSH service: each module gets
// `acquireClient`, its pushes fan out to every client, and its RPC handler joins the
// ssh.* dispatch. One instance per daemon (bootstrap), shared by every session.

export interface SshModulesOptions {
  ssh: SshService;
  jagentdeskHome: string;
  logger?: Logger;
}

export class SshModules {
  readonly sftp: SftpService;
  readonly forwarding: ForwardingService;
  private readonly ssh: SshService;
  private readonly logger: Logger | null;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: SshModulesOptions) {
    this.ssh = options.ssh;
    this.logger = options.logger?.child({ module: "ssh-modules" }) ?? null;
    const sshDir = path.join(options.jagentdeskHome, "ssh");
    const acquire = options.ssh.acquireClient;
    this.sftp = new SftpService({ acquire, sshDir });
    this.forwarding = new ForwardingService({ acquire, sshDir });
  }

  async initialize(): Promise<void> {
    await this.forwarding.initialize();
    const broadcast = (message: SessionOutboundMessage): void => this.ssh.broadcast(message);
    this.unsubscribers.push(
      this.sftp.subscribe((event) => broadcast(event)),
      this.forwarding.subscribe((event) => broadcast(event)),
      // Spec 25.3 step 5 / 25.6: rules attached to a server open when it connects.
      this.ssh.subscribeConnections((event) => {
        if (event.kind !== "connected") return;
        const ruleIds = this.ssh.storage.getServer(event.serverId)?.forwardingRuleIds ?? [];
        if (ruleIds.length === 0) return;
        this.forwarding.startForServer(event.serverId, ruleIds).catch((error: unknown) => {
          this.logger?.warn(
            { serverId: event.serverId, err: error instanceof Error ? error.message : error },
            "auto-start forwarding failed",
          );
        });
      }),
    );
  }

  /** Handlers tried in order for ssh.* messages S1 does not own. */
  handlers(): SshModuleHandler[] {
    return [
      (message, emit) => handleSftpMessage(this.sftp, message, emit),
      (message, emit) => handleForwardingMessage(this.forwarding, message, emit),
    ];
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.sftp.dispose();
    await this.forwarding.dispose();
  }
}
