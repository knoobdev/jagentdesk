import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  RemoteDbConnection,
  RemoteDbErrorCode,
  RemoteDbKind,
} from "@jagentdesk/protocol/ssh/remote-db-schemas";
import { writePrivateFileAtomicSync } from "../../private-files.js";
import type { AcquireSshClient, SshClientLease } from "../ssh-client-lease.js";
import {
  openTemporaryTunnel,
  probeForward,
  TunnelError,
  type TemporaryTunnel,
} from "../temporary-tunnel.js";

export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;
const TUNNEL_HOST = "127.0.0.1";

export class RemoteDbError extends Error {
  constructor(
    readonly code: RemoteDbErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RemoteDbError";
  }
}

// One fixed local port per (server, remote host, remote port): the Databases feature stores the
// connection as 127.0.0.1:<localPort>, so the port must survive restarts.
const RemoteDbTargetSchema = z.object({
  serverId: z.string(),
  remoteHost: z.string(),
  remotePort: z.number().int(),
  localPort: z.number().int(),
});
type RemoteDbTarget = z.infer<typeof RemoteDbTargetSchema>;

export interface PrepareRemoteDbInput {
  serverId: string;
  kind: RemoteDbKind;
  remoteHost: string;
  remotePort: number;
}

export interface PreparedRemoteDb {
  localPort: number;
  connection: RemoteDbConnection;
}

interface OpenTunnel {
  target: RemoteDbTarget;
  tunnel: TemporaryTunnel;
  lease: SshClientLease;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

function targetKey(serverId: string, remoteHost: string, remotePort: number): string {
  return `${serverId}\u0000${remoteHost}\u0000${remotePort}`;
}

/** `127.0.0.1:<port>/…` target of a Databases connection → port, else null. */
export function localPortOfTarget(target: string): number | null {
  const match = /^127\.0\.0\.1:(\d+)(\/|$)/.exec(target);
  return match ? Number(match[1]) : null;
}

/**
 * Temporary forwards for databases reached through SSH servers (spec 25.10). A forward opens on
 * `prepare` (or when a saved connection reconnects) and closes once no database connection has
 * used it for the idle timeout, or when its server disconnects.
 */
export class RemoteDbTunnels {
  private readonly filePath: string;
  private readonly targets: Map<string, RemoteDbTarget>;
  private readonly open = new Map<string, OpenTunnel>();
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly options: {
      acquire: AcquireSshClient;
      /** Persists `$JAGENTDESK_HOME/ssh/remote-db.json` (0600). */
      jagentdeskHome: string;
      idleTimeoutMs?: number;
    },
  ) {
    this.filePath = path.join(options.jagentdeskHome, "ssh", "remote-db.json");
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.targets = new Map(
      this.load().map((target) => [
        targetKey(target.serverId, target.remoteHost, target.remotePort),
        target,
      ]),
    );
  }

  /** `ssh.remote_db.prepare`: the forward is open and reachable when this resolves. */
  async prepare(input: PrepareRemoteDbInput): Promise<PreparedRemoteDb> {
    const key = targetKey(input.serverId, input.remoteHost, input.remotePort);
    const known = this.targets.get(key);
    const opened = await this.ensureOpen(key, {
      serverId: input.serverId,
      remoteHost: input.remoteHost,
      remotePort: input.remotePort,
      localPort: known?.localPort ?? 0,
    });
    return {
      localPort: opened.target.localPort,
      connection: {
        engine: input.kind,
        config: { host: TUNNEL_HOST, port: opened.target.localPort },
      },
    };
  }

  /** True when a Databases connection on 127.0.0.1:<port> goes through a server. */
  isRemotePort(localPort: number): boolean {
    return this.findByLocalPort(localPort) !== null;
  }

  /** Call before `database/connect` of a connection whose port `isRemotePort`. */
  async reopenForLocalPort(localPort: number): Promise<void> {
    const target = this.findByLocalPort(localPort);
    if (target === null) return;
    await this.ensureOpen(targetKey(target.serverId, target.remoteHost, target.remotePort), target);
  }

  /** Call when S1 reports the server gone. */
  async onServerDisconnected(serverId: string): Promise<void> {
    const keys = Array.from(this.open.entries())
      .filter(([, opened]) => opened.target.serverId === serverId)
      .map(([key]) => key);
    await Promise.all(keys.map((key) => this.close(key)));
  }

  async closeAll(): Promise<void> {
    await Promise.all(Array.from(this.open.keys(), (key) => this.close(key)));
  }

  isOpen(localPort: number): boolean {
    return Array.from(this.open.values()).some((opened) => opened.target.localPort === localPort);
  }

  private findByLocalPort(localPort: number): RemoteDbTarget | null {
    return (
      Array.from(this.targets.values()).find((target) => target.localPort === localPort) ?? null
    );
  }

  private async ensureOpen(key: string, target: RemoteDbTarget): Promise<OpenTunnel> {
    const existing = this.open.get(key);
    if (existing) {
      this.scheduleIdleClose(key, existing);
      return existing;
    }
    const lease = await this.options.acquire(target.serverId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new RemoteDbError("connect_failed", message, { cause: error });
    });
    try {
      await probeForward(lease.client, target.remoteHost, target.remotePort);
      const tunnel = await openTemporaryTunnel({
        client: lease.client,
        bindHost: TUNNEL_HOST,
        bindPort: target.localPort,
        destHost: target.remoteHost,
        destPort: target.remotePort,
      });
      const opened: OpenTunnel = {
        target: { ...target, localPort: tunnel.port },
        tunnel,
        lease,
        idleTimer: null,
      };
      tunnel.onIdle(() => this.scheduleIdleClose(key, opened));
      this.open.set(key, opened);
      if (target.localPort !== tunnel.port) {
        this.targets.set(key, opened.target);
        this.persist();
      }
      // Nothing is connected yet: the client has the idle period to add/connect the database.
      this.scheduleIdleClose(key, opened);
      return opened;
    } catch (error) {
      lease.release();
      if (error instanceof TunnelError) {
        throw new RemoteDbError(error.code, error.message, { cause: error });
      }
      throw error;
    }
  }

  private scheduleIdleClose(key: string, opened: OpenTunnel): void {
    if (opened.idleTimer) clearTimeout(opened.idleTimer);
    opened.idleTimer = setTimeout(() => {
      opened.idleTimer = null;
      const isIdle = opened.tunnel.activeConnections() === 0;
      // Still in use: the next onIdle reschedules.
      if (isIdle && this.open.get(key) === opened) void this.close(key);
    }, this.idleTimeoutMs);
  }

  private async close(key: string): Promise<void> {
    const opened = this.open.get(key);
    if (!opened) return;
    this.open.delete(key);
    if (opened.idleTimer) clearTimeout(opened.idleTimer);
    await opened.tunnel.close();
    opened.lease.release();
  }

  private load(): RemoteDbTarget[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return z.array(RemoteDbTargetSchema).parse(JSON.parse(raw));
  }

  private persist(): void {
    const targets = Array.from(this.targets.values());
    writePrivateFileAtomicSync(this.filePath, JSON.stringify(targets, null, 2));
  }
}
