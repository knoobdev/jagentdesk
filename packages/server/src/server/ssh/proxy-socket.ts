import net from "node:net";

// Spec 25.3 step 2: the first hop's TCP connection can go through a SOCKS5 (RFC 1928,
// username/password per RFC 1929) or HTTP CONNECT proxy. Both return a connected
// socket that ssh2 uses as `sock`. The proxy password is only held in memory here.

export interface ProxyTarget {
  type: "socks5" | "http";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly code = "proxy_failed",
  ) {
    super(message);
    this.name = "ProxyError";
  }
}

const SOCKS5_REPLY_MESSAGES: Record<number, string> = {
  1: "general SOCKS server failure",
  2: "connection not allowed by ruleset",
  3: "network unreachable",
  4: "host unreachable",
  5: "connection refused",
  6: "TTL expired",
  7: "command not supported",
  8: "address type not supported",
};

/** Reads exactly-sized chunks from a socket during a handshake. */
class HandshakeReader {
  private buffer = Buffer.alloc(0);
  private waiter: { size: number; resolve: (b: Buffer) => void } | null = null;
  private failure: Error | null = null;
  private rejecter: ((error: Error) => void) | null = null;

  constructor(private readonly socket: net.Socket) {
    socket.on("data", this.onData);
    socket.once("error", this.onError);
    socket.once("close", this.onClose);
  }

  private onData = (chunk: Buffer): void => {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
  };

  private onError = (error: Error): void => {
    this.fail(error);
  };

  private onClose = (): void => {
    this.fail(new ProxyError("Proxy closed the connection during the handshake."));
  };

  private fail(error: Error): void {
    this.failure ??= error;
    const reject = this.rejecter;
    this.waiter = null;
    this.rejecter = null;
    reject?.(this.failure);
  }

  private drain(): void {
    if (!this.waiter || this.buffer.length < this.waiter.size) return;
    const { size, resolve } = this.waiter;
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    this.waiter = null;
    this.rejecter = null;
    resolve(out);
  }

  read(size: number): Promise<Buffer> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { size, resolve };
      this.rejecter = reject;
      this.drain();
    });
  }

  /** Read until `\r\n\r\n` (HTTP response head). */
  async readHttpHead(maxBytes = 16_384): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end >= 0) {
        const head = this.buffer.subarray(0, end).toString("latin1");
        this.buffer = this.buffer.subarray(end + 4);
        return head;
      }
      if (this.buffer.length > maxBytes) throw new ProxyError("Proxy response head too large.");
      // Wait for at least one more byte, then put everything back and rescan.
      const chunk = await this.read(this.buffer.length + 1);
      this.buffer = Buffer.concat([chunk, this.buffer]);
    }
  }

  /** Stop intercepting; anything already buffered past the handshake is returned. */
  detach(): Buffer {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
    return this.buffer;
  }
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new ProxyError(`Timed out connecting to proxy ${host}:${port}.`));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new ProxyError(`Cannot reach proxy ${host}:${port}: ${error.message}`));
    });
  });
}

export function encodeSocks5Address(host: string): Buffer {
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    return Buffer.from([0x01, ...host.split(".").map((part) => Number(part))]);
  }
  if (ipVersion === 6) {
    const groups = expandIpv6(host);
    const out = Buffer.alloc(17);
    out[0] = 0x04;
    groups.forEach((group, index) => out.writeUInt16BE(group, 1 + index * 2));
    return out;
  }
  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw new ProxyError("Host name too long for SOCKS5.");
  return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

function expandIpv6(address: string): number[] {
  const [head, tail] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail !== undefined && tail.length > 0 ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [
    ...headParts,
    ...Array.from({ length: tail !== undefined ? missing : 0 }, () => "0"),
    ...tailParts,
  ];
  return parts.map((part) => parseInt(part || "0", 16));
}

