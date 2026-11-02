import { Client, utils } from "ssh2";
import type {
  BaseAgent,
  AnyAuthMethod,
  AuthHandlerMiddleware,
  ConnectConfig,
  NextAuthHandler,
  ParsedKey,
  Prompt,
} from "ssh2";
import type { Duplex } from "node:stream";
import type { SshKnownHost, SshServerState } from "@jagentdesk/protocol/ssh/rpc-schemas";
import type { ResolvedSshConfig } from "./config-resolution.js";
import { DaemonSshAgent } from "./daemon-agent.js";
import { evaluateHostKey, publicKeyAlgo } from "./known-hosts.js";
import { connectThroughProxy, ProxyError, type ProxyTarget } from "./proxy-socket.js";
import type { SshPromptBroker } from "./ssh-prompts.js";

// Spec 25.3 connect sequence, per hop of the jump chain (jump hosts first, the target
// last; each later hop rides a `direct-tcpip` channel of the previous one, the first
// hop optionally through a SOCKS5/HTTP proxy):
//   host key check (TOFU prompt on an unknown host, block on mismatch)
//   → auth in `authMethods` order (stored password / key / daemon agent; missing
//     secrets and keyboard-interactive prompts are relayed through the prompt broker)
//   → keepalive, agent forwarding (daemon agent, never SSH_AUTH_SOCK).
// The result is one authenticated ssh2 Client for the target; shells, SFTP, exec and
// forwarding all open channels on it. Prompt answers and secrets are never logged.

export const SSH_HANDSHAKE_TIMEOUT_MS = 30_000;
export const SSH_KEEPALIVE_COUNT_MAX = 3;

export interface SshConnectCredentials {
  password?: string;
  privateKey?: string;
  keyPassphrase?: string;
}

export interface SshConnectionErrorInfo {
  code: string;
  message?: string;
  storedFingerprint?: string;
  receivedFingerprint?: string;
  host?: string;
  port?: number;
  receivedKeyType?: string;
  receivedPublicKey?: string;
}

export class SshConnectionError extends Error {
  constructor(readonly info: SshConnectionErrorInfo) {
    super(info.message ?? info.code);
    this.name = "SshConnectionError";
  }
}

/** Errors a retry cannot fix: auto-reconnect stops on these. */
export const FATAL_SSH_ERROR_CODES: ReadonlySet<string> = new Set([
  "host_key_mismatch",
  "host_key_rejected",
  "host_key_timeout",
  "host_key_unparsable",
  "auth_failed",
  "auth_cancelled",
  "proxy_auth_failed",
  "config_invalid",
]);

export interface SshHop {
  config: ResolvedSshConfig;
  credentials: SshConnectCredentials;
}

export interface KnownHostsAccess {
  list(): readonly SshKnownHost[];
  /** TOFU accept: store the presented key. */
  accept(entry: SshKnownHost): void;
  /** Verified match: refresh lastSeenAtMs. */
  touch(host: string, port: number, keyType: string): void;
}

export interface ConnectChainInput {
  serverId: string;
  terminalId?: string;
  /** Jump hosts in order, then the target last. */
  hops: SshHop[];
  proxy?: ProxyTarget;
  knownHosts: KnownHostsAccess;
  prompts: SshPromptBroker;
  onState?: (state: SshServerState) => void;
  onBanner?: (message: string) => void;
  /** Cancels an in-flight connect (all hops are torn down). */
  isCancelled?: () => boolean;
  handshakeTimeoutMs?: number;
  /** Replaceable pipeline steps (proxy, jump, agent modules wire in here). */
  steps?: Partial<SshConnectSteps>;
}

/**
 * The pluggable stages of the connect pipeline (spec 25.3 steps 2 and 7):
 * proxy socket → jump-chain hop socket → per-hop host key + auth (fixed, S1) →
 * agent for auth/forwarding. Defaults are the built-in implementations below.
 */
export interface SshConnectSteps {
  /** TCP to the first hop through a SOCKS5/HTTP proxy. */
  openProxySocket(proxy: ProxyTarget, host: string, port: number): Promise<Duplex>;
  /** Socket to hop N (N > 0) through the authenticated client of hop N-1. */
  openHopSocket(previous: Client, host: string, port: number): Promise<Duplex>;
  /** The agent for `agent` auth and agent forwarding (never the system agent). */
  createAgent(credentials: SshConnectCredentials): BaseAgent | undefined;
}

