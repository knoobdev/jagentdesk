import { describe, expect, it } from "vitest";
import { ProxyError } from "./proxy-error.js";
import { httpConnectRequest, parseHttpConnectResponse, targetAuthority } from "./http-connect.js";

function expectProxyError(action: () => unknown): ProxyError {
  try {
    action();
  } catch (error) {
    if (error instanceof ProxyError) return error;
    throw error;
  }
  throw new Error("expected a ProxyError to be thrown");
}

describe("httpConnectRequest", () => {
  it("sends CONNECT with request-target and Host headers, terminated by a blank line", () => {
    const request = httpConnectRequest(
      { type: "http", host: "proxy", port: 3128 },
      { host: "target.example", port: 2222 },
    );
    expect(request).toBe(
      "CONNECT target.example:2222 HTTP/1.1\r\nHost: target.example:2222\r\n\r\n",
    );
  });

  it("brackets IPv6 authorities", () => {
    expect(targetAuthority({ host: "::1", port: 22 })).toBe("[::1]:22");
    expect(targetAuthority({ host: "2001:db8::1", port: 22 })).toBe("[2001:db8::1]:22");
    expect(targetAuthority({ host: "example.test", port: 22 })).toBe("example.test:22");
  });

  it("omits Proxy-Authorization when no credentials are configured", () => {
    const request = httpConnectRequest(
      { type: "http", host: "proxy", port: 3128 },
      { host: "h", port: 22 },
    );
    expect(request).not.toContain("Proxy-Authorization");
  });

  it("sends Proxy-Authorization Basic with the UTF-8 user:password token", () => {
    const request = httpConnectRequest(
      { type: "http", host: "proxy", port: 3128, username: "jad", password: "päss" },
      { host: "h", port: 22 },
    );
    const expected = Buffer.from("jad:päss", "utf8").toString("base64");
    expect(request).toContain(`Proxy-Authorization: Basic ${expected}\r\n`);
  });

  it("sends Basic credentials as soon as either username or password is present", () => {
    const request = httpConnectRequest(
      { type: "http", host: "proxy", port: 3128, username: "jad" },
      { host: "h", port: 22 },
    );
    expect(request).toContain("Proxy-Authorization: Basic ");
  });
});

describe("parseHttpConnectResponse", () => {
  it("accepts an HTTP/1.1 200 head", () => {
    expect(() =>
      parseHttpConnectResponse("HTTP/1.1 200 Connection established\r\nProxy-agent: tinyproxy"),
    ).not.toThrow();
  });

  it("accepts any 2xx status", () => {
    expect(() => parseHttpConnectResponse("HTTP/1.0 204 No Content")).not.toThrow();
  });

  it("reports proxy_auth_failed for 407", () => {
    const error = expectProxyError(() =>
      parseHttpConnectResponse("HTTP/1.0 407 Proxy Authentication Required"),
    );
    expect(error.code).toBe("proxy_auth_failed");
    expect(error.message).toContain("407");
  });

  it("reports proxy_refused for other 4xx statuses", () => {
    expect(expectProxyError(() => parseHttpConnectResponse("HTTP/1.1 403 Forbidden")).code).toBe(
      "proxy_refused",
    );
    expect(expectProxyError(() => parseHttpConnectResponse("HTTP/1.1 400 Bad Request")).code).toBe(
      "proxy_refused",
    );
  });

  it("reports proxy_unreachable for 5xx statuses", () => {
    expect(expectProxyError(() => parseHttpConnectResponse("HTTP/1.1 502 Bad Gateway")).code).toBe(
      "proxy_unreachable",
    );
    expect(
      expectProxyError(() => parseHttpConnectResponse("HTTP/1.1 500 Internal Server Error")).code,
    ).toBe("proxy_unreachable");
  });

  it("refuses a head without a parseable status line", () => {
    const error = expectProxyError(() => parseHttpConnectResponse("Socks is not an HTTP proxy"));
    expect(error.code).toBe("proxy_refused");
    expect(error.message).toContain("invalid HTTP CONNECT response");
  });

  it("refuses an HTTP/0.9-style head with no status code", () => {
    const error = expectProxyError(() => parseHttpConnectResponse("HTTP/1.1 abc Bad Request"));
    expect(error.code).toBe("proxy_refused");
  });
});
