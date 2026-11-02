import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLoopbackBindAddress } from "@jagentdesk/protocol/ssh/forwarding-schemas";
import { ForwardingRuleStore, normalizeRule } from "./rule-store.js";
import { SOCKS_REPLY, parseGreeting, parseRequest } from "./socks5.js";

describe("normalizeRule", () => {
  it("defaults the bind address to loopback and trims fields", () => {
    expect(
      normalizeRule({
        label: " db ",
        kind: "local",
        serverId: "srv_a1b2c3",
        bindPort: 15432,
        destHost: " db ",
        destPort: 5432,
      }),
    ).toEqual({
      label: "db",
      kind: "local",
      serverId: "srv_a1b2c3",
      bindAddress: "127.0.0.1",
      bindPort: 15432,
      destHost: "db",
      destPort: 5432,
    });
  });

  it("rejects local and remote rules without a destination", () => {
    expect(() =>
      normalizeRule({ label: "x", kind: "remote", serverId: "srv_a1b2c3", bindPort: 8080 }),
    ).toThrow(expect.objectContaining({ code: "invalid_rule" }));
  });

  it("drops destination fields from a dynamic rule", () => {
    expect(
      normalizeRule({
        label: "socks",
        kind: "dynamic",
        serverId: "srv_a1b2c3",
        bindPort: 1080,
        destHost: "ignored",
        destPort: 1,
      }),
    ).toEqual({
      label: "socks",
      kind: "dynamic",
      serverId: "srv_a1b2c3",
      bindAddress: "127.0.0.1",
      bindPort: 1080,
    });
  });

  it("treats only loopback addresses as local-only binds", () => {
    expect(isLoopbackBindAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackBindAddress("localhost")).toBe(true);
    expect(isLoopbackBindAddress("::1")).toBe(true);
    expect(isLoopbackBindAddress("0.0.0.0")).toBe(false);
    expect(isLoopbackBindAddress("192.168.1.20")).toBe(false);
  });
});

describe("ForwardingRuleStore", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "jad-fwd-store-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists rules to a 0600 forwarding.json and reloads them", async () => {
    const sshDir = path.join(dir, "ssh");
    const store = new ForwardingRuleStore(sshDir);
    const rule = {
      id: "fwd_a1b2c3",
      label: "db",
      kind: "local" as const,
      serverId: "srv_a1b2c3",
      bindAddress: "127.0.0.1",
      bindPort: 15432,
      destHost: "db",
      destPort: 5432,
      createdAtMs: 1,
      updatedAtMs: 2,
    };
    store.put(rule);

    const file = path.join(sshDir, "forwarding.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(sshDir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ rules: [rule] });

    const reloaded = new ForwardingRuleStore(sshDir);
    await reloaded.load();
    expect(reloaded.list()).toEqual([rule]);
  });
});

describe("SOCKS5 parsing", () => {
  it("waits for a complete greeting", () => {
    expect(parseGreeting(Buffer.from([0x05, 0x02, 0x00]))).toBeNull();
    expect(parseGreeting(Buffer.from([0x05, 0x02, 0x00, 0x02]))).toEqual({
      methods: [0, 2],
      length: 4,
    });
  });

  it("parses IPv4, domain and IPv6 CONNECT targets", () => {
    expect(parseRequest(Buffer.from([5, 1, 0, 1, 10, 0, 0, 7, 0x15, 0x38]))).toEqual({
      target: { host: "10.0.0.7", port: 5432 },
      length: 10,
    });
    const domain = Buffer.concat([
      Buffer.from([5, 1, 0, 3, 9]),
      Buffer.from("db.local."),
      Buffer.from([0x01, 0xbb]),
    ]);
    expect(parseRequest(domain)).toEqual({ target: { host: "db.local.", port: 443 }, length: 16 });
    const v6 = Buffer.concat([
      Buffer.from([5, 1, 0, 4]),
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
      Buffer.from([0, 80]),
    ]);
    expect(parseRequest(v6)?.target).toEqual({ host: "0:0:0:0:0:0:0:1", port: 80 });
    expect(parseRequest(domain.subarray(0, 10))).toBeNull();
  });

  it("refuses BIND and UDP ASSOCIATE", () => {
    expect(() => parseRequest(Buffer.from([5, 2, 0, 1, 1, 2, 3, 4, 0, 80]))).toThrow(
      expect.objectContaining({ reply: SOCKS_REPLY.commandNotSupported }),
    );
  });
});