export const DEFAULT_SSH_CONNECT_STEPS: SshConnectSteps = {
  openProxySocket: (proxy, host, port) => connectThroughProxy(proxy, host, port),
  openHopSocket: (previous, host, port) => forwardThrough(previous, host, port),
  createAgent: (credentials) => buildDaemonAgent(credentials),
};

export interface SshChainConnection {
  /** Authenticated client for the target. */
  client: Client;
  /** Every client in the chain, target last. */
  clients: Client[];
  isClosed(): boolean;
  /** Fires once when the target (or any hop under it) goes away. */
  onClose(listener: (error?: Error) => void): () => void;
  close(): void;
}

const HOST_KEY_DECLINED: Record<"reject" | "timeout" | "cancelled", SshConnectionErrorInfo> = {
  timeout: { code: "host_key_timeout", message: "Host key confirmation timed out." },
  cancelled: { code: "cancelled", message: "Connection cancelled." },
  reject: { code: "host_key_rejected", message: "Host key rejected." },
};

type Ssh2AuthKind = "password" | "publickey" | "agent" | "keyboard-interactive";

/** ssh2 signals "no more methods" with `false`; the published types omit it. */
function stopAuth(next: NextAuthHandler): void {
  (next as unknown as (value: false) => void)(false);
}

function parsePrivateKey(privateKey: string, passphrase?: string): ParsedKey | Error {
  const parsed = utils.parseKey(privateKey, passphrase);
  if (parsed instanceof Error) return parsed;
  return Array.isArray(parsed) ? (parsed[0] as ParsedKey) : parsed;
}

function isPassphraseError(error: Error): boolean {
  return /passphrase|encrypted|bad decrypt|integrity check/i.test(error.message);
}

function mapClientError(error: Error & { level?: string; code?: string }): SshConnectionErrorInfo {
  if (error instanceof ProxyError) return { code: error.code, message: error.message };
  if (error.level === "client-authentication") {
    return { code: "auth_failed", message: "Authentication failed: no method was accepted." };
  }
  if (error.level === "client-timeout") return { code: "timeout", message: error.message };
  if (error.code === "ENOTFOUND" || error.code === "EAI_AGAIN") {
    return { code: "host_not_found", message: error.message };
  }
  if (error.code === "ECONNREFUSED") return { code: "connection_refused", message: error.message };
  return { code: "connect_failed", message: error.message };
}

interface HopContext {
  index: number;
  count: number;
  hop: SshHop;
  input: ConnectChainInput;
  sock?: Duplex;
  agent?: BaseAgent;
  /** Pause/resume the handshake watchdog while a person is answering a prompt. */
  pauseWatchdog: () => void;
  resumeWatchdog: () => void;
}

