import ssh2 from "ssh2";
import type { SshModules } from "./modules.js";
import type { Client, ClientChannel, ParsedKey } from "ssh2";
import type { Logger } from "pino";
import type {
  SshConnectionError as SshConnectionErrorDto,
  SshGroup,
  SshIdentity,
  SshKey,
  SshKeyType,
  SshKnownHost,
  SshServer,
  SshServerInfo,
  SshProtocol,
  SshServerState,
  SshSessionInfo,
} from "@jagentdesk/protocol/ssh/rpc-schemas";
import type { TerminalActivityTransitionEvent } from "../../terminal/terminal-manager.js";
import type { TerminalSession } from "../../terminal/terminal.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { TailnetSocksProxy } from "../tsnet-listener.js";
import type { SecretStore } from "../database/secret-store.js";
import {
  isValidEnvName,
  resolveSshConfig,
  validateJumpChain,
  type ResolvedSshConfig,
} from "./config-resolution.js";
import { buildKnownHostEntry, hostKeyFingerprint, publicKeyAlgo } from "./known-hosts.js";
import type { ProxyTarget } from "./proxy-socket.js";
import type { AcquireSshClient, SshClientLease } from "./ssh-client-lease.js";
import {
  connectSshChain,
  FATAL_SSH_ERROR_CODES,
  SshConnectionError,
  type SshChainConnection,
  type SshConnectSteps,
  type SshConnectCredentials,
  type SshConnectionErrorInfo,
  type SshHop,
} from "./ssh-connection.js";
import { SshPromptBroker, type SshPromptPush } from "./ssh-prompts.js";
import {
  generateSshId,
  sshPasswordKey,
  sshProxyKey,
  SSH_KEY_ID_PREFIX,
  SshStorage,
} from "./ssh-storage.js";
import {
  createSshTerminalId,
  SshTerminalSession,
  type RemoteShell,
} from "./ssh-terminal-session.js";
import { wrapRemoteSession, type RemoteSessionHandle } from "./tapped-session.js";

// ssh2 is CommonJS: Node ESM cannot bind its named exports, so read them off the default.
const { utils } = ssh2;

// Daemon-side SSH service (spec 25, ADR-0027). Owns storage, the prompt broker, the
// connection pool, and the SSH terminal sessions (other protocols, e.g. Telnet, plug in
// through `registerShellOpener`).
//
// Connection pool: one authenticated ssh2 Client per server, shared by every terminal
// tab and every module (SFTP, forwarding, exec…) through ref-counted leases
// (`acquireClient`). The connection closes `idleCloseMs` after its last lease returns.
//
// Terminals: `createSession` returns a terminalId at once and connects in the
// background (progress via ssh.connection.state). A dropped connection with
// `autoReconnect` retries after 1, 2, 4, 8, 16, 30, 30… s for up to 10 minutes, in the
// same terminal — the daemon-side emulator keeps the screen and scrollback.

export const SSH_RECONNECT_DELAYS_S: readonly number[] = [1, 2, 4, 8, 16, 30];
export const SSH_RECONNECT_WINDOW_MS = 10 * 60_000;
export const SSH_IDLE_CLOSE_MS = 15_000;

const KEY_TYPE_SPECS: Record<SshKeyType, { ssh2Type: "ed25519" | "ecdsa" | "rsa"; bits?: number }> =
  {
    ed25519: { ssh2Type: "ed25519" },
    "ecdsa-256": { ssh2Type: "ecdsa", bits: 256 },
    "ecdsa-384": { ssh2Type: "ecdsa", bits: 384 },
    "ecdsa-521": { ssh2Type: "ecdsa", bits: 521 },
    "rsa-2048": { ssh2Type: "rsa", bits: 2048 },
    "rsa-3072": { ssh2Type: "rsa", bits: 3072 },
    "rsa-4096": { ssh2Type: "rsa", bits: 4096 },
  };

/** Delay before reconnect attempt `attempt` (0-based), in ms. */
export function reconnectDelayMs(attempt: number): number {
  const index = Math.min(attempt, SSH_RECONNECT_DELAYS_S.length - 1);
  return SSH_RECONNECT_DELAYS_S[index] * 1000;
}

interface PoolEntry {
  serverId: string;
  connecting: Promise<SshChainConnection> | null;
  connection: SshChainConnection | null;
  refs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

interface TerminalRecord {
  terminalId: string;
  serverId: string;
  session: SshTerminalSession;
  state: SshServerState;
  createdAtMs: number;
  lease: SshClientLease | null;
  shellClose: (() => void) | null;
  killed: boolean;
  everConnected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectStartedAtMs: number | null;
  reconnectAttempt: number;
  connectGeneration: number;
}

export interface SshConnectionEvent {
  serverId: string;
  kind: "connected" | "disconnected";
  /** Present for `connected`: the shared client (do not end it; take a lease to use it). */
  client?: Client;
}

export interface SshTerminalCreatedEvent {
  terminalId: string;
  serverId: string;
  /** SSH or Telnet tab: observe output/input, type on the user's behalf. */
  session: RemoteSessionHandle;
}

/** Output pushes (tab dot) are coalesced to one per tab per second. */
export const SSH_ACTIVITY_PUSH_INTERVAL_MS = 1000;

/** A module's RPC handler: returns false when the message is not its own (CONTRACT.md). */
export type SshModuleRpcHandler = (
  message: { type: string },
  emit: (message: SessionOutboundMessage) => void,
) => Promise<boolean>;

/** Builds a complete terminal session for a non-SSH protocol (the Telnet module). */
export type SshExternalSessionFactory = (input: {
  terminalId: string;
  serverId: string;
  label: string;
  host: string;
  port: number;
  size: { cols: number; rows: number };
}) => Promise<TerminalSession>;

/** Opens a terminal stream for a non-SSH protocol (Telnet module). */
export type SshShellOpener = (input: {
  serverId: string;
  host: string;
  port: number;
  size: { cols: number; rows: number };
  onData: (data: string) => void;
  /** `exited`: the remote ended the session (no auto-reconnect); false = connection dropped. */
  onClose: (exited: boolean) => void;
}) => Promise<RemoteShell>;

export interface SshServiceOptions {
  jagentdeskHome?: string;
  logger?: Logger;
  secretStore?: SecretStore;
  /** Fan-out to every connected client (prompts, state pushes). */
  broadcast?: (msg: SessionOutboundMessage) => void;
  idleCloseMs?: number;
  hostKeyTimeoutMs?: number;
  authTimeoutMs?: number;
  /** Test hook: shorten reconnect delays. */
  reconnectDelayMs?: (attempt: number) => number;
  /** Replace connect pipeline steps (proxy / jump / agent modules). */
  connectSteps?: Partial<SshConnectSteps>;
  /**
   * Spec 33.2 / ADR-0044: loopback SOCKS5 of the daemon's tsnet node, used as the
   * first-hop route for `via: "tailnet"` servers. Read again on every connect
   * attempt so a bridge restart (new credential) is picked up; null = tailnet
   * unavailable, which fails the attempt instead of falling back to direct TCP.
   */
  tailnetSocks?: () => TailnetSocksProxy | null;
  /** Startup snippet lookup (S5 owns snippets.json); default reads it directly. */
  resolveStartupScript?: (snippetId: string) => Promise<string | null>;
}

export class SshService {
  readonly storage: SshStorage;
  readonly prompts: SshPromptBroker;
  private readonly logger: Logger | null;
  private readonly broadcastToClients: (msg: SessionOutboundMessage) => void;
  private readonly idleCloseMs: number;
  private reconnectDelay: (attempt: number) => number;
  private connectSteps: Partial<SshConnectSteps>;
  private readonly tailnetSocks: (() => TailnetSocksProxy | null) | null;
  private resolveStartupScript: (snippetId: string) => Promise<string | null>;
  private readonly pool = new Map<string, PoolEntry>();
  private readonly terminals = new Map<string, TerminalRecord>();
  private readonly serverStates = new Map<string, { state: SshServerState; lastError?: string }>();
  private readonly activityListeners = new Set<(event: TerminalActivityTransitionEvent) => void>();
  private readonly connectionListeners = new Set<(event: SshConnectionEvent) => void>();
  private readonly terminalCreatedListeners = new Set<(event: SshTerminalCreatedEvent) => void>();
  private readonly shellOpeners = new Map<string, SshShellOpener>();
  private moduleHandlerList: readonly SshModuleRpcHandler[] = [];
  private readonly sessionFactories = new Map<string, SshExternalSessionFactory>();
  private readonly externalSessions = new Map<
    string,
    { serverId: string; session: TerminalSession & RemoteSessionHandle; createdAtMs: number }
  >();
  /** Broadcast input groups (25.4): terminalId → every terminal of its group. */
  private readonly broadcastGroups = new Map<string, ReadonlySet<string>>();
  private disposed = false;

