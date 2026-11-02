import { describe, expect, it } from "vitest";
import { ProxyError } from "./proxy-error.js";
import {
  parseSocks5MethodSelection,
  parseSocks5ReplyHead,
  parseSocks5UserPassStatus,
  socks5ConnectRequest,
  socks5Greeting,
  socks5UserPassRequest,
} from "./socks5.js";

function expectProxyError(action: () => unknown): ProxyError {
  try {
    action();
  } catch (error) {
    if (error instanceof ProxyError) return error;
    throw error;
  }
  throw new Error("expected a ProxyError to be thrown");
}

describe("socks5Greeting", () => {
  it("offers only no-auth when the proxy has no credentials", () => {
    const greeting = socks5Greeting({ type: "socks5", host: "proxy", port: 1080 });
    expect([...greeting]).toEqual([0x05, 0x01, 0x00]);
  });

  it("offers username/password alongside no-auth when credentials are configured", () => {
    const greeting = socks5Greeting({
      type: "socks5",
      host: "proxy",
      port: 1080,
      username: "u",
      password: "p",
    });
    expect([...greeting]).toEqual([0x05, 0x02, 0x00, 0x02]);
  });
});

describe("parseSocks5MethodSelection", () => {
  it("returns the selected method", () => {
    expect(parseSocks5MethodSelection(Buffer.from([0x05, 0x00]))).toBe(0x00);
    expect(parseSocks5MethodSelection(Buffer.from([0x05, 0x02]))).toBe(0x02);
  });

  it("refuses when the proxy replies with a non-SOCKS5 version", () => {
    const error = expectProxyError(() => parseSocks5MethodSelection(Buffer.from([0x04, 0x00])));
    expect(error.code).toBe("proxy_refused");
    expect(error.message).toContain("version 4");
  });

  it("fails authentication when the proxy has no acceptable method", () => {
    const error = expectProxyError(() => parseSocks5MethodSelection(Buffer.from([0x05, 0xff])));
    expect(error.code).toBe("proxy_auth_failed");
  });
});

describe("socks5UserPassRequest", () => {
  it("encodes RFC 1929 with single-byte length prefixes", () => {
    const request = socks5UserPassRequest({
      type: "socks5",
      host: "proxy",
      port: 1080,
      username: "jad",
      password: "secret",
    });
    expect([...request]).toEqual([
      0x01,
      0x03,
      ...Buffer.from("jad"),
      0x06,
      ...Buffer.from("secret"),
    ]);
  });

  it("refuses credentials longer than 255 bytes", () => {
    const error = expectProxyError(() =>
      socks5UserPassRequest({
        type: "socks5",
        host: "proxy",
        port: 1080,
        username: "x".repeat(256),
      }),
    );
    expect(error.code).toBe("proxy_refused");
  });
});

describe("parseSocks5UserPassStatus", () => {
  it("accepts status 0", () => {
    expect(() => parseSocks5UserPassStatus(Buffer.from([0x01, 0x00]))).not.toThrow();
  });

  it("fails authentication on non-zero status", () => {
    const error = expectProxyError(() => parseSocks5UserPassStatus(Buffer.from([0x01, 0x01])));
    expect(error.code).toBe("proxy_auth_failed");
    expect(error.message).toContain("status 1");
  });
});

describe("socks5ConnectRequest", () => {
  const targetPort = 0x1234;

  it("addresses an IPv4 literal with ATYP 1", () => {
    const request = socks5ConnectRequest({ host: "203.0.113.7", port: targetPort });
    expect([...request]).toEqual([0x05, 0x01, 0x00, 0x01, 203, 0, 113, 7, 0x12, 0x34]);
  });

  it("addresses an IPv6 literal with ATYP 4", () => {
    const request = socks5ConnectRequest({ host: "2001:db8::1", port: targetPort });
    expect([...request]).toEqual([
      0x05, 0x01, 0x00, 0x04, 0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x12,
      0x34,
    ]);
  });

  it("expands the IPv6 unspecified address", () => {
    const request = socks5ConnectRequest({ host: "::", port: targetPort });
    expect([...request.subarray(4, 20)]).toEqual(Array.from({ length: 16 }, () => 0));
  });

  it("renders IPv4-mapped IPv6 as the embedded octets", () => {
    const request = socks5ConnectRequest({ host: "::ffff:127.0.0.1", port: targetPort });
    expect([...request.subarray(4, 20)]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1,
    ]);
  });

  it("drops the interface zone from link-local IPv6 addresses", () => {
    const withZone = socks5ConnectRequest({ host: "fe80::1%en0", port: targetPort });
    const bare = socks5ConnectRequest({ host: "fe80::1", port: targetPort });
    expect([...withZone]).toEqual([...bare]);
  });

  it("treats an IPv6-shaped literal that is not a valid address as a domain target", () => {
    const request = socks5ConnectRequest({ host: "12345:::1", port: targetPort });
    expect([...request]).toEqual([
      0x05,
      0x01,
      0x00,
      0x03,
      9,
      ...Buffer.from("12345:::1"),
      0x12,
      0x34,
    ]);
  });

  it("addresses a hostname with ATYP 3 and a one-byte length", () => {
    const request = socks5ConnectRequest({ host: "example.test", port: targetPort });
    expect([...request]).toEqual([
      0x05,
      0x01,
      0x00,
      0x03,
      12,
      ...Buffer.from("example.test"),
      0x12,
      0x34,
    ]);
  });

  it("refuses a target longer than the 255-byte domain limit", () => {
    const error = expectProxyError(() =>
      socks5ConnectRequest({ host: `${"a".repeat(252)}.com`, port: 22 }),
    );
    expect(error.code).toBe("proxy_refused");
  });
});

describe("parseSocks5ReplyHead", () => {
  it("returns the bound address type on success", () => {
    const parsed = parseSocks5ReplyHead(Buffer.from([0x05, 0x00, 0x00, 0x01]));
    expect(parsed).toEqual({ replyCode: 0, addressType: 1 });
  });

  it("refuses when the proxy replies with a non-SOCKS5 version", () => {
    const error = expectProxyError(() => parseSocks5ReplyHead(Buffer.from([0x04, 0x00, 0, 1])));
    expect(error.code).toBe("proxy_refused");
  });

  const failures = [
    { replyCode: 0x01, code: "proxy_unreachable", reason: "general SOCKS server failure" },
    { replyCode: 0x02, code: "proxy_refused", reason: "connection not allowed by ruleset" },
    { replyCode: 0x03, code: "proxy_unreachable", reason: "network unreachable" },
    { replyCode: 0x04, code: "proxy_unreachable", reason: "host unreachable" },
    { replyCode: 0x05, code: "proxy_refused", reason: "connection refused by destination host" },
    { replyCode: 0x06, code: "proxy_unreachable", reason: "TTL expired" },
    { replyCode: 0x07, code: "proxy_refused", reason: "command not supported" },
    { replyCode: 0x08, code: "proxy_refused", reason: "address type not supported" },
  ] as const;

  it.each(failures)("maps reply $replyCode to $code ($reason)", ({ replyCode, code, reason }) => {
    const error = expectProxyError(() =>
      parseSocks5ReplyHead(Buffer.from([0x05, replyCode, 0x00, 0x01])),
    );
    expect(error.code).toBe(code);
    expect(error.message).toContain(reason);
  });

  it("refuses an unknown reply code", () => {
    const error = expectProxyError(() => parseSocks5ReplyHead(Buffer.from([0x05, 0x09, 0, 1])));
    expect(error.code).toBe("proxy_refused");
    expect(error.message).toContain("unknown reply code 9");
  });
});
