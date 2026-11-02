import net from "node:net";
import { ProxyError } from "./proxy-error.js";
import type { ProxyErrorCode } from "./proxy-error.js";
import { ProxySocketReader } from "./reader.js";
import type { ProxyDeadline } from "./reader.js";
import type { ProxyTarget, SshProxyConfig } from "./connect.js";

const SOCKS_VERSION = 0x05;
const COMMAND_CONNECT = 0x01;
const METHOD_NONE = 0x00;
const METHOD_USERPASS = 0x02;
const METHOD_UNACCEPTABLE = 0xff;
const ADDRESS_IPV4 = 0x01;
const ADDRESS_DOMAIN = 0x03;
const ADDRESS_IPV6 = 0x04;
const USERPASS_VERSION = 0x01;
const USERPASS_OK = 0x00;

// RFC 1928 reply codes → spec-style error codes (25.3 step 2).
const REPLY_FAILURES = new Map<number, { code: ProxyErrorCode; reason: string }>([
  [0x01, { code: "proxy_unreachable", reason: "general SOCKS server failure" }],
  [0x02, { code: "proxy_refused", reason: "connection not allowed by ruleset" }],
  [0x03, { code: "proxy_unreachable", reason: "network unreachable" }],
  [0x04, { code: "proxy_unreachable", reason: "host unreachable" }],
  [0x05, { code: "proxy_refused", reason: "connection refused by destination host" }],
  [0x06, { code: "proxy_unreachable", reason: "TTL expired" }],
  [0x07, { code: "proxy_refused", reason: "command not supported" }],
  [0x08, { code: "proxy_refused", reason: "address type not supported" }],
]);

export function socks5Greeting(proxy: SshProxyConfig): Buffer {
  const offersUserpass = proxy.username !== undefined || proxy.password !== undefined;
  return offersUserpass
    ? Buffer.from([SOCKS_VERSION, 0x02, METHOD_NONE, METHOD_USERPASS])
    : Buffer.from([SOCKS_VERSION, 0x01, METHOD_NONE]);
}

export function parseSocks5MethodSelection(selection: Buffer): number {
  if (selection[0] !== SOCKS_VERSION) {
    throw new ProxyError(
      "proxy_refused",
      `proxy replied with SOCKS version ${selection[0]}, expected 5`,
    );
  }
  if (selection[1] === METHOD_UNACCEPTABLE) {
    throw new ProxyError("proxy_auth_failed", "SOCKS5 proxy requires unsupported authentication");
  }
  return selection[1];
}

export function socks5UserPassRequest(proxy: SshProxyConfig): Buffer {
  const username = Buffer.from(proxy.username ?? "", "utf8");
  const password = Buffer.from(proxy.password ?? "", "utf8");
  if (username.length > 255 || password.length > 255) {
    throw new ProxyError("proxy_refused", "SOCKS5 proxy credentials must be at most 255 bytes");
  }
  return Buffer.concat([
    Buffer.from([USERPASS_VERSION, username.length]),
    username,
    Buffer.from([password.length]),
    password,
  ]);
}

export function parseSocks5UserPassStatus(status: Buffer): void {
  if (status[1] !== USERPASS_OK) {
    throw new ProxyError(
      "proxy_auth_failed",
      `SOCKS5 username/password authentication failed (status ${status[1]})`,
    );
  }
}

export function socks5ConnectRequest(target: ProxyTarget): Buffer {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(target.port);
  const header = Buffer.from([SOCKS_VERSION, COMMAND_CONNECT, 0x00]);
  if (net.isIPv4(target.host)) {
    const octets = Buffer.from(target.host.split(".").map(Number));
    return Buffer.concat([header, Buffer.from([ADDRESS_IPV4]), octets, portBytes]);
  }
  if (net.isIPv6(target.host)) {
    return Buffer.concat([header, Buffer.from([ADDRESS_IPV6]), encodeIpv6(target.host), portBytes]);
  }
  const domain = Buffer.from(target.host, "utf8");
  if (domain.length > 255) {
    throw new ProxyError(
      "proxy_refused",
      `SOCKS5 cannot address target longer than 255 bytes: ${target.host}`,
    );
  }
  return Buffer.concat([header, Buffer.from([ADDRESS_DOMAIN, domain.length]), domain, portBytes]);
}

