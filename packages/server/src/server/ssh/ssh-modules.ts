import path from "node:path";
import type { Logger } from "pino";
import type { SessionOutboundMessage } from "../messages.js";
import type { SshModuleHandler } from "../session/ssh/ssh-session.js";
import { handleForwardingMessage } from "./forwarding/rpc.js";
import type { ForwardingService } from "./forwarding/service.js";
import { handleSftpMessage } from "./sftp/rpc.js";
import { SftpService } from "./sftp/service.js";
import { CommandLineTracker } from "./snippets/command-line.js";
import { handleSnippetsMessage } from "./snippets/rpc.js";
import { SshSnippetsService } from "./snippets/service.js";
import type { SshService, SshTerminalCreatedEvent } from "./ssh-service.js";
import { createTelnetTerminalSession } from "./telnet/terminal-session.js";
import { connectThroughProxy as connectThroughProxyModule } from "./proxy/connect.js";
import { ProxyError as ModuleProxyError } from "./proxy/proxy-error.js";
import { SshConnectionError } from "./ssh-connection.js";

// A hidden-input prompt on screen: what the user types next is a secret, never history.
const SECRET_PROMPT = /(password|passphrase|passcode|pin|otp|verification code)[^\n]*[:?]\s*$/i;
const OUTPUT_TAIL_CHARS = 200;
const CSI_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[A-Za-z]`, "g");

function stripCsi(text: string): string {
  return text.replace(CSI_SEQUENCE, "");
}

// Wires the milestone modules (CONTRACT.md) onto the S1 SSH service: each module gets
// `acquireClient`, its pushes fan out to every client, and its RPC handler joins the
// ssh.* dispatch. One instance per daemon (bootstrap), shared by every session.

export interface SshModulesOptions {
  ssh: SshService;
  jagentdeskHome: string;
  logger?: Logger;
  /** The daemon's one ForwardingService (owned and initialized by ssh/modules.ts). */
  forwarding: ForwardingService;
}

export class SshModules {
  readonly sftp: SftpService;
  readonly forwarding: ForwardingService;
  readonly snippets: SshSnippetsService;
  private readonly ssh: SshService;
  private readonly logger: Logger | null;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(options: SshModulesOptions) {
    this.ssh = options.ssh;
    this.logger = options.logger?.child({ module: "ssh-modules" }) ?? null;
    const sshDir = path.join(options.jagentdeskHome, "ssh");
    const acquire = options.ssh.acquireClient;
    this.sftp = new SftpService({ acquire, sshDir });
    this.forwarding = options.forwarding;
    this.snippets = new SshSnippetsService({ acquire, sshHome: sshDir });
    // Spec 25.3 step 2 uses the proxy module; step 5's startup snippet comes from S5.
    this.ssh.configurePipeline({
      connectSteps: {
        openProxySocket: async (proxy, host, port) => {
          try {
            return await connectThroughProxyModule(proxy, { host, port });
          } catch (error) {
            if (error instanceof ModuleProxyError) {
              throw new SshConnectionError({ code: error.code, message: error.message });
            }
            throw error;
          }
        },
      },
      resolveStartupScript: async (snippetId) => {
        const library = await this.snippets.listLibrary();
        return library.snippets.find((snippet) => snippet.id === snippetId)?.script ?? null;
      },
    });
    // Spec 25.3 Telnet: plain TCP sessions from the Telnet module.
    this.ssh.registerSessionFactory("telnet", (input) =>
      createTelnetTerminalSession({
        id: input.terminalId,
        address: input.host,
        port: input.port,
        cols: input.size.cols,
        rows: input.size.rows,
        name: input.label,
      }),
    );
  }

  async initialize(): Promise<void> {
    const broadcast = (message: SessionOutboundMessage): void => this.ssh.broadcast(message);
    this.unsubscribers.push(
      this.sftp.subscribe((event) => broadcast(event)),
      this.forwarding.subscribe((event) => broadcast(event)),
      this.snippets.subscribe((event) => broadcast(event)),
      this.ssh.subscribeTerminalCreated((event) => this.trackCommandHistory(event)),
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
      (message, emit) => handleSnippetsMessage(this.snippets, message, emit),
    ];
  }

  /**
   * Spec 25.7: commands sent from a terminal tab go to the server's history. Lines typed
   * right after a password-like prompt are skipped so secrets never reach history.
   */
  private trackCommandHistory(event: SshTerminalCreatedEvent): void {
    const tracker = new CommandLineTracker();
    let tail = "";
    event.session.tapOutput((data) => {
      tail = (tail + data).slice(-OUTPUT_TAIL_CHARS);
    });
    event.session.tapInput((data) => {
      if (SECRET_PROMPT.test(stripCsi(tail))) {
        tracker.reset();
        return;
      }
      for (const command of tracker.push(data)) {
        this.snippets
          .recordCommand({ serverId: event.serverId, command, source: "input" })
          .catch(() => undefined);
      }
    });
  }

  async dispose(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.sftp.dispose();
    await this.snippets.dispose();
  }
}
