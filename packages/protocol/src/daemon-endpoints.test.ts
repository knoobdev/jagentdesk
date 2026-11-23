import { buildRelayWebSocketUrl } from "./daemon-endpoints.js";
import { describe, expect, test } from "vitest";

import {
  buildDaemonWebSocketUrl,
  parseConnectionUri,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
} from "./daemon-endpoints.js";

describe("connection URI parsing", () => {
  test("round-trips a tcp host and port", () => {
    const parsed = parseConnectionUri("tcp://localhost:6767");

    expect(parsed).toEqual({
      host: "localhost",
      port: 6767,
      isIpv6: false,
      useTls: false,
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://localhost:6767");
  });

  test("round-trips an SSL-enabled tcp host and port", () => {
    const parsed = parseConnectionUri("tcp://example.com:443?ssl=true");

    expect(parsed).toEqual({
      host: "example.com",
      port: 443,
      isIpv6: false,
      useTls: true,
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://example.com:443?ssl=true");
  });

  test("round-trips an IPv6 host", () => {
    const parsed = parseConnectionUri("tcp://[::1]:6767?ssl=true");

    expect(parsed).toEqual({
      host: "::1",
      port: 6767,
      isIpv6: true,
      useTls: true,
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://[::1]:6767?ssl=true");
  });

  test("rejects a missing port", () => {
    expect(() => parseConnectionUri("tcp://localhost")).toThrow("Connection URI port is required");
  });

  test("rejects an invalid scheme", () => {
    expect(() => parseConnectionUri("http://localhost:6767")).toThrow(
      "Connection URI protocol must be tcp:",
    );
  });

  test("parses password without including it in the public serializer", () => {
    const parsed = parseConnectionUri("tcp://localhost:6767?ssl=true&password=secret");

    expect(parsed).toEqual({
      host: "localhost",
      port: 6767,
      isIpv6: false,
      useTls: true,
      password: "secret",
    });
    expect(serializeConnectionUri(parsed)).toBe("tcp://localhost:6767?ssl=true");
    expect(serializeConnectionUriForStorage(parsed)).toBe(
      "tcp://localhost:6767?ssl=true&password=secret",
    );
  });

  test("rejects userinfo passwords", () => {
    expect(() => parseConnectionUri("tcp://:secret@localhost:6767?ssl=true")).toThrow(
      "Connection URI userinfo is not supported",
    );
  });
});

describe("daemon websocket URLs", () => {
  test("uses ws for port 443 when TLS is disabled", () => {
    expect(buildDaemonWebSocketUrl("example.com:443", { useTls: false })).toBe(
      "ws://example.com:443/ws",
    );
  });

  test("uses wss for non-443 ports when TLS is enabled", () => {
    expect(buildDaemonWebSocketUrl("example.com:6767", { useTls: true })).toBe(
      "wss://example.com:6767/ws",
    );
  });
});

describe("relay websocket URLs", () => {
  test("routes bare hosted endpoints over TLS using protocol v2", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "desk-relay.jagents.workers.dev",
        useTls: true,
        serverId: "srv_1",
        role: "client",
      }),
    );
    expect(url.origin).toBe("wss://desk-relay.jagents.workers.dev");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      serverId: "srv_1",
      role: "client",
      v: "2",
    });
  });
  test("routes data sockets to an explicit local relay port", () => {
    const url = new URL(
      buildRelayWebSocketUrl({
        endpoint: "[::1]:12345",
        useTls: false,
        serverId: "srv_1",
        role: "server",
        connectionId: "client_1",
      }),
    );
    expect(url.origin).toBe("ws://[::1]:12345");
    expect(url.searchParams.get("connectionId")).toBe("client_1");
  });
});
