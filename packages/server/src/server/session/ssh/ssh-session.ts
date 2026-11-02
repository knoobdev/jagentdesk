import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { SshService } from "../../ssh/ssh-service.js";

export interface SshSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

/** A milestone module's RPC handler (CONTRACT.md): returns false when the message is not its own. */
export type SshModuleHandler = (
  message: SessionInboundMessage,
  emit: (msg: SessionOutboundMessage) => void,
) => Promise<boolean>;

export interface SshSessionOptions {
  host: SshSessionHost;
  sshService: SshService;
  logger: pino.Logger;
  /** Handlers of the S2–S8 modules, tried in order for ssh.* messages S1 does not own. */
  moduleHandlers?: readonly SshModuleHandler[];
}

type Req<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The SSH RPC surface (spec 25.12, S1 + S4): servers, groups, identities, keys, known
 * hosts, connect prompts, sessions. Every handler emits its response — an error
 * response on failure, never a throw into the socket loop. Secrets are never echoed:
 * only `hasPassword`/`hasPassphrase` and public material leave the daemon. Request
 * bodies are never logged (they can carry passwords, keys or prompt answers).
 */
export class SshSession {
  private readonly host: SshSessionHost;
  private readonly service: SshService;
  private readonly logger: pino.Logger;
  private readonly moduleHandlers: readonly SshModuleHandler[];

  constructor(options: SshSessionOptions) {
    this.host = options.host;
    this.service = options.sshService;
    this.logger = options.logger;
    this.moduleHandlers = options.moduleHandlers ?? [];
  }

  handleMessage(msg: SessionInboundMessage): Promise<void> | undefined {
    const handled = this.handleCore(msg);
    if (handled) return handled;
    if (this.moduleHandlers.length === 0) return undefined;
    return this.handleModules(msg);
  }

  private async handleModules(msg: SessionInboundMessage): Promise<void> {
    const emit = (out: SessionOutboundMessage): void => this.host.emit(out);
    for (const handler of this.moduleHandlers) {
      try {
        if (await handler(msg, emit)) return;
      } catch (error) {
        this.logger.warn({ err: errorMessage(error), type: msg.type }, "ssh module rpc failed");
        return;
      }
    }
  }

  private handleCore(msg: SessionInboundMessage): Promise<void> | undefined {
    return this.handleInventory(msg) ?? this.handleKeychain(msg) ?? this.handleConnect(msg);
  }

  /** servers, groups, identities */
  private handleInventory(msg: SessionInboundMessage): Promise<void> | undefined {
    const s = this.service;
    switch (msg.type) {
      case "ssh.servers.list.request":
        return this.respond(
          msg,
          "ssh.servers.list.response",
          async () => ({
            servers: await s.listServerInfos(),
            groups: await s.listGroups(),
            identities: await s.listIdentities(),
            sessions: s.listSessions(),
          }),
          { servers: [], groups: [], identities: [], sessions: [] },
        );
      case "ssh.servers.get.request":
        return this.respond(
          msg,
          "ssh.servers.get.response",
          async () => ({ server: await s.getServerInfo(msg.id) }),
          { server: null },
        );
      case "ssh.servers.save.request":
        return this.respond(
          msg,
          "ssh.servers.save.response",
          async () => ({
            server: await s.saveServer(msg.server, {
              ...(msg.password !== undefined ? { password: msg.password } : {}),
              ...(msg.proxyPassword !== undefined ? { proxyPassword: msg.proxyPassword } : {}),
            }),
          }),
          { server: null },
        );
      case "ssh.servers.delete.request":
        return this.respond(
          msg,
          "ssh.servers.delete.response",
          async () => {
            await s.deleteServer(msg.id);
            return {};
          },
          {},
        );

      case "ssh.groups.list.request":
        return this.respond(
          msg,
          "ssh.groups.list.response",
          async () => ({ groups: await s.listGroups() }),
          { groups: [] },
        );
      case "ssh.groups.get.request":
        return this.respond(
          msg,
          "ssh.groups.get.response",
          async () => ({ group: await s.getGroup(msg.id) }),
          { group: null },
        );
      case "ssh.groups.save.request":
        return this.respond(
          msg,
          "ssh.groups.save.response",
          async () => ({ group: await s.saveGroup(msg.group, msg.proxyPassword) }),
          { group: null },
        );
      case "ssh.groups.delete.request":
        return this.respond(
          msg,
          "ssh.groups.delete.response",
          async () => {
            await s.deleteGroup(msg.id);
            return {};
          },
          {},
        );

      case "ssh.identities.list.request":
        return this.respond(
          msg,
          "ssh.identities.list.response",
          async () => ({ identities: await s.listIdentities() }),
          { identities: [] },
        );
      case "ssh.identities.get.request":
        return this.respond(
          msg,
          "ssh.identities.get.response",
          async () => ({ identity: await s.getIdentity(msg.id) }),
          { identity: null },
        );
      case "ssh.identities.save.request":
        return this.respond(
          msg,
          "ssh.identities.save.response",
          async () => ({ identity: await s.saveIdentity(msg.identity, msg.password) }),
          { identity: null },
        );
      case "ssh.identities.delete.request":
        return this.respond(
          msg,
          "ssh.identities.delete.response",
          async () => {
            await s.deleteIdentity(msg.id);
            return {};
          },
          {},
        );

      default:
        return undefined;
    }
  }

