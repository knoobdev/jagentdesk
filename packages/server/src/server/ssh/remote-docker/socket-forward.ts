import { chmodSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Client, ClientChannel } from "ssh2";
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from "../../private-files.js";

// macOS caps sun_path at 104 bytes, Linux at 108.
const MAX_UNIX_SOCKET_PATH = 103;

export class SocketPathTooLongError extends Error {
  constructor(readonly socketPath: string) {
    super(`unix socket path is too long (${socketPath.length} bytes): ${socketPath}`);
    this.name = "SocketPathTooLongError";
  }
}

// sshd refused the `direct-streamlocal@openssh.com` channel: forwarding disabled, or connect()
// to the remote socket failed (missing socket, permission denied).
export class StreamLocalRefusedError extends Error {
  constructor(
    readonly remoteSocketPath: string,
    readonly cause: Error,
  ) {
    super(`server refused to open ${remoteSocketPath}: ${cause.message}`);
    this.name = "StreamLocalRefusedError";
  }
}

export function openStreamLocal(client: Client, remoteSocketPath: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.openssh_forwardOutStreamLocal(remoteSocketPath, (error, channel) => {
      if (error) reject(new StreamLocalRefusedError(remoteSocketPath, error));
      else resolve(channel);
    });
  });
}

export interface ForwardedSocket {
  localSocketPath: string;
  /** Local connections currently piped to the remote socket. */
  activeConnections(): number;
  /** Called whenever the last active connection ends. */
  onIdle(listener: () => void): void;
  close(): Promise<void>;
}

/**
 * Listens on a private unix socket on this machine and pipes every connection to `remoteSocketPath`
 * on the server through its own streamlocal channel (`ssh -L local.sock:remote.sock`).
 */
export async function forwardUnixSocket(input: {
  client: Client;
  remoteSocketPath: string;
  localSocketPath: string;
}): Promise<ForwardedSocket> {
  const { client, remoteSocketPath, localSocketPath } = input;
  if (Buffer.byteLength(localSocketPath) > MAX_UNIX_SOCKET_PATH) {
    throw new SocketPathTooLongError(localSocketPath);
  }
  ensurePrivateDirectory(path.dirname(localSocketPath));
  // A socket file left by a crashed daemon would make listen() fail with EADDRINUSE.
  rmSync(localSocketPath, { force: true });

  const sockets = new Set<net.Socket>();
  const idleListeners: Array<() => void> = [];

  function pipe(local: net.Socket): void {
    sockets.add(local);
    local.once("close", () => {
      sockets.delete(local);
      if (sockets.size === 0) for (const listener of idleListeners) listener();
    });
    local.on("error", () => local.destroy());
    local.pause();
    void connect(local);
  }

  async function connect(local: net.Socket): Promise<void> {
    let channel: ClientChannel;
    try {
      channel = await openStreamLocal(client, remoteSocketPath);
    } catch {
      local.destroy();
      return;
    }
    channel.on("error", () => local.destroy());
    // end(), not destroy(): flush what the server sent before the channel closed.
    channel.on("close", () => local.end());
    local.on("close", () => channel.close());
    local.pipe(channel).pipe(local);
    local.resume();
  }

  // The docker CLI half-closes after sending a hijacked request (exec, attach) and keeps
  // reading; with Node's default the local socket would close at once and cut the output.
  const server = net.createServer({ allowHalfOpen: true }, pipe);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(localSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  chmodSync(localSocketPath, PRIVATE_FILE_MODE);

  return {
    localSocketPath,
    activeConnections: () => sockets.size,
    onIdle(listener) {
      idleListeners.push(listener);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(localSocketPath, { force: true });
    },
  };
}