  /** S6–S8 modules (ssh/modules.ts), set by bootstrap; null for in-memory services and tests. */
  modules: SshModules | null = null;

  /** Bound for modules (CONTRACT.md): `new SftpService(sshService.acquireClient)`. */
  readonly acquireClient: AcquireSshClient = (serverId) => this.acquire(serverId);

  constructor(options: SshServiceOptions = {}) {
    this.logger = options.logger?.child({ module: "ssh" }) ?? null;
    this.broadcastToClients = options.broadcast ?? (() => undefined);
    this.idleCloseMs = options.idleCloseMs ?? SSH_IDLE_CLOSE_MS;
    this.reconnectDelay = options.reconnectDelayMs ?? reconnectDelayMs;
    this.connectSteps = options.connectSteps ?? {};
    this.tailnetSocks = options.tailnetSocks ?? null;
    this.storage = new SshStorage({
      jagentdeskHome: options.jagentdeskHome,
      logger: options.logger,
      secretStore: options.secretStore,
    });
    this.resolveStartupScript =
      options.resolveStartupScript ?? ((id) => this.storage.readSnippetScript(id));
    this.prompts = new SshPromptBroker((msg: SshPromptPush) => this.broadcast(msg), {
      ...(options.hostKeyTimeoutMs ? { hostKeyTimeoutMs: options.hostKeyTimeoutMs } : {}),
      ...(options.authTimeoutMs ? { authTimeoutMs: options.authTimeoutMs } : {}),
    });
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
  }

  dispose(): void {
    this.disposed = true;
    this.killAllTerminals();
    this.prompts.cancelAll();
    for (const entry of Array.from(this.pool.values())) this.closeEntry(entry);
    void this.storage.flush();
  }

  broadcast(message: SessionOutboundMessage): void {
    this.broadcastToClients(message);
  }

  // ── servers / groups / identities ──────────────────────────────────────

  async listServerInfos(): Promise<SshServerInfo[]> {
    return Promise.all(this.storage.listServers().map((server) => this.toServerInfo(server)));
  }

  async getServerInfo(id: string): Promise<SshServerInfo | null> {
    const server = this.storage.getServer(id);
    return server ? await this.toServerInfo(server) : null;
  }

  async saveServer(
    server: SshServer,
    secrets: { password?: string; proxyPassword?: string } = {},
  ): Promise<SshServerInfo> {
    if (!server.label.trim()) throw new Error("Label is required.");
    if (!server.address.trim()) throw new Error("Address is required.");
    validateCommonFields(server);
    if (server.via === "tailnet") {
      // Spec 33.2: the effective config — including a proxy inherited from a
      // parent group — must not mix a tailnet route with a proxy.
      const resolved = resolveSshConfig({
        server,
        groups: this.storage.groupMap(),
        identities: this.storage.identityMap(),
      });
      if (resolved.proxy) {
        throw new Error("A tailnet route cannot be combined with a proxy");
      }
    }
    if (server.groupId && !this.storage.getGroup(server.groupId)) {
      throw new Error("Group does not exist.");
    }
    if (server.identityId && !this.storage.getIdentity(server.identityId)) {
      throw new Error("Identity does not exist.");
    }
    if (server.jumpChain && server.jumpChain.length > 0) {
      const error = validateJumpChain(server.id || "(new)", server.jumpChain, (id) =>
        Boolean(this.storage.getServer(id)),
      );
      if (error) throw new Error(error);
    }
    const stored = this.storage.saveServer({
      ...server,
      label: server.label.trim(),
      address: server.address.trim(),
    });
    await this.storage.setSecret(sshPasswordKey(stored.id), secrets.password);
    await this.storage.setSecret(sshProxyKey(stored.id), secrets.proxyPassword);
    return this.toServerInfo(stored);
  }

  async deleteServer(id: string): Promise<void> {
    for (const record of Array.from(this.terminals.values())) {
      if (record.serverId === id) this.killRecord(record);
    }
    const entry = this.pool.get(id);
    if (entry) this.closeEntry(entry);
    this.prompts.cancelForServer(id);
    await this.storage.deleteServer(id);
    this.serverStates.delete(id);
  }

  async listGroups(): Promise<SshGroup[]> {
    return Promise.all(this.storage.listGroups().map((group) => this.toGroupInfo(group)));
  }

