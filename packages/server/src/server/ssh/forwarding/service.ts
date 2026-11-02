import { randomBytes } from "node:crypto";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { Client, ClientChannel, TcpConnectionDetails } from "ssh2";
import type {
  ForwardingRule,
  ForwardingRuleInput,
  ForwardingState,
  SshForwardStateEvent,
} from "@jagentdesk/protocol/ssh/forwarding-schemas";
import type { AcquireSshClient, SshClientLease } from "../ssh-client-lease.js";
import { ForwardingError, ForwardingRuleStore, normalizeRule } from "./rule-store.js";
import { serveSocks5 } from "./socks5.js";

interface RunningForward {
  lease: SshClientLease;
  connections: Set<Duplex>;
  close(): Promise<void>;
}

type RemoteRoute = (
  details: TcpConnectionDetails,
  accept: () => ClientChannel,
  reject: () => void,
) => void;

// ssh2 emits every forwarded-tcpip channel on the Client; rules sharing one connection register
// a route per bind address:port and a single listener dispatches to them.
const remoteRoutes = new WeakMap<Client, Map<string, RemoteRoute>>();

function routeKey(address: string, port: number): string {
  return `${address}:${port}`;
}

function routesFor(client: Client): Map<string, RemoteRoute> {
  let routes = remoteRoutes.get(client);
  if (!routes) {
    const created = new Map<string, RemoteRoute>();
    remoteRoutes.set(client, created);
    client.on("tcp connection", (details, accept, reject) => {
      const route = created.get(routeKey(details.destIP, details.destPort));
      if (route) route(details, accept, reject);
      else reject();
    });
    routes = created;
  }
  return routes;
}

const LISTEN_ERROR_CODES: Record<string, "port_in_use" | "permission_denied" | "bind_unavailable"> =
  {
    EADDRINUSE: "port_in_use",
    EACCES: "permission_denied",
    EADDRNOTAVAIL: "bind_unavailable",
  };

function listen(server: net.Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      const code = (error.code ? LISTEN_ERROR_CODES[error.code] : undefined) ?? "failed";
      const message =
        code === "port_in_use" ? `Port ${port} on ${host} is already in use` : error.message;
      reject(new ForwardingError(code, message, { cause: error }));
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : port);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function forwardOut(client: Client, socket: net.Socket, host: string, port: number) {
  return new Promise<ClientChannel>((resolve, reject) => {
    client.forwardOut(
      socket.remoteAddress ?? "127.0.0.1",
      socket.remotePort ?? 0,
      host,
      port,
      (error, channel) => {
        if (error) reject(error);
        else resolve(channel);
      },
    );
  });
}

function splice(a: Duplex, b: Duplex): void {
  a.pipe(b).pipe(a);
  a.on("error", () => b.destroy());
  b.on("error", () => a.destroy());
  a.on("close", () => b.destroy());
  b.on("close", () => a.destroy());
}

export interface ForwardingServiceOptions {
  acquire: AcquireSshClient;
  /** `$JAGENTDESK_HOME/ssh` — rules persist to `forwarding.json` there. */
  sshDir: string;
  now?: () => number;
}

// ssh.forward.* (spec 25.6). Listeners live on the daemon (`local`, `dynamic`) or on the server
// (`remote`); each running rule holds a lease on its server's connection until stopped.
export class ForwardingService {
  private readonly store: ForwardingRuleStore;
  private readonly states = new Map<string, ForwardingState>();
  private readonly running = new Map<string, RunningForward>();
  private readonly starting = new Map<string, Promise<ForwardingState>>();
  private readonly listeners = new Set<(event: SshForwardStateEvent) => void>();
  private readonly acquire: AcquireSshClient;
  private readonly now: () => number;

  constructor(options: ForwardingServiceOptions) {
    this.store = new ForwardingRuleStore(options.sshDir);
    this.acquire = options.acquire;
    this.now = options.now ?? Date.now;
  }

