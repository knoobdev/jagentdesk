import net from "node:net";
import { ProxyError } from "./proxy-error.js";
import { ProxySocketReader } from "./reader.js";
import type { ProxyDeadline } from "./reader.js";
import type { ProxyTarget, SshProxyConfig } from "./connect.js";

export function targetAuthority(target: ProxyTarget): string {
  if (net.isIPv6(target.host)) return `[${target.host}]:${target.port}`;
  return `${target.host}:${target.port}`;
}

export function httpConnectRequest(proxy: SshProxyConfig, target: ProxyTarget): string {
  const authority = targetAuthority(target);
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  const hasCredentials = proxy.username !== undefined || proxy.password !== undefined;
  if (hasCredentials) {
    const secret = `${proxy.username ?? ""}:${proxy.password ?? ""}`;
    const token = Buffer.from(secret, "utf8").toString("base64");
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

export function parseHttpConnectResponse(head: string): void {
  const statusLine = head.split("\r\n", 1)[0];
  const match = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(statusLine);
  if (match === null) {
    throw new ProxyError(
      "proxy_refused",
      `proxy sent an invalid HTTP CONNECT response: ${JSON.stringify(statusLine)}`,
    );
  }
  const status = Number(match[1]);
  if (status >= 200 && status < 300) return;
  throw httpStatusError(status);
}

function httpStatusError(status: number): ProxyError {
  if (status === 407) {
    return new ProxyError("proxy_auth_failed", "HTTP proxy rejected the credentials (407)");
  }
  if (status >= 500) {
    return new ProxyError(
      "proxy_unreachable",
      `HTTP proxy failed to establish the tunnel (${status})`,
    );
  }
  return new ProxyError("proxy_refused", `HTTP proxy refused the CONNECT request (${status})`);
}

/**
 * Sends CONNECT and waits for the 2xx head (RFC 9110 9.3.6). On return the
 * socket carries only tunnel bytes, ready to pass to ssh2 as `sock`.
 */
export async function httpConnectHandshake(
  socket: net.Socket,
  proxy: SshProxyConfig,
  target: ProxyTarget,
  deadline: ProxyDeadline,
): Promise<void> {
  const reader = new ProxySocketReader(socket, deadline);
  socket.write(httpConnectRequest(proxy, target));
  const head = await reader.readHead(
    () =>
      new ProxyError(
        "proxy_refused",
        "HTTP proxy closed the connection before completing the CONNECT response",
      ),
  );
  parseHttpConnectResponse(head);
  reader.pushBackLeftover();
}
