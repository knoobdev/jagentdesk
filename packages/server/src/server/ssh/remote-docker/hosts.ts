import path from "node:path";
import type { Client } from "ssh2";
import type { RemoteDockerErrorCode } from "@jagentdesk/protocol/ssh/remote-docker-schemas";
import { runRemoteCommand } from "../environment/remote-exec.js";
import type { AcquireSshClient, SshClientLease } from "../ssh-client-lease.js";
import {
  forwardUnixSocket,
  openStreamLocal,
  StreamLocalRefusedError,
  type ForwardedSocket,
} from "./socket-forward.js";

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const PING_TIMEOUT_MS = 10_000;

// Same candidates, in the same order, as the environment detection (25.10): DOCKER_HOST, the
// rootful socket, then the rootless one of this user.
const SOCKET_PROBE_SCRIPT = `
for s in "\${DOCKER_HOST#unix://}" /var/run/docker.sock "\${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"; do
  if [ -n "$s" ] && [ -S "$s" ]; then
    if [ -r "$s" ] && [ -w "$s" ]; then echo "rw $s"; else echo "denied $s"; fi
    exit 0
  fi
done
echo none
`;

export class RemoteDockerError extends Error {
  constructor(
    readonly code: RemoteDockerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RemoteDockerError";
  }
}

export interface RemoteDockerAttachment {
  serverId: string;
  /** `unix://<localSocketPath>`, for `docker -H` / `DOCKER_HOST`. */
  dockerHost: string;
  localSocketPath: string;
  remoteSocketPath: string;
}

interface ActiveHost {
  attachment: RemoteDockerAttachment;
  lease: SshClientLease;
  forward: ForwardedSocket;
  holders: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface RemoteDockerHostsOptions {
  acquire: AcquireSshClient;
  /** `$JAGENTDESK_HOME/ssh/run` — created 0700; sockets inside are 0600. */
  runDirectory: string;
  idleTimeoutMs?: number;
}

function localSocketName(serverId: string): string {
  return `docker-${serverId.replace(/[^A-Za-z0-9_-]/g, "_")}.sock`;
}

async function findRemoteSocket(client: Client): Promise<string> {
  const result = await runRemoteCommand(client, {
    command: "sh -s",
    stdin: SOCKET_PROBE_SCRIPT,
    timeoutMs: PING_TIMEOUT_MS,
    maxBytesPerStream: 4096,
  });
  const line = result.stdout.trim();
  const space = line.indexOf(" ");
  const access = space > 0 ? line.slice(0, space) : line;
  const socketPath = space > 0 ? line.slice(space + 1) : "";
  if (access === "rw") return socketPath;
  if (access === "denied") {
    throw new RemoteDockerError(
      "docker_socket_denied",
      `this user cannot open ${socketPath}; add it to the docker group and reconnect`,
    );
  }
  throw new RemoteDockerError("docker_not_found", "no Docker socket found on the server");
}

/** `GET /_ping` over one streamlocal channel: proves sshd forwards the socket and Docker answers. */
async function pingDocker(client: Client, remoteSocketPath: string): Promise<void> {
  const channel = await openStreamLocal(client, remoteSocketPath);
  const chunks: Buffer[] = [];
  channel.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = new Promise<void>((resolve) => channel.on("close", resolve));
  const timer = setTimeout(() => channel.close(), PING_TIMEOUT_MS);
  // No half-close: Docker Desktop's socket proxy answers 500 to a request followed by EOF.
  channel.write("GET /_ping HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n\r\n");
  await closed;
  clearTimeout(timer);
  const response = Buffer.concat(chunks).toString("utf8");
  if (!response.startsWith("HTTP/1.1 200")) {
    const status = response.split("\r\n")[0] || "no response";
    throw new RemoteDockerError(
      "docker_not_found",
      `Docker did not answer on ${remoteSocketPath}: ${status}`,
    );
  }
}

/**
 * Per-server forwarded Docker sockets (spec 25.10, ADR-0027 §7). Started on the first attach,
 * shared by every holder (cockpit, agent tools), closed once nobody holds it and no connection used
 * it for the idle timeout — or at once when the SSH connection goes away.
 */
export class RemoteDockerHosts {
  private readonly starting = new Map<string, Promise<ActiveHost>>();
  private readonly active = new Map<string, ActiveHost>();
  // A closing forward unlinks its socket path last; a new one must not bind it before that.
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly idleTimeoutMs: number;