  initialize(): Promise<void> {
    return this.store.load();
  }

  subscribe(listener: (event: SshForwardStateEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(): { rules: ForwardingRule[]; states: ForwardingState[] } {
    const rules = this.store.list();
    return { rules, states: rules.map((rule) => this.stateOf(rule.id)) };
  }

  stateOf(ruleId: string): ForwardingState {
    return (
      this.states.get(ruleId) ?? {
        ruleId,
        status: "stopped",
        activeConnections: 0,
        changedAtMs: 0,
      }
    );
  }

  async save(input: ForwardingRuleInput): Promise<ForwardingRule> {
    const fields = normalizeRule(input);
    const nowMs = this.now();
    const existing = input.id ? this.store.get(input.id) : null;
    if (input.id && !existing) throw new ForwardingError("not_found", `Unknown rule ${input.id}`);
    const rule: ForwardingRule = {
      ...fields,
      id: existing?.id ?? `fwd_${randomBytes(6).toString("hex")}`,
      createdAtMs: existing?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };
    const wasRunning = this.running.has(rule.id);
    if (wasRunning) await this.stop(rule.id);
    this.store.put(rule);
    if (wasRunning) await this.start(rule.id);
    return rule;
  }

  async delete(id: string): Promise<void> {
    if (!this.store.get(id)) throw new ForwardingError("not_found", `Unknown rule ${id}`);
    await this.stop(id);
    this.store.delete(id);
    this.states.delete(id);
  }

  /** Starts a rule; resolves with its state once `active` or `error`. */
  start(id: string): Promise<ForwardingState> {
    const rule = this.store.get(id);
    if (!rule) return Promise.reject(new ForwardingError("not_found", `Unknown rule ${id}`));
    if (this.running.has(id)) return Promise.resolve(this.stateOf(id));
    const pending = this.starting.get(id);
    if (pending) return pending;
    const started = this.open(rule).finally(() => this.starting.delete(id));
    this.starting.set(id, started);
    return started;
  }

  /** Opens the rules attached to a server that just connected (its `forwardingRuleIds`). */
  startForServer(serverId: string, ruleIds: string[]): Promise<ForwardingState[]> {
    const rules = ruleIds
      .map((id) => this.store.get(id))
      .filter((rule): rule is ForwardingRule => rule !== null && rule.serverId === serverId);
    return Promise.all(rules.map((rule) => this.start(rule.id)));
  }

  async stop(id: string): Promise<ForwardingState> {
    await this.starting.get(id);
    const forward = this.running.get(id);
    if (forward) {
      this.running.delete(id);
      await forward.close();
    }
    return this.setState(id, { status: "stopped" });
  }

  dispose(): Promise<void> {
    return Promise.all(Array.from(this.running.keys(), (id) => this.stop(id))).then(
      () => undefined,
    );
  }

  private setState(
    ruleId: string,
    patch: Pick<ForwardingState, "status"> & Partial<ForwardingState>,
  ): ForwardingState {
    const previous = this.stateOf(ruleId);
    const state: ForwardingState = {
      ruleId,
      status: patch.status,
      activeConnections:
        patch.activeConnections ?? (patch.status === "active" ? previous.activeConnections : 0),
      changedAtMs: this.now(),
    };
    const boundPort =
      patch.boundPort ?? (patch.status === "active" ? previous.boundPort : undefined);
    if (boundPort !== undefined) state.boundPort = boundPort;
    if (patch.error) state.error = patch.error;
    this.states.set(ruleId, state);
    for (const listener of this.listeners) listener({ type: "ssh.forward.state", state });
    return state;
  }

  private async open(rule: ForwardingRule): Promise<ForwardingState> {
    this.setState(rule.id, { status: "starting" });
    let lease: SshClientLease;
    try {
      lease = await this.acquire(rule.serverId);
    } catch (error) {
      return this.fail(
        rule.id,
        new ForwardingError("connection_lost", String((error as Error).message ?? error)),
      );
    }
    const connections = new Set<Duplex>();
    const track = (stream: Duplex) => {
      connections.add(stream);
      this.setState(rule.id, { status: "active", activeConnections: connections.size });
      stream.once("close", () => {
        connections.delete(stream);
        if (this.running.has(rule.id)) {
          this.setState(rule.id, { status: "active", activeConnections: connections.size });
        }
      });
    };
    try {
      const { close, boundPort } = await this.bind(rule, lease.client, track);
      const forward: RunningForward = {
        lease,
        connections,
        close: async () => {
          lease.client.off("close", onConnectionClosed);
          for (const stream of connections) stream.destroy();
          await close();
          lease.release();
        },
      };
      const onConnectionClosed = () => {
        if (this.running.get(rule.id) !== forward) return;
        this.running.delete(rule.id);
        void forward
          .close()
          .then(() =>
            this.fail(rule.id, new ForwardingError("connection_lost", "The SSH connection closed")),
          );
      };
      lease.client.once("close", onConnectionClosed);
      this.running.set(rule.id, forward);
      return this.setState(rule.id, { status: "active", boundPort, activeConnections: 0 });
    } catch (error) {
      lease.release();
      const failure =
        error instanceof ForwardingError
          ? error
          : new ForwardingError("failed", error instanceof Error ? error.message : String(error));
      return this.fail(rule.id, failure);
    }
  }

  private fail(ruleId: string, error: ForwardingError): ForwardingState {
    return this.setState(ruleId, {
      status: "error",
      error: { code: error.code, message: error.message },
    });
  }

  private async bind(
    rule: ForwardingRule,
    client: Client,
    track: (stream: Duplex) => void,
  ): Promise<{ boundPort: number; close(): Promise<void> }> {
    if (rule.kind === "remote") return this.bindRemote(rule, client, track);
    const server = net.createServer((socket) => {
      track(socket);
      socket.on("error", () => socket.destroy());
      if (rule.kind === "dynamic") {
        serveSocks5(socket, (target) => forwardOut(client, socket, target.host, target.port));
        return;
      }
      forwardOut(client, socket, rule.destHost ?? "", rule.destPort ?? 0).then(
        (channel) => splice(socket, channel),
        () => socket.destroy(),
      );
    });
    const boundPort = await listen(server, rule.bindPort, rule.bindAddress);
    return { boundPort, close: () => closeServer(server) };
  }

  private async bindRemote(
    rule: ForwardingRule,
    client: Client,
    track: (stream: Duplex) => void,
  ): Promise<{ boundPort: number; close(): Promise<void> }> {
    const boundPort = await new Promise<number>((resolve, reject) => {
      client.forwardIn(rule.bindAddress, rule.bindPort, (error, port) => {
        if (error) {
          reject(
            new ForwardingError(
              "remote_bind_refused",
              `The server refused to listen on ${rule.bindAddress}:${rule.bindPort} (port in use, or AllowTcpForwarding/GatewayPorts forbid it)`,
              { cause: error },
            ),
          );
        } else {
          resolve(port || rule.bindPort);
        }
      });
    });
    const routes = routesFor(client);
    const key = routeKey(rule.bindAddress, boundPort);
    routes.set(key, (_details, accept, reject) => {
      const socket = net.connect(rule.destPort ?? 0, rule.destHost ?? "");
      let connected = false;
      socket.once("connect", () => {
        connected = true;
        const channel = accept();
        track(channel);
        splice(socket, channel);
      });
      socket.once("error", () => {
        if (!connected) reject();
      });
    });
    return {
      boundPort,
      close: () =>
        new Promise<void>((resolve) => {
          routes.delete(key);
          try {
            client.unforwardIn(rule.bindAddress, boundPort, () => resolve());
          } catch {
            // ssh2 throws "Not connected" once the connection is gone; the server dropped the
            // listener with it.
            resolve();
          }
        }),
    };
  }
}
