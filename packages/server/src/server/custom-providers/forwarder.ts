import net from "node:net";
import type { Duplex } from "node:stream";
import type { Logger } from "pino";
import type { TailnetSocksProxy } from "../tsnet-listener.js";
import type { AcquireSshClient, SshClientLease } from "../ssh/ssh-client-lease.js";
import { connectThroughProxy } from "../ssh/proxy/connect.js";
import type { ApiRoute } from "./types.js";
import { CustomProviderError } from "./types.js";

/** The routing part of an api provider entry needed to open a forward. */
export interface ForwardTarget {
  baseUrl: string;
  via: ApiRoute;
  sshServerId?: string;
}

interface ActiveListener {
  server: net.Server;
  port: number;
  lease?: SshClientLease;
}

function splice(a: Duplex, b: Duplex): void {
  a.pipe(b).pipe(a);
  a.on("error", () => b.destroy());
  b.on("error", () => a.destroy());
  a.on("close", () => b.destroy());
  b.on("close", () => a.destroy());
}

function listenOnLoopback(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Listener did not report a TCP port"));
    });
  });
}

function parseTargetHostPort(baseUrl: string): { host: string; port: number } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new CustomProviderError("invalid_provider", `Base URL "${baseUrl}" is not a valid URL`);
  }
  const defaultPort = parsed.protocol === "https:" ? 443 : 80;
  return { host: parsed.hostname, port: parsed.port ? Number(parsed.port) : defaultPort };
}

/**
 * Loopback TCP forwards for `via: "tailnet"` / `via: "ssh"` API providers (spec 34.4):
 * one `127.0.0.1` listener on a random port per provider; each accepted connection is
 * piped to the baseUrl host:port through the tsnet SOCKS5 loopback or a `direct-tcpip`
 * channel of the SSH server's connection. The agent gets the base URL rewritten to the
 * listener; there is never a direct fallback.
 */
export class ProviderForwarder {
  private readonly listeners = new Map<string, ActiveListener>();

  constructor(
    private readonly options: {
      logger: Logger;
      getTailnetSocks: () => TailnetSocksProxy | null;
      acquireSshClient?: AcquireSshClient;
    },
  ) {}

  /**
   * Ensures the forward for the provider exists and returns the effective base URL:
   * same scheme/path with host:port replaced by the loopback listener (direct routes
   * return the base URL unchanged).
   */
  async effectiveBaseUrl(providerId: string, target: ForwardTarget): Promise<string> {
    if (target.via === "direct") return target.baseUrl;
    const port = await this.ensureListener(providerId, target);
    const parsed = new URL(target.baseUrl);
    parsed.host = `127.0.0.1:${port}`;
    return parsed.toString();
  }

  async ensureListener(providerId: string, target: ForwardTarget): Promise<number> {
    const existing = this.listeners.get(providerId);
    if (existing) return existing.port;
    if (target.via === "tailnet") return this.openTailnetListener(providerId, target);
    if (target.via === "ssh") return this.openSshListener(providerId, target);
    throw new CustomProviderError("invalid_provider", `Unknown route ${target.via}`);
  }

  close(providerId: string): void {
    const listener = this.listeners.get(providerId);
    if (!listener) return;
    this.listeners.delete(providerId);
    listener.lease?.release();
    listener.server.close();
  }

  closeAll(): void {
    for (const providerId of this.listeners.keys()) this.close(providerId);
  }

  private openTailnetListener(providerId: string, target: ForwardTarget): Promise<number> {
    const socks = this.options.getTailnetSocks();
    if (!socks) {
      throw new CustomProviderError(
        "tailnet_unavailable",
        "The daemon tailnet is not ready; the endpoint cannot be reached",
      );
    }
    const destination = parseTargetHostPort(target.baseUrl);
    const server = net.createServer((socket) => {
      socket.on("error", () => socket.destroy());
      connectThroughProxy({ ...socks, type: "socks5" }, destination, { timeoutMs: 10_000 })
        .then((remote) => splice(socket, remote))
        .catch((error: unknown) => {
          this.options.logger.debug(
            { err: error, target: `${destination.host}:${destination.port}` },
            "Tailnet forward dial failed",
          );
          socket.destroy();
        });
    });
    return this.bindListener(providerId, server);
  }

  private async openSshListener(providerId: string, target: ForwardTarget): Promise<number> {
    const acquire = this.options.acquireSshClient;
    if (!acquire || !target.sshServerId) {
      throw new CustomProviderError(
        "invalid_provider",
        `via "ssh" requires a known sshServerId (got ${target.sshServerId ?? "none"})`,
      );
    }
    const destination = parseTargetHostPort(target.baseUrl);
    let lease: SshClientLease;
    try {
      lease = await acquire(target.sshServerId);
    } catch (error) {
      throw new CustomProviderError(
        "endpoint_unreachable",
        `SSH server ${target.sshServerId} is not connected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const server = net.createServer((socket) => {
      socket.on("error", () => socket.destroy());
      lease.client.forwardOut(
        socket.remoteAddress ?? "127.0.0.1",
        socket.remotePort ?? 0,
        destination.host,
        destination.port,
        (error, forwarded) => {
          if (error || !forwarded) {
            socket.destroy();
            return;
          }
          splice(socket, forwarded);
        },
      );
    });
    const port = await this.bindListener(providerId, server, lease);
    // If the SSH connection drops, drop the listener so the next spawn re-acquires.
    lease.client.once("close", () => {
      if (this.listeners.get(providerId)?.server === server) {
        this.listeners.delete(providerId);
        server.close();
        lease.release();
      }
    });
    return port;
  }

  private async bindListener(
    providerId: string,
    server: net.Server,
    lease?: SshClientLease,
  ): Promise<number> {
    const port = await listenOnLoopback(server);
    this.listeners.set(providerId, { server, port, lease });
    return port;
  }
}