  async getGroup(id: string): Promise<SshGroup | null> {
    const group = this.storage.getGroup(id);
    return group ? this.toGroupInfo(group) : null;
  }

  async saveGroup(group: SshGroup, proxyPassword?: string): Promise<SshGroup> {
    if (!group.label.trim()) throw new Error("Label is required.");
    validateCommonFields(group);
    if (group.jumpChain && group.jumpChain.length > 0) {
      const error = validateJumpChain("", group.jumpChain, (id) =>
        Boolean(this.storage.getServer(id)),
      );
      if (error) throw new Error(error);
    }
    const stored = this.storage.saveGroup({ ...group, label: group.label.trim() });
    await this.storage.setSecret(sshProxyKey(stored.id), proxyPassword);
    return this.toGroupInfo(stored);
  }

  async deleteGroup(id: string): Promise<void> {
    await this.storage.deleteGroup(id);
  }

  async listIdentities(): Promise<SshIdentity[]> {
    return Promise.all(
      this.storage.listIdentities().map((identity) => this.toIdentityInfo(identity)),
    );
  }

  async getIdentity(id: string): Promise<SshIdentity | null> {
    const identity = this.storage.getIdentity(id);
    return identity ? this.toIdentityInfo(identity) : null;
  }

  async saveIdentity(identity: SshIdentity, password?: string): Promise<SshIdentity> {
    if (!identity.label.trim()) throw new Error("Label is required.");
    const stored = this.storage.saveIdentity({ ...identity, label: identity.label.trim() });
    await this.storage.setSecret(sshPasswordKey(stored.id), password);
    return this.toIdentityInfo(stored);
  }

  async deleteIdentity(id: string): Promise<void> {
    await this.storage.deleteIdentity(id);
  }

  listSessions(): SshSessionInfo[] {
    const sessions: SshSessionInfo[] = Array.from(this.terminals.values(), (record) => ({
      terminalId: record.terminalId,
      serverId: record.serverId,
      state: record.state,
      createdAtMs: record.createdAtMs,
    }));
    for (const [terminalId, entry] of this.externalSessions) {
      sessions.push({
        terminalId,
        serverId: entry.serverId,
        state: "connected",
        createdAtMs: entry.createdAtMs,
      });
    }
    return sessions;
  }

  /** `protocol: "telnet"` (or another plugged protocol) sessions come from its module. */
  registerSessionFactory(
    protocol: Exclude<SshProtocol, "ssh">,
    factory: SshExternalSessionFactory,
  ): void {
    this.sessionFactories.set(protocol, factory);
  }

  /**
   * RPC entry for ssh.session.create: SSH sessions return at once and connect in the
   * background; other protocols connect first and fail the request when unreachable.
   */
  async openSession(serverId: string, size: { cols: number; rows: number }): Promise<string> {
    const config = this.resolveConfig(serverId);
    if (!config) throw new Error(`SSH server not found: ${serverId}`);
    if (config.protocol === "ssh") return this.createSession(serverId, size);
    const factory = this.sessionFactories.get(config.protocol);
    if (!factory)
      throw new Error(`${config.protocol} connections are not available on this daemon.`);
    const terminalId = createSshTerminalId();
    const inner = await factory({
      terminalId,
      serverId,
      label: this.storage.getServer(serverId)?.label ?? config.host,
      host: config.host,
      port: config.port,
      size,
    });
    const session = wrapRemoteSession(inner);
    this.externalSessions.set(terminalId, { serverId, session, createdAtMs: Date.now() });
    this.attachSessionHooks(terminalId, serverId, session);
    session.onActivityChange((transition) => {
      this.emitActivityTransition({
        terminalId,
        name: session.name,
        cwd: session.cwd,
        workspaceId: session.workspaceId,
        activity: transition.activity,
        previous: transition.previous,
      });
    });
    this.setServerState(serverId, "connected");
    this.broadcast({ type: "ssh.connection.state", serverId, terminalId, state: "connected" });
    session.onExit(() => {
      this.leaveBroadcast(terminalId);
      if (!this.externalSessions.delete(terminalId)) return;
      this.broadcast({ type: "ssh.connection.state", serverId, terminalId, state: "disconnected" });
      this.refreshServerState(serverId);
    });
    return terminalId;
  }

  /** Resolved (inherited) config for a server — no secrets. */
  resolveConfig(serverId: string): ResolvedSshConfig | null {
    const server = this.storage.getServer(serverId);
    if (!server) return null;
    return resolveSshConfig({
      server,
      groups: this.storage.groupMap(),
      identities: this.storage.identityMap(),
    });
  }

  private async toServerInfo(server: SshServer): Promise<SshServerInfo> {
    const live = this.serverStates.get(server.id);
    const info: SshServerInfo = {
      ...server,
      hasPassword: await this.storage.hasSecret(sshPasswordKey(server.id)),
      state: live?.state ?? "disconnected",
      ...(live?.lastError ? { lastError: live.lastError } : {}),
    };
    if (server.proxy) {
      info.proxy = {
        ...server.proxy,
        hasPassword: await this.storage.hasSecret(sshProxyKey(server.id)),
      };
    }
    return info;
  }

  private async toGroupInfo(group: SshGroup): Promise<SshGroup> {
    if (!group.proxy) return group;
    return {
      ...group,
      proxy: { ...group.proxy, hasPassword: await this.storage.hasSecret(sshProxyKey(group.id)) },
    };
  }

  private async toIdentityInfo(identity: SshIdentity): Promise<SshIdentity> {
    return { ...identity, hasPassword: await this.storage.hasSecret(sshPasswordKey(identity.id)) };
  }

  // ── keys ───────────────────────────────────────────────────────────────

  async generateKey(input: {
    label: string;
    type: SshKeyType;
    passphrase?: string;
  }): Promise<SshKey> {
    const spec = KEY_TYPE_SPECS[input.type];
    if (!spec) throw new Error(`Unsupported key type: ${input.type}`);
    const label = input.label.trim() || `${input.type} key`;
    const options: Record<string, unknown> = {
      comment: label,
      ...(spec.bits ? { bits: spec.bits } : {}),
      ...(input.passphrase
        ? { passphrase: input.passphrase, cipher: "aes256-ctr", rounds: 16 }
        : {}),
    };
    const pair = await new Promise<{ private: string; public: string }>((resolve, reject) => {
      const generate = utils.generateKeyPair as unknown as (
        type: string,
        opts: Record<string, unknown>,
        cb: (err: Error | null, keys: { private: string; public: string }) => void,
      ) => void;
      generate(spec.ssh2Type, options, (err, keys) => {
        if (err) reject(err);
        else resolve(keys);
      });
    });
    return this.storeKey({
      label,
      type: input.type,
      privateKey: pair.private,
      publicOpenSsh: pair.public,
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
      hasPassphrase: Boolean(input.passphrase),
    });
  }