export function parseSocks5ReplyHead(head: Buffer): { replyCode: number; addressType: number } {
  if (head[0] !== SOCKS_VERSION) {
    throw new ProxyError(
      "proxy_refused",
      `proxy replied with SOCKS version ${head[0]}, expected 5`,
    );
  }
  const failure = REPLY_FAILURES.get(head[1]);
  if (failure !== undefined) {
    throw new ProxyError(failure.code, `SOCKS5 proxy could not open the tunnel: ${failure.reason}`);
  }
  if (head[1] !== 0x00) {
    throw new ProxyError("proxy_refused", `SOCKS5 proxy returned unknown reply code ${head[1]}`);
  }
  return { replyCode: head[1], addressType: head[3] };
}

/**
 * Completes the RFC 1928/1929 exchange on a connected socket. On return the
 * socket carries only tunnel bytes (leftover handshake-timed reads are pushed
 * back), ready to pass to ssh2 as `sock`.
 */
export async function socks5Handshake(
  socket: net.Socket,
  proxy: SshProxyConfig,
  target: ProxyTarget,
  deadline: ProxyDeadline,
): Promise<void> {
  const reader = new ProxySocketReader(socket, deadline);
  socket.write(socks5Greeting(proxy));
  const method = parseSocks5MethodSelection(
    await reader.readBytes(
      2,
      () =>
        new ProxyError(
          "proxy_refused",
          "SOCKS5 proxy closed the connection during method selection",
        ),
    ),
  );
  if (method === METHOD_USERPASS) {
    socket.write(socks5UserPassRequest(proxy));
    const status = await reader.readBytes(
      2,
      () =>
        new ProxyError(
          "proxy_auth_failed",
          "SOCKS5 proxy closed the connection during username/password authentication",
        ),
    );
    parseSocks5UserPassStatus(status);
  } else if (method !== METHOD_NONE) {
    throw new ProxyError("proxy_refused", `SOCKS5 proxy selected unsupported method ${method}`);
  }

  socket.write(socks5ConnectRequest(target));
  const head = await reader.readBytes(
    4,
    () => new ProxyError("proxy_refused", "SOCKS5 proxy closed the connection during CONNECT"),
  );
  const { addressType } = parseSocks5ReplyHead(head);
  const boundAddressLength = await readBoundAddressLength(reader, addressType);
  await reader.readBytes(
    boundAddressLength + 2,
    () => new ProxyError("proxy_refused", "SOCKS5 proxy closed the connection during CONNECT"),
  );
  reader.pushBackLeftover();
}

// The BND.ADDR + BND.PORT fields must be consumed so the ssh2 handshake starts clean.
async function readBoundAddressLength(
  reader: ProxySocketReader,
  addressType: number,
): Promise<number> {
  if (addressType === ADDRESS_IPV4) return 4;
  if (addressType === ADDRESS_IPV6) return 16;
  if (addressType === ADDRESS_DOMAIN) {
    const lengthByte = await reader.readBytes(
      1,
      () => new ProxyError("proxy_refused", "SOCKS5 proxy closed the connection during CONNECT"),
    );
    return lengthByte[0] + 1;
  }
  throw new ProxyError(
    "proxy_refused",
    `SOCKS5 proxy returned invalid bound address type ${addressType}`,
  );
}

function encodeIpv6(host: string): Buffer {
  const literal = host.split("%", 1)[0];
  const halves = literal.split("::");
  if (halves.length > 2) {
    throw new ProxyError("proxy_refused", `invalid IPv6 target host: ${host}`);
  }
  const head = parseIpv6Groups(halves[0], host);
  const tail = halves.length === 2 ? parseIpv6Groups(halves[1], host) : [];
  const groups =
    halves.length === 2
      ? [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => 0), ...tail]
      : head;
  if (groups.length !== 8) {
    throw new ProxyError("proxy_refused", `invalid IPv6 target host: ${host}`);
  }
  const bytes = Buffer.alloc(16);
  groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
  return bytes;
}

function parseIpv6Groups(text: string, host: string): number[] {
  if (text === "") return [];
  const groups: number[] = [];
  for (const segment of text.split(":")) {
    if (segment.includes(".")) {
      const octets = segment.split(".").map(Number);
      const invalid =
        octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255);
      if (invalid) {
        throw new ProxyError("proxy_refused", `invalid IPv6 target host: ${host}`);
      }
      groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      continue;
    }
    const value = Number.parseInt(segment, 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) {
      throw new ProxyError("proxy_refused", `invalid IPv6 target host: ${host}`);
    }
    groups.push(value);
  }
  return groups;
}