  /** keys, known hosts */
  private handleKeychain(msg: SessionInboundMessage): Promise<void> | undefined {
    const s = this.service;
    switch (msg.type) {
      case "ssh.keys.list.request":
        return this.respond(
          msg,
          "ssh.keys.list.response",
          async () => ({ keys: s.storage.listKeys() }),
          { keys: [] },
        );
      case "ssh.keys.generate.request":
        return this.respond(
          msg,
          "ssh.keys.generate.response",
          async () => ({
            key: await s.generateKey({
              label: msg.label,
              type: msg.keyType,
              ...(msg.passphrase ? { passphrase: msg.passphrase } : {}),
            }),
          }),
          { key: null },
        );
      case "ssh.keys.import.request":
        return this.respond(
          msg,
          "ssh.keys.import.response",
          async () => ({
            key: await s.importKey({
              label: msg.label,
              privateKey: msg.privateKey,
              ...(msg.passphrase ? { passphrase: msg.passphrase } : {}),
              ...(msg.certificate ? { certificate: msg.certificate } : {}),
            }),
          }),
          { key: null },
        );
      case "ssh.keys.delete.request":
        return this.respond(
          msg,
          "ssh.keys.delete.response",
          async () => {
            await s.deleteKey(msg.id);
            return {};
          },
          {},
        );
      case "ssh.keys.export_public.request":
        return this.respond(
          msg,
          "ssh.keys.export_public.response",
          async () => ({ publicKey: s.exportPublicKey(msg.id, msg.format ?? "openssh") }),
          { publicKey: null },
        );

      case "ssh.knownhosts.list.request":
        return this.respond(
          msg,
          "ssh.knownhosts.list.response",
          async () => ({ knownHosts: s.storage.listKnownHosts() }),
          { knownHosts: [] },
        );
      case "ssh.knownhosts.delete.request":
        return this.respond(
          msg,
          "ssh.knownhosts.delete.response",
          async () => {
            s.storage.deleteKnownHosts(msg.host, msg.port, msg.keyType);
            return {};
          },
          {},
        );
      case "ssh.knownhosts.replace.request":
        return this.respond(
          msg,
          "ssh.knownhosts.replace.response",
          async () => ({
            knownHost: s.replaceKnownHost({
              host: msg.host,
              port: msg.port,
              keyType: msg.keyType,
              publicKey: msg.publicKey,
            }),
          }),
          { knownHost: null },
        );

      default:
        return undefined;
    }
  }

  /** connect prompts and terminal sessions */
  private handleConnect(msg: SessionInboundMessage): Promise<void> | undefined {
    const s = this.service;
    switch (msg.type) {
      case "ssh.hostkey.respond.request":
        return this.respond(
          msg,
          "ssh.hostkey.respond.response",
          async () => {
            if (!s.respondHostKey(msg.promptId, msg.decision)) {
              throw new Error("This host key prompt was already answered or has expired.");
            }
            return {};
          },
          {},
        );
      case "ssh.auth.respond.request":
        return this.respond(
          msg,
          "ssh.auth.respond.response",
          async () => {
            if (!s.respondAuth(msg.promptId, msg.answers)) {
              throw new Error("This prompt was already answered or has expired.");
            }
            return {};
          },
          {},
        );

      case "ssh.session.create.request":
        return this.respond(
          msg,
          "ssh.session.create.response",
          async () => ({ terminalId: s.createSession(msg.serverId, msg.size) }),
          { terminalId: null },
        );
      case "ssh.session.reconnect.request":
        return this.respond(
          msg,
          "ssh.session.reconnect.response",
          async () => {
            s.reconnectSession(msg.terminalId);
            return {};
          },
          {},
        );
      default:
        return undefined;
    }
  }

  /** Re-send prompts still waiting for an answer (a client that connects mid-connect). */
  replayPendingPrompts(): void {
    for (const prompt of this.service.prompts.listPending()) this.host.emit(prompt);
  }

  private async respond<
    TReq extends { requestId: string; type: string },
    TRes extends SessionOutboundMessage["type"],
  >(
    msg: TReq,
    responseType: TRes,
    body: () => Promise<Record<string, unknown>>,
    empty: Record<string, unknown>,
  ): Promise<void> {
    const requestId = msg.requestId;
    try {
      const data = await body();
      this.host.emit({
        type: responseType,
        payload: { requestId, ...data, error: null },
      } as SessionOutboundMessage);
    } catch (error) {
      const message = errorMessage(error);
      // Only the type and message: request bodies can hold secrets.
      this.logger.warn({ type: msg.type, error: message }, "ssh rpc failed");
      this.host.emit({
        type: responseType,
        payload: { requestId, ...empty, error: message },
      } as SessionOutboundMessage);
    }
  }
}

export type { Req as SshRequest };