  async importKey(input: {
    label: string;
    privateKey: string;
    passphrase?: string;
    certificate?: string;
  }): Promise<SshKey> {
    const text = input.privateKey.trim();
    if (!text) throw new Error("Paste a private key.");
    const parsed = utils.parseKey(text, input.passphrase || undefined);
    if (parsed instanceof Error) {
      if (/passphrase|encrypted|bad decrypt|integrity/i.test(parsed.message)) {
        throw new Error(
          input.passphrase
            ? "Incorrect passphrase for this private key."
            : "This private key is encrypted. Enter its passphrase.",
        );
      }
      throw new Error(`Unable to read the private key: ${parsed.message}`);
    }
    const key = Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed;
    if (!key.isPrivateKey()) throw new Error("That is a public key. Paste the private key.");
    const encrypted = utils.parseKey(text) instanceof Error;
    const blob = key.getPublicSSH();
    return this.storeKey({
      label: input.label.trim() || key.comment || "Imported key",
      type: deriveKeyType(key),
      privateKey: `${text}\n`,
      publicOpenSsh: `${key.type} ${blob.toString("base64")}`,
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
      hasPassphrase: encrypted,
      ...(input.certificate?.trim() ? { certificate: input.certificate.trim() } : {}),
    });
  }

  private async storeKey(input: {
    label: string;
    type: SshKeyType;
    privateKey: string;
    publicOpenSsh: string;
    passphrase?: string;
    hasPassphrase: boolean;
    certificate?: string;
  }): Promise<SshKey> {
    const parsed = utils.parseKey(input.publicOpenSsh);
    if (parsed instanceof Error) throw new Error("The public key could not be parsed.");
    const publicKey = Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed;
    const blob = publicKey.getPublicSSH();
    const key: SshKey = {
      id: generateSshId(SSH_KEY_ID_PREFIX),
      label: input.label,
      type: input.type,
      publicKey: `${publicKey.type} ${blob.toString("base64")}`,
      fingerprintSha256: hostKeyFingerprint(blob),
      hasPassphrase: input.hasPassphrase,
      ...(input.certificate ? { certificate: input.certificate } : {}),
    };
    return this.storage.addKey(key, {
      privateKey: input.privateKey,
      ...(input.passphrase ? { passphrase: input.passphrase } : {}),
    });
  }

  async deleteKey(id: string): Promise<void> {
    await this.storage.deleteKey(id);
  }

  exportPublicKey(id: string, format: "openssh" | "pem" = "openssh"): string | null {
    const key = this.storage.getKey(id);
    if (!key) return null;
    if (format === "openssh") return `${key.publicKey} ${key.label}`.trim();
    const parsed = utils.parseKey(key.publicKey);
    if (parsed instanceof Error) throw new Error("Stored public key could not be parsed.");
    return (Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed).getPublicPEM();
  }

  // ── known hosts ────────────────────────────────────────────────────────

  replaceKnownHost(input: {
    host: string;
    port: number;
    keyType: string;
    publicKey: string;
  }): SshKnownHost {
    const blob = Buffer.from(input.publicKey, "base64");
    if (publicKeyAlgo(blob) !== input.keyType) throw new Error("Key type does not match the key.");
    const entry = buildKnownHostEntry(input, Date.now());
    this.storage.replaceKnownHost(entry);
    return entry;
  }

  // ── prompts ────────────────────────────────────────────────────────────

  respondHostKey(promptId: string, decision: "accept" | "reject"): boolean {
    return this.prompts.respondHostKey(promptId, decision);
  }

  respondAuth(promptId: string, answers: string[] | null): boolean {
    return this.prompts.respondAuth(promptId, answers);
  }

  // ── connection pool ────────────────────────────────────────────────────

  private async acquire(
    serverId: string,
    context: { terminalId?: string } = {},
  ): Promise<SshClientLease> {
    if (this.disposed) throw new Error("SSH service is shut down.");
    const server = this.storage.getServer(serverId);
    if (!server) throw new Error(`SSH server not found: ${serverId}`);
    if ((server.protocol ?? "ssh") === "telnet") {
      throw new Error("This server uses Telnet; SSH features are not available.");
    }
    let entry = this.pool.get(serverId);
    if (!entry || entry.closed || entry.connection?.isClosed()) {
      entry = {
        serverId,
        connecting: null,
        connection: null,
        refs: 0,
        idleTimer: null,
        closed: false,
      };
      this.pool.set(serverId, entry);
    }
    entry.refs += 1;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    try {
      const connection = entry.connection ?? (await this.connectEntry(entry, context));
      if (connection.isClosed())
        throw new SshConnectionError({ code: "connection_closed", message: "Connection closed." });
      return this.makeLease(entry, connection.client);
    } catch (error) {
      entry.refs = Math.max(0, entry.refs - 1);
      throw error;
    }
  }

  private makeLease(entry: PoolEntry, client: Client): SshClientLease {
    let released = false;
    return {
      client,
      release: () => {
        if (released) return;
        released = true;
        if (this.pool.get(entry.serverId) !== entry || entry.closed) return;
        entry.refs = Math.max(0, entry.refs - 1);
        if (entry.refs === 0) this.scheduleIdleClose(entry);
      },
    };
  }