async function socks5Handshake(
  socket: net.Socket,
  proxy: ProxyTarget,
  destHost: string,
  destPort: number,
): Promise<void> {
  const reader = new HandshakeReader(socket);
  try {
    const wantsAuth = Boolean(proxy.username);
    socket.write(Buffer.from(wantsAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    const greeting = await reader.read(2);
    if (greeting[0] !== 0x05) throw new ProxyError("Proxy is not a SOCKS5 server.");
    if (greeting[1] === 0xff) {
      throw new ProxyError("SOCKS5 proxy rejected every offered auth method.", "proxy_auth_failed");
    }
    if (greeting[1] === 0x02) {
      const user = Buffer.from(proxy.username ?? "", "utf8");
      const pass = Buffer.from(proxy.password ?? "", "utf8");
      if (user.length > 255 || pass.length > 255) {
        throw new ProxyError("SOCKS5 credentials too long.");
      }
      socket.write(
        Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]),
      );
      const authReply = await reader.read(2);
      if (authReply[1] !== 0x00) {
        throw new ProxyError("SOCKS5 proxy rejected the credentials.", "proxy_auth_failed");
      }
    } else if (greeting[1] !== 0x00) {
      throw new ProxyError("SOCKS5 proxy chose an unsupported auth method.");
    }
    const port = Buffer.alloc(2);
    port.writeUInt16BE(destPort, 0);
    socket.write(
      Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), encodeSocks5Address(destHost), port]),
    );
    const head = await reader.read(4);
    if (head[1] !== 0x00) {
      const reason = SOCKS5_REPLY_MESSAGES[head[1]] ?? `error ${head[1]}`;
      throw new ProxyError(`SOCKS5 proxy could not connect: ${reason}.`);
    }
    // Skip the bound address in the reply.
    const addressType = head[3];
    if (addressType === 0x01) await reader.read(4 + 2);
    else if (addressType === 0x04) await reader.read(16 + 2);
    else if (addressType === 0x03) {
      const length = (await reader.read(1))[0];
      await reader.read(length + 2);
    } else throw new ProxyError("SOCKS5 proxy sent an unknown address type.");
    const rest = reader.detach();
    if (rest.length > 0) socket.unshift(rest);
  } catch (error) {
    reader.detach();
    throw error;
  }
}

async function httpConnectHandshake(
  socket: net.Socket,
  proxy: ProxyTarget,
  destHost: string,
  destPort: number,
): Promise<void> {
  const reader = new HandshakeReader(socket);
  try {
    const authority = net.isIPv6(destHost)
      ? `[${destHost}]:${destPort}`
      : `${destHost}:${destPort}`;
    const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
    if (proxy.username) {
      const token = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`, "utf8").toString(
        "base64",
      );
      lines.push(`Proxy-Authorization: Basic ${token}`);
    }
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    const head = await reader.readHttpHead();
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(head);
    if (!status) throw new ProxyError("HTTP proxy sent an invalid response.");
    const code = Number(status[1]);
    if (code === 407) {
      throw new ProxyError("HTTP proxy requires valid credentials (407).", "proxy_auth_failed");
    }
    if (code < 200 || code >= 300) {
      throw new ProxyError(`HTTP proxy refused the tunnel (${code}).`);
    }
    const rest = reader.detach();
    if (rest.length > 0) socket.unshift(rest);
  } catch (error) {
    reader.detach();
    throw error;
  }
}

/** Open a TCP tunnel to destHost:destPort through the proxy. */
export async function connectThroughProxy(
  proxy: ProxyTarget,
  destHost: string,
  destPort: number,
  timeoutMs = 20_000,
): Promise<net.Socket> {
  const socket = await connectTcp(proxy.host, proxy.port, timeoutMs);
  const timer = setTimeout(() => {
    socket.destroy(new ProxyError("Proxy handshake timed out."));
  }, timeoutMs);
  try {
    if (proxy.type === "socks5") await socks5Handshake(socket, proxy, destHost, destPort);
    else await httpConnectHandshake(socket, proxy, destHost, destPort);
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