  constructor(private readonly options: RemoteDockerHostsOptions) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  async attach(serverId: string): Promise<RemoteDockerAttachment> {
    const host = await this.start(serverId);
    host.holders += 1;
    if (host.idleTimer) {
      clearTimeout(host.idleTimer);
      host.idleTimer = null;
    }
    return host.attachment;
  }

  detach(serverId: string): void {
    const host = this.active.get(serverId);
    if (!host || host.holders === 0) return;
    host.holders -= 1;
    this.scheduleIdleStop(serverId, host);
  }

  /** Attach for the duration of `run` (agent tools). */
  async use<T>(
    serverId: string,
    run: (attachment: RemoteDockerAttachment) => Promise<T>,
  ): Promise<T> {
    const attachment = await this.attach(serverId);
    try {
      return await run(attachment);
    } finally {
      this.detach(serverId);
    }
  }

  isAttached(serverId: string): boolean {
    return this.active.has(serverId);
  }

  /** Call when S1 reports the server disconnected: the forward cannot outlive its connection. */
  async stop(serverId: string): Promise<void> {
    const host = this.active.get(serverId);
    if (!host) return;
    this.active.delete(serverId);
    if (host.idleTimer) clearTimeout(host.idleTimer);
    const closing = host.forward.close().finally(() => {
      host.lease.release();
      this.stopping.delete(serverId);
    });
    this.stopping.set(serverId, closing);
    await closing;
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.active.keys(), (serverId) => this.stop(serverId)));
  }

  private start(serverId: string): Promise<ActiveHost> {
    const running = this.active.get(serverId);
    if (running) return Promise.resolve(running);
    const pending = this.starting.get(serverId);
    if (pending) return pending;
    const started = this.open(serverId).finally(() => this.starting.delete(serverId));
    this.starting.set(serverId, started);
    return started;
  }

  private async open(serverId: string): Promise<ActiveHost> {
    await this.stopping.get(serverId);
    const lease = await this.options.acquire(serverId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new RemoteDockerError("connect_failed", message, { cause: error });
    });
    try {
      const remoteSocketPath = await findRemoteSocket(lease.client);
      await pingDocker(lease.client, remoteSocketPath);
      const localSocketPath = path.join(this.options.runDirectory, localSocketName(serverId));
      const forward = await forwardUnixSocket({
        client: lease.client,
        remoteSocketPath,
        localSocketPath,
      });
      const host: ActiveHost = {
        attachment: {
          serverId,
          dockerHost: `unix://${localSocketPath}`,
          localSocketPath,
          remoteSocketPath,
        },
        lease,
        forward,
        holders: 0,
        idleTimer: null,
      };
      forward.onIdle(() => this.scheduleIdleStop(serverId, host));
      this.active.set(serverId, host);
      return host;
    } catch (error) {
      lease.release();
      if (error instanceof StreamLocalRefusedError) {
        throw new RemoteDockerError("forwarding_refused", error.message, { cause: error });
      }
      throw error;
    }
  }

  private scheduleIdleStop(serverId: string, host: ActiveHost): void {
    if (host.holders > 0 || host.forward.activeConnections() > 0 || host.idleTimer) return;
    host.idleTimer = setTimeout(() => {
      host.idleTimer = null;
      const isIdle = host.holders === 0 && host.forward.activeConnections() === 0;
      if (isIdle && this.active.get(serverId) === host) void this.stop(serverId);
    }, this.idleTimeoutMs);
  }
}
