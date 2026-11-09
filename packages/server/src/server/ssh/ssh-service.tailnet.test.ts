import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SSH_CONNECT_STEPS, SshConnectionError } from "./ssh-connection.js";
import type { ProxyTarget } from "./proxy-socket.js";
import { SshService } from "./ssh-service.js";

// Spec 33.2 / ADR-0044 decision 2: a `via: "tailnet"` server dials the first hop's
// TCP socket through the daemon's tsnet loopback SOCKS5 (accessor), never directly,
// and fails fast with `tailnet_unavailable` when the tailnet is down.

const dirs: string[] = [];
async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jad-ssh-tailnet-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Minimal RFC 1928/1929 SOCKS5 server: records the auth pair, then drops the tunnel. */
function startSocks5Server(
  onAuth: (username: string, password: string) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      let stage = 0;
      socket.on("data", (chunk: Buffer) => {
        if (stage === 0) {
          // Method selection: require username/password auth.
          socket.write(Buffer.from([0x05, 0x02]));
          stage = 1;
          return;
        }
        if (stage === 1) {
          const userLength = chunk[1];
          const username = chunk.subarray(2, 2 + userLength).toString("utf8");
          const passLength = chunk[2 + userLength];
          const password = chunk
            .subarray(3 + userLength, 3 + userLength + passLength)
            .toString("utf8");
          onAuth(username, password);
          socket.write(Buffer.from([0x01, 0x00]));
          stage = 2;
          return;
        }
        // CONNECT request: succeed, then end the tunnel so the SSH handshake
        // fails fast — this test asserts routing, not a real SSH server.
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x1f, 0x90]));
        stage = 3;
        setTimeout(() => socket.end(), 25);
      });
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

/** TCP server that counts direct dials (a fallback would connect to it). */
function startRecorderServer(): Promise<{
  port: number;
  connections(): number;
  close(): Promise<void>;
}> {
  return new Promise((resolve) => {
    let count = 0;
    const server = net.createServer((socket) => {
      count += 1;
      socket.destroy();
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        connections: () => count,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function spyOpenProxySocket() {
  return vi.fn(
    (proxy: ProxyTarget, host: string, port: number): Promise<Duplex> =>
      DEFAULT_SSH_CONNECT_STEPS.openProxySocket(proxy, host, port),
  );
}

describe("SshService via tailnet (spec 33.2)", () => {
  it("dials the first hop through the tailnet SOCKS5 accessor, never directly", async () => {
    const recorder = await startRecorderServer();
    const auths: Array<{ username: string; password: string }> = [];
    const socks = await startSocks5Server((username, password) =>
      auths.push({ username, password }),
    );
    const openProxySocket = spyOpenProxySocket();
    const service = new SshService({
      jagentdeskHome: await home(),
      connectSteps: { openProxySocket },
      tailnetSocks: () => ({
        host: "127.0.0.1",
        port: socks.port,
        username: "tsnet",
        password: "tailnet-socks-pass",
      }),
    });
    await service.initialize();
    const server = await service.saveServer({
      id: "",
      label: "wsl",
      address: "127.0.0.1",
      port: recorder.port,
      username: "jad",
      via: "tailnet",
    });

    await expect(service.acquireClient(server.id)).rejects.toBeInstanceOf(SshConnectionError);

    // The proxy step carried the tsnet SOCKS5 credential; the target itself was
    // never dialed directly.
    expect(openProxySocket).toHaveBeenCalledTimes(1);
    expect(openProxySocket.mock.calls[0]?.[0]).toEqual({
      type: "socks5",
      host: "127.0.0.1",
      port: socks.port,
      username: "tsnet",
      password: "tailnet-socks-pass",
    });
    expect(auths).toEqual([{ username: "tsnet", password: "tailnet-socks-pass" }]);
    expect(recorder.connections()).toBe(0);

    await socks.close();
    await recorder.close();
  });

  it("fails with tailnet_unavailable and dials nothing when the accessor is null", async () => {
    const recorder = await startRecorderServer();
    const openProxySocket = spyOpenProxySocket();
    const service = new SshService({
      jagentdeskHome: await home(),
      connectSteps: { openProxySocket },
    });
    await service.initialize();
    const server = await service.saveServer({
      id: "",
      label: "wsl",
      address: "127.0.0.1",
      port: recorder.port,
      username: "jad",
      via: "tailnet",
    });

    await expect(service.acquireClient(server.id)).rejects.toMatchObject({
      info: {
        code: "tailnet_unavailable",
        message: "JAgentDesk Tailscale is not connected on this host.",
      },
    });
    expect(openProxySocket).not.toHaveBeenCalled();
    expect(recorder.connections()).toBe(0);

    await recorder.close();
  });

  it("re-reads the accessor on every connect attempt", async () => {
    const recorder = await startRecorderServer();
    const socks = await startSocks5Server(() => undefined);
    let accessorPort: number | null = null;
    const openProxySocket = spyOpenProxySocket();
    const service = new SshService({
      jagentdeskHome: await home(),
      connectSteps: { openProxySocket },
      tailnetSocks: () =>
        accessorPort === null
          ? null
          : { host: "127.0.0.1", port: accessorPort, username: "tsnet", password: "p" },
    });
    await service.initialize();
    const server = await service.saveServer({
      id: "",
      label: "wsl",
      address: "127.0.0.1",
      port: recorder.port,
      username: "jad",
      via: "tailnet",
    });

    await expect(service.acquireClient(server.id)).rejects.toMatchObject({
      info: { code: "tailnet_unavailable" },
    });
    // The bridge comes up between attempts: the next connect uses it (25.3 step 6).
    accessorPort = socks.port;
    await expect(service.acquireClient(server.id)).rejects.toBeInstanceOf(SshConnectionError);
    expect(openProxySocket).toHaveBeenCalledTimes(1);
    expect(openProxySocket.mock.calls[0]?.[0]).toMatchObject({ port: socks.port });

    await socks.close();
    await recorder.close();
  });
});
