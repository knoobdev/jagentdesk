import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import { describe, expect, test } from "vitest";
import pino from "pino";
import { createTsnetListener, type TsnetListenerOptions } from "./tsnet-listener.js";

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill(signal?: string): boolean;
  exit(code: number): void;
}

function createFakeChild(): FakeChild {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as FakeChild;
  child.stdout = stdout;
  child.stderr = stderr;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.exit = (code: number) => {
    child.emit("exit", code, null);
  };
  return child;
}

function createListenerOptions(
  overrides: Partial<TsnetListenerOptions> = {},
): TsnetListenerOptions {
  return {
    logger: pino({ level: "silent" }),
    port: 6767,
    attachSocket: async () => {},
    ...overrides,
  };
}

function listenableOptions(
  bridgeBinary: string,
  attachSocket: TsnetListenerOptions["attachSocket"],
): TsnetListenerOptions {
  return createListenerOptions({
    bridgeBinary,
    attachSocket,
  });
}

describe("createTsnetListener", () => {
  test("fails when an explicitly configured bridge does not exist", async () => {
    const listener = createTsnetListener({
      logger: pino({ level: "silent" }),
      port: 6767,
      bridgeBinary: "/definitely/missing/jagentdesk-tailnet-bridge",
      attachSocket: async () => {},
    });

    expect(listener.kind).toBe("tsnet");
    expect(listener.getDirectAddress()).toBeNull();
    await expect(listener.start()).rejects.toThrow("Configured Tailscale bridge does not exist");
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  test("returns the configured address in serve mode when a tailnet host is set", () => {
    const listener = createTsnetListener({
      logger: pino({ level: "silent" }),
      port: 6767,
      tailnetHost: "myhost.tailnet.ts.net",
      allowExternalServe: true,
      attachSocket: async () => {},
    });

    expect(listener.getDirectAddress()).toEqual({
      host: "myhost.tailnet.ts.net",
      port: 6767,
    });

    const tlsListener = createTsnetListener({
      logger: pino({ level: "silent" }),
      port: 6767,
      tailnetHost: "myhost.tailnet.ts.net",
      useTls: true,
      allowExternalServe: true,
      attachSocket: async () => {},
    });
    expect(tlsListener.getDirectAddress()).toEqual({
      host: "myhost.tailnet.ts.net",
      port: 6767,
      useTls: true,
    });
  });

  test("returns null when the daemon has no TCP port", async () => {
    const listener = createTsnetListener({
      logger: pino({ level: "silent" }),
      port: 0,
      tailnetHost: "myhost.tailnet.ts.net",
      attachSocket: async () => {},
    });

    expect(listener.getDirectAddress()).toBeNull();
    await listener.start();
    await listener.stop();
  });

  test("start is idempotent and stop is safe", async () => {
    const listener = createTsnetListener({
      logger: pino({ level: "silent" }),
      port: 6767,
      tailnetHost: "myhost.tailnet.ts.net",
      allowExternalServe: true,
      attachSocket: async () => {},
    });

    await expect(listener.start()).resolves.toBeUndefined();
    await expect(listener.start()).resolves.toBeUndefined();
    await expect(listener.stop()).resolves.toBeUndefined();
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  test("spawns the bridge and advertises the TSNET_READY host", async () => {
    const child = createFakeChild();
    const spawned: Array<{ binary: string; args: string[] }> = [];
    const options = listenableOptions("/usr/bin/fake-tailnet-bridge", async () => {});
    options.spawnBridge = (binary, args) => {
      spawned.push({ binary, args });
      return child as unknown as ChildProcess;
    };

    const listener = createTsnetListener(options);
    await listener.start();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.binary).toBe("/usr/bin/fake-tailnet-bridge");
    expect(spawned[0]?.args).toContain("--tailnet-port");
    expect(spawned[0]?.args).toContain("6767");

    child.stdout.emit("data", Buffer.from("TSNET_READY myhost.tailnet.ts.net\n"));
    expect(listener.getDirectAddress()).toEqual({
      host: "myhost.tailnet.ts.net",
      port: 6767,
    });
    await listener.stop();
    expect(child.killed).toBe(true);
  });

  test("advertises the bridge host over a configured static host once ready", async () => {
    const child = createFakeChild();
    const options = listenableOptions("/usr/bin/fake-tailnet-bridge", async () => {});
    options.tailnetHost = "static.tailnet.ts.net";
    options.allowExternalServe = true;
    options.spawnBridge = () => child as unknown as ChildProcess;

    const listener = createTsnetListener(options);
    await listener.start();
    child.stdout.emit("data", Buffer.from("TSNET_READY live.tailnet.ts.net\n"));
    expect(listener.getDirectAddress()).toEqual({ host: "live.tailnet.ts.net", port: 6767 });
    await listener.stop();
  });

  test("clears the direct address when the bridge reports an error or exits", async () => {
    const child = createFakeChild();
    const options = listenableOptions("/usr/bin/fake-tailnet-bridge", async () => {});
    options.spawnBridge = () => child as unknown as ChildProcess;

    const listener = createTsnetListener(options);
    await listener.start();
    child.stdout.emit("data", Buffer.from("TSNET_READY myhost.tailnet.ts.net\n"));
    expect(listener.getDirectAddress()).toEqual({ host: "myhost.tailnet.ts.net", port: 6767 });

    child.stdout.emit("data", Buffer.from("TSNET_ERROR auth key rejected\n"));
    expect(listener.getDirectAddress()).toBeNull();

    child.exit(1);
    expect(listener.getDirectAddress()).toBeNull();
    await listener.stop();
  });

  test("closes the ingress when stopping so no new sockets attach", async () => {
    const child = createFakeChild();
    const options = listenableOptions("/usr/bin/fake-tailnet-bridge", async () => {});
    options.spawnBridge = () => child as unknown as ChildProcess;

    const listener = createTsnetListener(options);
    const startPromise = listener.start();
    child.stdout.emit("data", Buffer.from("TSNET_READY myhost.tailnet.ts.net\n"));
    await startPromise;
    await listener.stop();
    expect(child.killed).toBe(true);
  });

  test("connects a real WebSocket through the bridge's local-port ingress", async () => {
    const child = createFakeChild();
    let localPort = 0;
    const attached: Array<{ transport?: string; readyState: number }> = [];
    const options = listenableOptions("/usr/bin/fake-tailnet-bridge", async (ws, metadata) => {
      attached.push({ transport: metadata?.transport, readyState: ws.readyState });
    });
    options.spawnBridge = (binary, args) => {
      const localIndex = args.indexOf("--local-port");
      localPort = Number(args[localIndex + 1]);
      return child as unknown as ChildProcess;
    };

    const listener = createTsnetListener(options);
    const startPromise = listener.start();
    child.stdout.emit("data", Buffer.from("TSNET_READY myhost.tailnet.ts.net\n"));
    await startPromise;

    expect(localPort).toBeGreaterThan(0);
    const socket = new WebSocket(`ws://127.0.0.1:${localPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    socket.close();

    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ transport: "tailnet", readyState: 1 });
    await listener.stop();
  });
});