function connectHop(ctx: HopContext): Promise<Client> {
  const { hop, input, index, count } = ctx;
  const { config, credentials } = hop;
  const isTarget = index === count - 1;
  const client = new Client();
  const username = config.username ?? "";
  const promptBase = {
    serverId: input.serverId,
    ...(input.terminalId ? { terminalId: input.terminalId } : {}),
  };

  return new Promise<Client>((resolve, reject) => {
    let settled = false;
    let failure: SshConnectionErrorInfo | null = null;
    // Set just before verify(false): ssh2 then emits a generic "Host denied" error,
    // which must surface as the real reason (rejected / mismatch / timeout).
    let deniedWith: SshConnectionErrorInfo | null = null;
    const deny = (verify: (ok: boolean) => void, info: SshConnectionErrorInfo): void => {
      deniedWith = info;
      verify(false);
      fail(info);
    };

    const fail = (info: SshConnectionErrorInfo): void => {
      if (settled) return;
      settled = true;
      failure = info;
      try {
        client.destroy();
      } catch {
        // already gone
      }
      reject(new SshConnectionError(info));
    };

    // ── host key ────────────────────────────────────────────────────────
    const hostVerifier = (key: Buffer, verify: (ok: boolean) => void): void => {
      void (async () => {
        let keyType: string;
        try {
          keyType = publicKeyAlgo(key);
        } catch (error) {
          deny(verify, {
            code: "host_key_unparsable",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        const presented = {
          host: config.host,
          port: config.port,
          keyType,
          publicKey: key.toString("base64"),
        };
        const evaluation = evaluateHostKey(input.knownHosts.list(), presented);
        if (evaluation.kind === "match") {
          input.knownHosts.touch(config.host, config.port, keyType);
          verify(true);
          return;
        }
        if (evaluation.kind === "mismatch") {
          deny(verify, {
            code: "host_key_mismatch",
            message: `The host key for ${config.host}:${config.port} has changed. Stored ${evaluation.storedFingerprint}, received ${evaluation.receivedFingerprint}.`,
            storedFingerprint: evaluation.storedFingerprint,
            receivedFingerprint: evaluation.receivedFingerprint,
            host: config.host,
            port: config.port,
            receivedKeyType: keyType,
            receivedPublicKey: presented.publicKey,
          });
          return;
        }
        input.onState?.("awaiting_hostkey");
        ctx.pauseWatchdog();
        const decision = await input.prompts.requestHostKey({
          ...promptBase,
          address: config.host,
          port: config.port,
          keyType,
          fingerprintSha256: evaluation.entry.fingerprintSha256,
          ...(count > 1 ? { hopIndex: index, hopCount: count } : {}),
        });
        ctx.resumeWatchdog();
        if (settled) {
          verify(false);
          return;
        }
        if (decision === "accept") {
          input.knownHosts.accept(evaluation.entry);
          input.onState?.("connecting");
          verify(true);
          return;
        }
        deny(verify, HOST_KEY_DECLINED[decision]);
      })().catch((error) => {
        deny(verify, {
          code: "host_key_failed",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    };

    // ── auth ────────────────────────────────────────────────────────────
    const queue: Ssh2AuthKind[] = [];
    for (const method of config.authMethods) {
      if (method === "password") queue.push("password");
      else if (method === "key") queue.push("publickey");
      else if (method === "agent") queue.push("agent");
      else if (method === "keyboard-interactive") queue.push("keyboard-interactive");
    }
    let triedNone = false;
    let storedPasswordUsed = false;
    let passwordPrompted = false;

    const ask = async (
      kind: "password" | "passphrase" | "keyboard_interactive",
      prompts: { prompt: string; echo: boolean }[],
      instructions?: string,
    ): Promise<string[] | null> => {
      input.onState?.("awaiting_auth");
      ctx.pauseWatchdog();
      try {
        return await input.prompts.requestAuth({
          ...promptBase,
          kind,
          prompts,
          ...(instructions ? { instructions } : {}),
        });
      } finally {
        ctx.resumeWatchdog();
        if (!settled) input.onState?.("connecting");
      }
    };

    const buildPublicKey = async (): Promise<AnyAuthMethod | null> => {
      if (!credentials.privateKey) return null;
      let passphrase = credentials.keyPassphrase;
      let parsed = parsePrivateKey(credentials.privateKey, passphrase);
      if (parsed instanceof Error && isPassphraseError(parsed)) {
        const answers = await ask("passphrase", [{ prompt: "Key passphrase:", echo: false }]);
        if (!answers) return null;
        passphrase = answers[0];
        parsed = parsePrivateKey(credentials.privateKey, passphrase);
      }
      if (parsed instanceof Error) return null;
      return { type: "publickey", username, key: parsed };
    };

    const relayKeyboardInteractive = (
      name: string,
      instructions: string,
      serverPrompts: Prompt[],
      finish: (answers: string[]) => void,
    ): void => {
      void (async () => {
        if (serverPrompts.length === 0) {
          finish([]);
          return;
        }
        // Many servers only offer keyboard-interactive for passwords: answer a single
        // hidden "Password:" prompt with the stored password once.
        const only = serverPrompts[0];
        if (
          serverPrompts.length === 1 &&
          only.echo !== true &&
          /password/i.test(only.prompt) &&
          credentials.password &&
          !storedPasswordUsed
        ) {
          storedPasswordUsed = true;
          finish([credentials.password]);
          return;
        }
        const answers = await ask(
          "keyboard_interactive",
          serverPrompts.map((prompt) => ({ prompt: prompt.prompt, echo: prompt.echo === true })),
          [name, instructions].filter(Boolean).join("\n") || undefined,
        );
        if (!answers) {
          fail({ code: "auth_cancelled", message: "Authentication prompt was not answered." });
          finish([]);
          return;
        }
        finish(answers);
      })();
    };

    const nextStrategy = async (methodsLeft: string[] | null): Promise<AnyAuthMethod | null> => {
      const allowed = (method: Ssh2AuthKind): boolean =>
        methodsLeft === null || methodsLeft.includes(method === "agent" ? "publickey" : method);
      while (queue.length > 0) {
        const method = queue[0];
        if (!allowed(method)) {
          queue.shift();
          continue;
        }
        if (method === "password") {
          if (credentials.password && !storedPasswordUsed) {
            storedPasswordUsed = true;
            return { type: "password", username, password: credentials.password };
          }
          queue.shift();
          if (passwordPrompted) continue;
          passwordPrompted = true;
          const answers = await ask("password", [
            { prompt: `${username}@${config.host}'s password:`, echo: false },
          ]);
          if (answers && answers[0]) return { type: "password", username, password: answers[0] };
          continue;
        }
        queue.shift();
        if (method === "publickey") {
          const strategy = await buildPublicKey();
          if (strategy) return strategy;
          continue;
        }
        if (method === "agent") {
          if (ctx.agent && agentHasKeys(ctx.agent)) {
            return { type: "agent", username, agent: ctx.agent };
          }
          continue;
        }
        return {
          type: "keyboard-interactive",
          username,
          prompt: (name, instructions, _lang, serverPrompts, finish) =>
            relayKeyboardInteractive(name, instructions, serverPrompts, finish),
        };
      }
      return null;
    };

    const authHandler: AuthHandlerMiddleware = (methodsLeft, _partialSuccess, next) => {
      if (settled) {
        stopAuth(next);
        return;
      }
      // First round: ask the server which methods it accepts before spending
      // stored secrets or bothering the user with prompts.
      if (!triedNone) {
        triedNone = true;
        next({ type: "none", username });
        return;
      }
      void (async () => {
        let strategy: AnyAuthMethod | null = null;
        try {
          strategy = await nextStrategy(methodsLeft);
        } catch (error) {
          fail({
            code: "auth_failed",
            message: error instanceof Error ? error.message : String(error),
          });
        }
        if (settled || !strategy) stopAuth(next);
        else next(strategy);
      })();
    };

    client.on("banner", (message: string) => {
      if (isTarget) input.onBanner?.(message);
    });
    client.on("error", (error: Error) => {
      if (failure) return;
      fail(deniedWith ?? mapClientError(error));
    });
    client.on("close", () => {
      if (!settled)
        fail({ code: "connection_closed", message: "The server closed the connection." });
    });
    client.on("ready", () => {
      if (settled) return;
      settled = true;
      resolve(client);
    });

    const keepaliveMs = Math.max(0, config.keepaliveIntervalS) * 1000;
    const connectConfig: ConnectConfig = {
      host: config.host,
      port: config.port,
      username,
      ...(ctx.sock ? { sock: ctx.sock as ConnectConfig["sock"] } : {}),
      hostVerifier: hostVerifier as ConnectConfig["hostVerifier"],
      authHandler,
      readyTimeout: 0, // our own watchdog pauses while a person answers a prompt
      ...(keepaliveMs > 0
        ? { keepaliveInterval: keepaliveMs, keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX }
        : {}),
      ...(ctx.agent ? { agent: ctx.agent } : {}),
      ...(isTarget && config.agentForwarding && ctx.agent && agentHasKeys(ctx.agent)
        ? { agentForward: true }
        : {}),
    };
    try {
      client.connect(connectConfig);
    } catch (error) {
      fail({
        code: "connect_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function forwardThrough(client: Client, host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    client.forwardOut("127.0.0.1", 0, host, port, (error, stream) => {
      if (error) {
        reject(
          new SshConnectionError({
            code: "jump_failed",
            message: `Jump host could not reach ${host}:${port}: ${error.message}`,
          }),
        );
        return;
      }
      resolve(stream);
    });
  });
}

/** Build the daemon agent for a hop from its key (decrypting with the stored passphrase). */
export function buildDaemonAgent(credentials: SshConnectCredentials): DaemonSshAgent | undefined {
  if (!credentials.privateKey) return undefined;
  const parsed = parsePrivateKey(credentials.privateKey, credentials.keyPassphrase);
  if (parsed instanceof Error) return undefined;
  return new DaemonSshAgent([parsed]);
}

export async function connectSshChain(input: ConnectChainInput): Promise<SshChainConnection> {
  const clients: Client[] = [];
  const steps: SshConnectSteps = { ...DEFAULT_SSH_CONNECT_STEPS, ...input.steps };
  const timeoutMs = input.handshakeTimeoutMs ?? SSH_HANDSHAKE_TIMEOUT_MS;
  const closeAll = (): void => {
    for (const client of clients.toReversed()) {
      try {
        client.end();
        client.destroy();
      } catch {
        // already gone
      }
    }
  };

  try {
    let sock: Duplex | undefined;
    for (let index = 0; index < input.hops.length; index += 1) {
      if (input.isCancelled?.()) {
        throw new SshConnectionError({ code: "cancelled", message: "Connection cancelled." });
      }
      const hop = input.hops[index];
      if (!hop.config.username) {
        throw new SshConnectionError({
          code: "config_invalid",
          message: `No username for ${hop.config.host}. Set one on the server, a parent group, or the identity.`,
        });
      }
      if (index === 0 && input.proxy) {
        sock = await steps.openProxySocket(input.proxy, hop.config.host, hop.config.port);
      } else if (index > 0) {
        sock = await steps.openHopSocket(clients[index - 1], hop.config.host, hop.config.port);
      }
      const client = await withWatchdog(timeoutMs, (pause, resume) =>
        connectHop({
          index,
          count: input.hops.length,
          hop,
          input,
          sock,
          agent: steps.createAgent(hop.credentials),
          pauseWatchdog: pause,
          resumeWatchdog: resume,
        }),
      );
      clients.push(client);
      if (input.isCancelled?.()) {
        throw new SshConnectionError({ code: "cancelled", message: "Connection cancelled." });
      }
    }
  } catch (error) {
    closeAll();
    if (error instanceof SshConnectionError) throw error;
    if (error instanceof ProxyError) {
      throw new SshConnectionError({ code: error.code, message: error.message });
    }
    throw new SshConnectionError({
      code: "connect_failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const target = clients[clients.length - 1];
  let closed = false;
  let closeError: Error | undefined;
  const listeners = new Set<(error?: Error) => void>();
  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    closeAll();
    for (const listener of Array.from(listeners)) {
      try {
        listener(closeError);
      } catch {
        // no-op
      }
    }
    listeners.clear();
  };
  for (const client of clients) {
    client.on("error", (error: Error) => {
      closeError ??= error;
    });
    client.on("close", markClosed);
    client.on("end", markClosed);
  }

  return {
    client: target,
    clients,
    isClosed: () => closed,
    onClose(listener) {
      if (closed) {
        queueMicrotask(() => listener(closeError));
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: markClosed,
  };
}

function agentHasKeys(agent: BaseAgent): boolean {
  return !(agent instanceof DaemonSshAgent) || agent.hasKeys();
}

/** Run `task` with a timeout that stops counting while paused (prompt on screen). */
function withWatchdog<T>(
  timeoutMs: number,
  task: (pause: () => void, resume: () => void) => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let done = false;
    const arm = (): void => {
      if (done || timeoutMs <= 0) return;
      timer = setTimeout(() => {
        done = true;
        reject(
          new SshConnectionError({
            code: "timeout",
            message: "Timed out waiting for the SSH handshake.",
          }),
        );
      }, timeoutMs);
    };
    const disarm = (): void => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    arm();
    const settle = (outcome: { value: T } | { error: unknown }): void => {
      disarm();
      if (done) {
        // Timed out already; a late client must not leak.
        if ("value" in outcome) (outcome.value as unknown as Client | undefined)?.destroy?.();
        return;
      }
      done = true;
      if ("value" in outcome) resolve(outcome.value);
      else reject(outcome.error);
    };
    void (async () => {
      try {
        settle({
          value: await task(disarm, () => {
            disarm();
            arm();
          }),
        });
      } catch (error) {
        settle({ error });
      }
    })();
  });
}
