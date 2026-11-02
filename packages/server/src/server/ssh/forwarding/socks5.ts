import type { Duplex } from "node:stream";

// Minimal SOCKS5 server side (RFC 1928): no-auth method, CONNECT command, IPv4 / domain / IPv6
// addresses. Enough for `curl --socks5`, browsers and `ssh -o ProxyCommand=nc -X 5`.

export interface SocksTarget {
  host: string;
  port: number;
}

export const SOCKS_REPLY = {
  succeeded: 0x00,
  generalFailure: 0x01,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressNotSupported: 0x08,
} as const;

export class SocksProtocolError extends Error {
  constructor(
    readonly reply: number,
    message: string,
  ) {
    super(message);
    this.name = "SocksProtocolError";
  }
}

/** Bytes needed for a full greeting, or the methods offered once complete. */
export function parseGreeting(buffer: Buffer): { methods: number[]; length: number } | null {
  if (buffer.length < 2) return null;
  if (buffer[0] !== 0x05) throw new SocksProtocolError(SOCKS_REPLY.generalFailure, "Not SOCKS5");
  const length = 2 + buffer[1];
  if (buffer.length < length) return null;
  return { methods: Array.from(buffer.subarray(2, length)), length };
}

function formatIPv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  return groups.join(":");
}

/** Parses a CONNECT request; null while more bytes are needed. */
export function parseRequest(buffer: Buffer): { target: SocksTarget; length: number } | null {
  if (buffer.length < 5) return null;
  if (buffer[0] !== 0x05) throw new SocksProtocolError(SOCKS_REPLY.generalFailure, "Not SOCKS5");
  if (buffer[1] !== 0x01) {
    throw new SocksProtocolError(SOCKS_REPLY.commandNotSupported, "Only CONNECT is supported");
  }
  const addressType = buffer[3];
  let host: string;
  let offset: number;
  if (addressType === 0x01) {
    offset = 4 + 4;
    if (buffer.length < offset + 2) return null;
    host = Array.from(buffer.subarray(4, 8)).join(".");
  } else if (addressType === 0x03) {
    offset = 5 + buffer[4];
    if (buffer.length < offset + 2) return null;
    host = buffer.subarray(5, offset).toString("utf8");
  } else if (addressType === 0x04) {
    offset = 4 + 16;
    if (buffer.length < offset + 2) return null;
    host = formatIPv6(buffer.subarray(4, 20));
  } else {
    throw new SocksProtocolError(SOCKS_REPLY.addressNotSupported, "Unknown address type");
  }
  return { target: { host, port: buffer.readUInt16BE(offset) }, length: offset + 2 };
}

export function buildReply(reply: number): Buffer {
  // Bound address 0.0.0.0:0 — clients ignore it for CONNECT.
  return Buffer.from([0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
}

/**
 * Runs the SOCKS5 handshake on `socket`, opens the upstream with `connect`, then pipes both
 * ways. Any bytes the client sent after the request are forwarded upstream first.
 */
export function serveSocks5(
  socket: Duplex,
  connect: (target: SocksTarget) => Promise<Duplex>,
): void {
  let buffered = Buffer.alloc(0);
  let stage: "greeting" | "request" | "connecting" = "greeting";

  function fail(reply: number): void {
    socket.end(buildReply(reply));
  }

  function onData(chunk: Buffer): void {
    buffered = Buffer.concat([buffered, chunk]);
    try {
      if (stage === "greeting") {
        const greeting = parseGreeting(buffered);
        if (!greeting) return;
        buffered = buffered.subarray(greeting.length);
        if (!greeting.methods.includes(0x00)) {
          socket.end(Buffer.from([0x05, 0xff]));
          return;
        }
        socket.write(Buffer.from([0x05, 0x00]));
        stage = "request";
      }
      if (stage === "request") {
        const request = parseRequest(buffered);
        if (!request) return;
        buffered = buffered.subarray(request.length);
        stage = "connecting";
        socket.off("data", onData);
        socket.pause();
        void open(request.target);
      }
    } catch (error) {
      fail(error instanceof SocksProtocolError ? error.reply : SOCKS_REPLY.generalFailure);
    }
  }

  async function open(target: SocksTarget): Promise<void> {
    let upstream: Duplex;
    try {
      upstream = await connect(target);
    } catch {
      fail(SOCKS_REPLY.connectionRefused);
      return;
    }
    socket.write(buildReply(SOCKS_REPLY.succeeded));
    if (buffered.length > 0) upstream.write(buffered);
    socket.pipe(upstream).pipe(socket);
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.resume();
  }

  socket.on("data", onData);
  socket.on("error", () => socket.destroy());
}
