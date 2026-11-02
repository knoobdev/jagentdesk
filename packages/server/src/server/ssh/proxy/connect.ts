import net from "node:net";
import { ProxyError } from "./proxy-error.js";
import { httpConnectHandshake } from "./http-connect.js";
import { createProxyDeadline } from "./reader.js";
import type { ProxyDeadline } from "./reader.js";
import { socks5Handshake } from "./socks5.js";

export interface SshProxyConfig {
  type: "socks5" | "http";
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface ProxyTarget {
  host: string;
  port: number;
}

export interface ConnectThroughProxyOptions {
  /** Budget for the TCP connect plus the full proxy handshake. Default 10000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Opens a TCP connection to `target` through `proxy` (spec 25.3 step 2: "If there
 * is a proxy: TCP goes through SOCKS5/HTTP CONNECT first"). The returned socket is
 * a connected duplex tunnel ready to pass as ssh2's `sock` connect option. Both
 * protocol handshakes are implemented here (RFC 1928/1929, RFC 9110 9.3); the
 * socket carries only tunnel bytes on return. Throws ProxyError with code
 * `proxy_unreachable` | `proxy_auth_failed` | `proxy_refused`; the socket is
 * destroyed on every failure.
 */
export async function connectThroughProxy(
  proxy: SshProxyConfig,
  target: ProxyTarget,
  options?: ConnectThroughProxyOptions,
): Promise<net.Socket> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = createProxyDeadline(timeoutMs);
  const socket = await connectTcp(proxy, deadline);
  try {
    if (proxy.type === "socks5") {
      await socks5Handshake(socket, proxy, target, deadline);
    } else {
      await httpConnectHandshake(socket, proxy, target, deadline);
    }
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return socket;
}

function connectTcp(proxy: SshProxyConfig, deadline: ProxyDeadline): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxy.host, port: proxy.port });
    const label = `${proxy.type} proxy ${proxy.host}:${proxy.port}`;
    function cleanup() {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
      socket.setTimeout(0);
    }
    function onConnect() {
      cleanup();
      resolve(socket);
    }
    function onError(error: Error) {
      cleanup();
      socket.destroy();
      reject(new ProxyError("proxy_unreachable", `${label} is unreachable: ${error.message}`));
    }
    function onTimeout() {
      cleanup();
      socket.destroy();
      reject(
        new ProxyError(
          "proxy_unreachable",
          `${label} is unreachable: no response within ${deadline.timeoutMs}ms`,
        ),
      );
    }
    socket.setTimeout(deadline.remainingMs());
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}
