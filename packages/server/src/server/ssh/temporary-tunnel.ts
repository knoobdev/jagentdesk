import net from "node:net";
import type { Client, ClientChannel } from "ssh2";

// A temporary `-L` forward owned by a feature (a database connection, a cluster), not a saved
// forwarding rule (S3): spec 25.10 opens it for the connection and closes it with it.

export type TunnelErrorCode = "port_in_use" | "forwarding_refused" | "remote_unreachable";

export class TunnelError extends Error {
  constructor(
    readonly code: TunnelErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TunnelError";
  }
}

export interface TemporaryTunnel {
  bindHost: string;
  port: number;
  activeConnections(): number;
  /** Called whenever the last active connection ends. */
  onIdle(listener: () => void): void;
  close(): Promise<void>;
}

export interface TemporaryTunnelInput {
  client: Client;
  bindHost: string;
  /** 0 picks a free port. */
  bindPort: number;
  /** As seen from the server, e.g. "127.0.0.1" for a service listening on the server itself. */
  destHost: string;
  destPort: number;
}

// SSH_OPEN_ADMINISTRATIVELY_PROHIBITED (RFC 4254 §5.1): sshd forbids forwarding.
const ADMINISTRATIVELY_PROHIBITED = 1;

function classifyOpenFailure(error: Error, destHost: string, destPort: number): TunnelError {
  const reason = (error as Error & { reason?: number }).reason;
  if (reason === ADMINISTRATIVELY_PROHIBITED) {
    return new TunnelError(
      "forwarding_refused",
      `the server refused to forward: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  return new TunnelError(
    "remote_unreachable",
    `the server could not connect to ${destHost}:${destPort}: ${error.message}`,
    { cause: error },
  );
}

function forwardOut(
  client: Client,
  source: { address: string; port: number },
  destHost: string,
  destPort: number,
): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.forwardOut(source.address, source.port, destHost, destPort, (error, channel) => {
      if (error) reject(classifyOpenFailure(error, destHost, destPort));
      else resolve(channel);
    });
  });
}

/**
 * Opens and closes one forwarded channel: proves sshd allows forwarding and the server reaches
 * `destHost:destPort` before anything is handed to a client. Rejects with TunnelError.
 */
export async function probeForward(
  client: Client,
  destHost: string,
  destPort: number,
): Promise<void> {
  const channel = await forwardOut(client, { address: "127.0.0.1", port: 0 }, destHost, destPort);
  channel.close();
}

export async function openTemporaryTunnel(input: TemporaryTunnelInput): Promise<TemporaryTunnel> {
  const { client, bindHost, destHost, destPort } = input;
  const sockets = new Set<net.Socket>();
  const idleListeners: Array<() => void> = [];

  async function connect(local: net.Socket): Promise<void> {
    const source = { address: local.remoteAddress ?? bindHost, port: local.remotePort ?? 0 };
    let channel: ClientChannel;
    try {
      channel = await forwardOut(client, source, destHost, destPort);
    } catch {
      local.destroy();
      return;
    }
    channel.on("error", () => local.destroy());
    channel.on("close", () => local.end());
    local.on("close", () => channel.close());
    local.pipe(channel).pipe(local);
    local.resume();
  }

  function accept(local: net.Socket): void {
    sockets.add(local);
    local.once("close", () => {
      sockets.delete(local);
      if (sockets.size === 0) for (const listener of idleListeners) listener();
    });
    local.on("error", () => local.destroy());
    local.pause();
    void connect(local);
  }

  const server = net.createServer({ allowHalfOpen: true }, accept);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(
          new TunnelError("port_in_use", `${bindHost}:${input.bindPort} is already in use`, {
            cause: error,
          }),
        );
      } else {
        reject(error);
      }
    });
    server.listen(input.bindPort, bindHost, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("tunnel listener has no TCP address");
  }
  return {
    bindHost,
    port: address.port,
    activeConnections: () => sockets.size,
    onIdle(listener) {
      idleListeners.push(listener);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