  private scheduleIdleClose(entry: PoolEntry): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.idleCloseMs <= 0) {
      this.closeEntry(entry);
      return;
    }
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.refs === 0) this.closeEntry(entry);
    }, this.idleCloseMs);
    entry.idleTimer.unref?.();
  }

  private closeEntry(entry: PoolEntry): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (this.pool.get(entry.serverId) === entry) this.pool.delete(entry.serverId);
    entry.connection?.close();
  }

  private connectEntry(
    entry: PoolEntry,
    context: { terminalId?: string },
  ): Promise<SshChainConnection> {
    if (entry.connecting) return entry.connecting;
    const promise = (async () => {
      const hops = await this.buildHops(entry.serverId);
      const target = hops[hops.length - 1].config;
      const proxy = await this.resolveFirstHopRoute(target, hops[0].config);
      this.setServerState(entry.serverId, "connecting");
      const connection = await connectSshChain({
        serverId: entry.serverId,
        ...(context.terminalId ? { terminalId: context.terminalId } : {}),
        hops,
        ...(proxy ? { proxy } : {}),
        knownHosts: {
          list: () => this.storage.listKnownHosts(),
          accept: (knownHost) => this.storage.addKnownHost(knownHost),
          touch: (host, port, keyType) => this.storage.touchKnownHost(host, port, keyType),
        },
        prompts: this.prompts,
        onState: (state) =>
          this.setServerState(entry.serverId, state, undefined, { connectingOnly: true }),
        onBanner: (message) => {
          for (const record of this.terminals.values()) {
            if (record.serverId === entry.serverId && !record.session.hasShell()) {
              record.session.writeSystem(message.replace(/\r?\n/g, "\r\n"));
            }
          }
        },
        isCancelled: () => entry.closed || this.disposed,
        steps: this.connectSteps,
      });
      return connection;
    })();
    entry.connecting = promise;
    promise.then(
      (connection) => this.onEntryConnected(entry, connection),
      (error) => this.onEntryFailed(entry, error),
    );
    return promise;
  }

  private onEntryConnected(entry: PoolEntry, connection: SshChainConnection): void {
    entry.connecting = null;
    if (entry.closed) {
      connection.close();
      return;
    }
    entry.connection = connection;
    this.setServerState(entry.serverId, "connected");
    this.logger?.info(
      { serverId: entry.serverId, hops: connection.clients.length },
      "ssh connected",
    );
    connection.onClose((error) => {
      entry.closed = true;
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
      if (this.pool.get(entry.serverId) === entry) this.pool.delete(entry.serverId);
      this.logger?.info(
        { serverId: entry.serverId, reason: error?.message ?? "closed" },
        "ssh connection closed",
      );
      this.emitConnectionEvent({ serverId: entry.serverId, kind: "disconnected" });
      this.refreshServerState(entry.serverId);
    });
    this.emitConnectionEvent({
      serverId: entry.serverId,
      kind: "connected",
      client: connection.client,
    });
  }

  private onEntryFailed(entry: PoolEntry, error: unknown): void {
    entry.connecting = null;
    entry.closed = true;
    if (this.pool.get(entry.serverId) === entry) this.pool.delete(entry.serverId);
    const info = toErrorInfo(error);
    this.logger?.warn({ serverId: entry.serverId, code: info.code }, "ssh connect failed");
    this.setServerState(entry.serverId, "error", info);
  }

  /** Jump hosts (in order) then the target, each with its own resolved config + secrets. */
  private async buildHops(serverId: string): Promise<SshHop[]> {
    const target = this.resolveConfig(serverId);
    if (!target)
      throw new SshConnectionError({ code: "config_invalid", message: "Server not found." });
    const chainError = validateJumpChain(serverId, target.jumpChain, (id) =>
      Boolean(this.storage.getServer(id)),
    );
    if (chainError) throw new SshConnectionError({ code: "config_invalid", message: chainError });
    const hops: SshHop[] = [];
    for (const hopId of target.jumpChain) {
      const config = this.resolveConfig(hopId);
      if (!config)
        throw new SshConnectionError({
          code: "config_invalid",
          message: `Jump host ${hopId} not found.`,
        });
      hops.push({
        config: { ...config, agentForwarding: false },
        credentials: await this.resolveCredentials(config),
      });
    }
    hops.push({ config: target, credentials: await this.resolveCredentials(target) });
    return hops;
  }

  private async resolveCredentials(config: ResolvedSshConfig): Promise<SshConnectCredentials> {
    const serverPassword = await this.storage.secrets.get(sshPasswordKey(config.serverId));
    const identityPassword = config.identityId
      ? await this.storage.secrets.get(sshPasswordKey(config.identityId))
      : null;
    const material = config.keyId ? await this.storage.getKeyMaterial(config.keyId) : null;
    const password = serverPassword ?? identityPassword;
    return {
      ...(password ? { password } : {}),
      ...(material?.privateKey ? { privateKey: material.privateKey } : {}),
      ...(material?.passphrase ? { keyPassphrase: material.passphrase } : {}),
    };
  }

  private async resolveProxy(
    target: ResolvedSshConfig,
    firstHop: ResolvedSshConfig,
  ): Promise<ProxyTarget | undefined> {
    let source: ResolvedSshConfig | null = null;
    if (target.proxy) source = target;
    else if (firstHop.proxy) source = firstHop;
    if (!source?.proxy) return undefined;
    const password = source.proxyOwnerId
      ? await this.storage.secrets.get(sshProxyKey(source.proxyOwnerId))
      : null;
    return {
      type: source.proxy.type,
      host: source.proxy.host,
      port: source.proxy.port,
      ...(source.proxy.username ? { username: source.proxy.username } : {}),
      ...(password ? { password } : {}),
    };
  }

  /**
   * Route for the first hop's TCP socket (spec 25.3 step 2, spec 33.2): a saved
   * proxy, or — when the target is `via: "tailnet"` — the tsnet node's loopback
   * SOCKS5. A tailnet route never combines with a proxy and never falls back to
   * a direct dial: without the accessor the attempt fails with
   * `tailnet_unavailable` right away.
   */
  private async resolveFirstHopRoute(
    target: ResolvedSshConfig,
    firstHop: ResolvedSshConfig,
  ): Promise<ProxyTarget | undefined> {
    const proxy = await this.resolveProxy(target, firstHop);
    if (target.via !== "tailnet") return proxy;
    if (proxy) {
      throw new SshConnectionError({
        code: "config_invalid",
        message: "A tailnet route cannot be combined with a proxy",
      });
    }
    const socks = this.tailnetSocks?.() ?? null;
    if (!socks) {
      throw new SshConnectionError({
        code: "tailnet_unavailable",
        message: "JAgentDesk Tailscale is not connected on this host.",
      });
    }
    return {
      type: "socks5",
      host: socks.host,
      port: socks.port,
      username: socks.username,
      password: socks.password,
    };
  }

  // ── state fan-out ──────────────────────────────────────────────────────

  private setServerState(
    serverId: string,
    state: SshServerState,
    error?: SshConnectionErrorInfo,
    options: { connectingOnly?: boolean } = {},
  ): void {
    const lastError = error ? (error.message ?? error.code) : undefined;
    this.serverStates.set(serverId, { state, ...(lastError ? { lastError } : {}) });
    this.broadcast({
      type: "ssh.connection.state",
      serverId,
      state,
      ...(error ? { error: toErrorDto(error) } : {}),
    });
    // Tabs still waiting on this connect mirror its prompts (yellow dot).
    for (const record of this.terminals.values()) {
      if (record.serverId !== serverId || record.session.hasShell()) continue;
      if (record.state === "reconnecting" && options.connectingOnly && state === "connecting")
        continue;
      if (state === "awaiting_hostkey" || state === "awaiting_auth" || state === "connecting") {
        this.setTerminalState(record, state);
      }
    }
  }

  private refreshServerState(serverId: string): void {
    const records = Array.from(this.terminals.values()).filter((r) => r.serverId === serverId);
    const live = this.pool.get(serverId);
    let state: SshServerState = "disconnected";
    if (live?.connection && !live.connection.isClosed()) state = "connected";
    else if (records.some((r) => r.state === "reconnecting")) state = "reconnecting";
    this.serverStates.set(serverId, { state });
    this.broadcast({ type: "ssh.connection.state", serverId, state });
  }

  private setTerminalState(
    record: TerminalRecord,
    state: SshServerState,
    error?: SshConnectionErrorInfo,
    nextAttemptAtMs?: number,
  ): void {
    record.state = state;
    if (state === "awaiting_hostkey" || state === "awaiting_auth") {
      record.session.setActivity("attention");
    }
    this.broadcast({
      type: "ssh.connection.state",
      serverId: record.serverId,
      terminalId: record.terminalId,
      state,
      ...(error ? { error: toErrorDto(error) } : {}),
      ...(nextAttemptAtMs ? { nextAttemptAtMs } : {}),
    });
  }

  // ── terminal sessions ──────────────────────────────────────────────────

  /** Spec 25.4: create an SSH terminal (no workspace) and start connecting. */
  createSession(serverId: string, size: { cols: number; rows: number }): string {
    const server = this.storage.getServer(serverId);
    if (!server) throw new Error(`SSH server not found: ${serverId}`);
    const config = this.resolveConfig(serverId)!;
    const terminalId = createSshTerminalId();
    const session = new SshTerminalSession({
      id: terminalId,
      name: server.label,
      cwd: `${config.protocol}://${config.host}:${config.port}`,
      serverId,
      cols: size.cols,
      rows: size.rows,
    });
    const record: TerminalRecord = {
      terminalId,
      serverId,
      session,
      state: "connecting",
      createdAtMs: Date.now(),
      lease: null,
      shellClose: null,
      killed: false,
      everConnected: false,
      reconnectTimer: null,
      reconnectStartedAtMs: null,
      reconnectAttempt: 0,
      connectGeneration: 0,
    };
    this.terminals.set(terminalId, record);
    session.onKill = () => this.killRecord(record);
    session.onActivityChange((transition) => {
      const event: TerminalActivityTransitionEvent = {
        terminalId,
        name: session.name,
        cwd: session.cwd,
        workspaceId: session.workspaceId,
        activity: transition.activity,
        previous: transition.previous,
      };
      for (const listener of Array.from(this.activityListeners)) {
        try {
          listener(event);
        } catch {
          // no-op
        }
      }
    });
    if (config.protocol === "telnet") {
      session.writeSystem(
        `\x1b[33mTelnet to ${config.host}:${config.port} is not encrypted.\x1b[0m\r\n`,
      );
    }
    this.attachSessionHooks(terminalId, serverId, session);
    void this.connectTerminal(record);
    return terminalId;
  }

  /** Manual retry of an errored/disconnected tab, same screen. */
  reconnectSession(terminalId: string): void {
    const record = this.terminals.get(terminalId);
    if (!record) throw new Error("SSH terminal not found.");
    if (record.session.hasShell()) return;
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    record.reconnectTimer = null;
    record.reconnectStartedAtMs = null;
    record.reconnectAttempt = 0;
    record.session.writeSystem("\r\n");
    void this.connectTerminal(record);
  }

  private async connectTerminal(record: TerminalRecord): Promise<void> {
    const generation = ++record.connectGeneration;
    const config = this.resolveConfig(record.serverId);
    if (!config) {
      this.failTerminal(record, { code: "config_invalid", message: "Server not found." });
      return;
    }
    if (!(record.state === "reconnecting")) this.setTerminalState(record, "connecting");
    try {
      const shell =
        config.protocol === "ssh"
          ? await this.openSshShell(record, config)
          : await this.openPluggedShell(record, config);
      if (record.killed || generation !== record.connectGeneration) {
        shell.close();
        return;
      }
      record.session.attachShell(shell);
      record.everConnected = true;
      record.reconnectAttempt = 0;
      record.reconnectStartedAtMs = null;
      this.setTerminalState(record, "connected");
      if (config.startupSnippetId) {
        const script = await this.resolveStartupScript(config.startupSnippetId);
        if (script && !record.killed)
          record.session.typeInput(`${script.replace(/\r?\n/g, "\r")}\r`);
      }
    } catch (error) {
      if (record.killed || generation !== record.connectGeneration) return;
      const info = toErrorInfo(error);
      if (record.everConnected && config.autoReconnect && !FATAL_SSH_ERROR_CODES.has(info.code)) {
        this.scheduleReconnect(record, info);
        return;
      }
      this.failTerminal(record, info);
    }
  }

  private async openSshShell(
    record: TerminalRecord,
    config: ResolvedSshConfig,
  ): Promise<RemoteShell> {
    const lease = await this.acquire(record.serverId, { terminalId: record.terminalId });
    let channel: ClientChannel;
    try {
      const size = record.session.getSize();
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(config.env)) {
        if (isValidEnvName(name)) env[name] = value;
      }
      channel = await new Promise<ClientChannel>((resolve, reject) => {
        lease.client.shell(
          { term: "xterm-256color", cols: size.cols, rows: size.rows },
          Object.keys(env).length > 0 ? { env } : {},
          (error, stream) => {
            if (error) reject(error);
            else resolve(stream);
          },
        );
      });
    } catch (error) {
      lease.release();
      throw new SshConnectionError({
        code: "shell_failed",
        message: `Could not open a shell: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    record.lease = lease;
    const decoder = new TextDecoder("utf-8");
    let exitStatus: { code: number | null; signal: string | null } | null = null;
    channel.on("data", (data: Buffer) => {
      record.session.pushRemoteOutput(decoder.decode(data, { stream: true }));
    });
    channel.stderr.on("data", (data: Buffer) => {
      record.session.pushRemoteOutput(data.toString("utf8"));
    });
    channel.on("exit", (code: number | null, signal?: string) => {
      exitStatus = { code: typeof code === "number" ? code : null, signal: signal ?? null };
    });
    let closed = false;
    channel.on("close", () => {
      if (closed) return;
      closed = true;
      lease.release();
      if (record.lease === lease) record.lease = null;
      this.handleShellClosed(record, config, exitStatus !== null, exitStatus?.code ?? null);
    });
    return {
      write: (data) => {
        if (!closed) channel.write(data);
      },
      resize: (cols, rows) => {
        if (!closed) channel.setWindow(rows, cols, 0, 0);
      },
      close: () => {
        closed = true;
        try {
          channel.close();
        } catch {
          // already closed
        }
        lease.release();
        if (record.lease === lease) record.lease = null;
      },
    };
  }

  /** Non-SSH protocols (spec 25.3 Telnet) are provided by their module. */
  private async openPluggedShell(
    record: TerminalRecord,
    config: ResolvedSshConfig,
  ): Promise<RemoteShell> {
    const opener = this.shellOpeners.get(config.protocol);
    if (!opener) {
      throw new SshConnectionError({
        code: "config_invalid",
        message: `${config.protocol} connections are not available on this daemon.`,
      });
    }
    this.setServerState(record.serverId, "connecting");
    let closed = false;
    const shell = await opener({
      serverId: record.serverId,
      host: config.host,
      port: config.port,
      size: record.session.getSize(),
      onData: (data) => record.session.pushRemoteOutput(data),
      onClose: (exited) => {
        if (closed) return;
        closed = true;
        this.handleShellClosed(record, config, exited, null);
        this.refreshServerState(record.serverId);
      },
    });
    this.setServerState(record.serverId, "connected");
    return {
      write: (data) => shell.write(data),
      resize: (cols, rows) => shell.resize(cols, rows),
      close: () => {
        closed = true;
        shell.close();
      },
    };
  }

  /** Integration: swap pipeline steps / policies provided by milestone modules. */
  configurePipeline(input: {
    connectSteps?: Partial<SshConnectSteps>;
    reconnectDelayMs?: (attempt: number) => number;
    resolveStartupScript?: (snippetId: string) => Promise<string | null>;
  }): void {
    if (input.connectSteps) this.connectSteps = { ...this.connectSteps, ...input.connectSteps };
    if (input.reconnectDelayMs) this.reconnectDelay = input.reconnectDelayMs;
    if (input.resolveStartupScript) this.resolveStartupScript = input.resolveStartupScript;
  }

  /** Milestone modules' RPC handlers (ssh-modules.ts); every session dispatches to them. */
  registerModuleHandlers(handlers: readonly SshModuleRpcHandler[]): void {
    this.moduleHandlerList = [...this.moduleHandlerList, ...handlers];
  }

  moduleHandlers(): readonly SshModuleRpcHandler[] {
    return this.moduleHandlerList;
  }

  registerShellOpener(protocol: Exclude<SshProtocol, "ssh">, opener: SshShellOpener): void {
    this.shellOpeners.set(protocol, opener);
  }

  private handleShellClosed(
    record: TerminalRecord,
    config: ResolvedSshConfig,
    exited: boolean,
    exitCode: number | null,
  ): void {
    record.session.detachShell();
    if (record.killed) return;
    if (exited || !config.autoReconnect) {
      if (!exited) {
        record.session.writeSystem("\r\n\x1b[31mConnection lost.\x1b[0m\r\n");
      }
      this.finishRecord(record, exitCode);
      return;
    }
    this.scheduleReconnect(record, { code: "connection_lost", message: "Connection lost." });
  }

  private scheduleReconnect(record: TerminalRecord, info: SshConnectionErrorInfo): void {
    const now = Date.now();
    record.reconnectStartedAtMs ??= now;
    if (now - record.reconnectStartedAtMs > SSH_RECONNECT_WINDOW_MS) {
      this.failTerminal(record, {
        code: "reconnect_gave_up",
        message: "Could not reconnect within 10 minutes.",
      });
      return;
    }
    const delay = this.reconnectDelay(record.reconnectAttempt);
    record.reconnectAttempt += 1;
    const seconds = Math.round(delay / 1000);
    record.session.writeSystem(
      `\r\n\x1b[33m${info.message ?? info.code} Reconnecting in ${seconds} s…\x1b[0m\r\n`,
    );
    this.setTerminalState(record, "reconnecting", info, now + delay);
    this.refreshServerState(record.serverId);
    record.reconnectTimer = setTimeout(() => {
      record.reconnectTimer = null;
      if (record.killed) return;
      void this.connectTerminal(record);
    }, delay);
  }

  private failTerminal(record: TerminalRecord, info: SshConnectionErrorInfo): void {
    this.logger?.warn(
      { serverId: record.serverId, terminalId: record.terminalId, code: info.code },
      "ssh session failed",
    );
    record.session.writeSystem(`\r\n\x1b[31m${info.message ?? info.code}\x1b[0m\r\n`);
    this.setTerminalState(record, "error", info);
    record.session.setActivity("attention");
  }

  private finishRecord(record: TerminalRecord, exitCode: number | null): void {
    if (!this.terminals.has(record.terminalId)) return;
    this.leaveBroadcast(record.terminalId);
    this.terminals.delete(record.terminalId);
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    record.state = "disconnected";
    this.broadcast({
      type: "ssh.connection.state",
      serverId: record.serverId,
      terminalId: record.terminalId,
      state: "disconnected",
    });
    record.session.end({ exitCode });
  }

  private killRecord(record: TerminalRecord): void {
    if (record.killed) return;
    record.killed = true;
    this.leaveBroadcast(record.terminalId);
    record.connectGeneration += 1;
    if (record.reconnectTimer) clearTimeout(record.reconnectTimer);
    record.reconnectTimer = null;
    record.lease?.release();
    record.lease = null;
    if (!record.session.isEnded()) record.session.kill();
    if (this.terminals.delete(record.terminalId)) {
      this.broadcast({
        type: "ssh.connection.state",
        serverId: record.serverId,
        terminalId: record.terminalId,
        state: "disconnected",
      });
    }
  }

  /** Activity pushes, broadcast mirroring and module taps for a new SSH/Telnet tab. */
  private attachSessionHooks(
    terminalId: string,
    serverId: string,
    session: RemoteSessionHandle,
  ): void {
    let lastPushMs = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const push = (): void => {
      pending = null;
      lastPushMs = Date.now();
      this.broadcast({
        type: "ssh.session.activity",
        terminalId,
        serverId,
        lastOutputAtMs: lastPushMs,
      });
    };
    session.tapOutput(() => {
      if (pending) return;
      const wait = SSH_ACTIVITY_PUSH_INTERVAL_MS - (Date.now() - lastPushMs);
      if (wait <= 0) push();
      else pending = setTimeout(push, wait);
    });
    session.onClientInput = (data) => this.mirrorInput(terminalId, data);
    for (const listener of Array.from(this.terminalCreatedListeners)) {
      try {
        listener({ terminalId, serverId, session });
      } catch {
        // no-op
      }
    }
  }

  private remoteHandle(
    terminalId: string,
  ): { serverId: string; handle: RemoteSessionHandle } | null {
    const record = this.terminals.get(terminalId);
    if (record) return { serverId: record.serverId, handle: record.session };
    const external = this.externalSessions.get(terminalId);
    return external ? { serverId: external.serverId, handle: external.session } : null;
  }

  /** Spec 25.4 broadcast input: enabled groups ≥2 terminals; disabled removes them. */
  setBroadcast(terminalIds: readonly string[], enabled = true): void {
    if (enabled) {
      for (const terminalId of terminalIds) {
        if (!this.remoteHandle(terminalId))
          throw new Error(`SSH terminal not found: ${terminalId}`);
      }
    }
    for (const terminalId of terminalIds) this.leaveBroadcast(terminalId);
    if (!enabled || terminalIds.length < 2) return;
    const group: ReadonlySet<string> = new Set(terminalIds);
    for (const terminalId of group) this.broadcastGroups.set(terminalId, group);
  }

  private leaveBroadcast(terminalId: string): void {
    const group = this.broadcastGroups.get(terminalId);
    if (!group) return;
    for (const member of group) this.broadcastGroups.delete(member);
    const rest = Array.from(group).filter((member) => member !== terminalId);
    if (rest.length >= 2) {
      const next: ReadonlySet<string> = new Set(rest);
      for (const member of next) this.broadcastGroups.set(member, next);
    }
  }

  private mirrorInput(fromTerminalId: string, data: string): void {
    const group = this.broadcastGroups.get(fromTerminalId);
    if (!group) return;
    for (const member of group) {
      if (member === fromTerminalId) continue;
      this.remoteHandle(member)?.handle.typeInput(data);
    }
  }

  /** Mobile "Password" key (25.4): type the saved password; it never reaches the app. */
  async typePassword(terminalId: string): Promise<void> {
    const target = this.remoteHandle(terminalId);
    if (!target) throw new Error("SSH terminal not found.");
    const config = this.resolveConfig(target.serverId);
    if (!config) throw new Error("SSH server not found.");
    const credentials = await this.resolveCredentials(config);
    if (!credentials.password)
      throw new Error("No password is saved for this server or its identity.");
    target.handle.typeInput(credentials.password);
  }

  private emitActivityTransition(event: TerminalActivityTransitionEvent): void {
    for (const listener of Array.from(this.activityListeners)) {
      try {
        listener(event);
      } catch {
        // no-op
      }
    }
  }

  // ── extension points for milestone modules ────────────────────────────

  /** S3 auto-forwarding / S7 environment detection hook here. */
  subscribeConnections(listener: (event: SshConnectionEvent) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /** S5 command history / S6 session logs hook here (tapOutput / tapInput). */
  subscribeTerminalCreated(listener: (event: SshTerminalCreatedEvent) => void): () => void {
    this.terminalCreatedListeners.add(listener);
    return () => this.terminalCreatedListeners.delete(listener);
  }

  private emitConnectionEvent(event: SshConnectionEvent): void {
    for (const listener of Array.from(this.connectionListeners)) {
      try {
        listener(event);
      } catch (error) {
        this.logger?.warn({ err: error }, "ssh connection listener failed");
      }
    }
  }

  isConnected(serverId: string): boolean {
    const entry = this.pool.get(serverId);
    return Boolean(entry?.connection && !entry.connection.isClosed());
  }

  /** Live aggregate connect state for a saved server (the ssh.connection.state source of truth). */
  serverState(serverId: string): SshServerState {
    return this.serverStates.get(serverId)?.state ?? "disconnected";
  }

  // ── composite-manager registry surface ─────────────────────────────────

  getSshTerminal(terminalId: string): TerminalSession | undefined {
    return (
      this.terminals.get(terminalId)?.session ?? this.externalSessions.get(terminalId)?.session
    );
  }

  getSshTerminalSession(terminalId: string): SshTerminalSession | undefined {
    return this.terminals.get(terminalId)?.session;
  }

  subscribeTerminalActivity(
    listener: (event: TerminalActivityTransitionEvent) => void,
  ): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  killAllTerminals(): void {
    for (const record of Array.from(this.terminals.values())) this.killRecord(record);
    for (const entry of Array.from(this.externalSessions.values())) entry.session.kill();
  }
}

function validateCommonFields(entity: {
  env?: Record<string, string>;
  proxy?: { host: string; port: number };
}): void {
  for (const name of Object.keys(entity.env ?? {})) {
    if (!isValidEnvName(name)) throw new Error(`Invalid environment variable name: ${name}`);
  }
}

function toErrorInfo(error: unknown): SshConnectionErrorInfo {
  if (error instanceof SshConnectionError) return error.info;
  return {
    code: "connect_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

function toErrorDto(info: SshConnectionErrorInfo): SshConnectionErrorDto {
  const dto: SshConnectionErrorDto = { code: info.code };
  for (const key of [
    "message",
    "storedFingerprint",
    "receivedFingerprint",
    "host",
    "port",
    "receivedKeyType",
    "receivedPublicKey",
  ] as const) {
    if (info[key] !== undefined) (dto as Record<string, unknown>)[key] = info[key];
  }
  return dto;
}

function deriveKeyType(parsed: ParsedKey): SshKeyType {
  switch (parsed.type) {
    case "ssh-ed25519":
      return "ed25519";
    case "ecdsa-sha2-nistp256":
      return "ecdsa-256";
    case "ecdsa-sha2-nistp384":
      return "ecdsa-384";
    case "ecdsa-sha2-nistp521":
      return "ecdsa-521";
    default:
      return rsaKeyType(parsed);
  }
}

/** RSA: read the modulus length from the wire blob and bucket to a supported size. */
function rsaKeyType(parsed: ParsedKey): SshKeyType {
  const blob = parsed.getPublicSSH();
  try {
    let offset = 0;
    const readString = (): Buffer => {
      const length = blob.readUInt32BE(offset);
      offset += 4;
      const value = blob.subarray(offset, offset + length);
      offset += length;
      return value;
    };
    readString(); // algorithm
    readString(); // exponent
    const modulus = readString();
    const bits = (modulus[0] === 0 ? modulus.length - 1 : modulus.length) * 8;
    if (bits > 3072) return "rsa-4096";
    if (bits > 2048) return "rsa-3072";
    return "rsa-2048";
  } catch {
    return "rsa-2048";
  }
}
