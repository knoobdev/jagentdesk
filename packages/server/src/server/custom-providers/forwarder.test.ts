import http from "node:http";
import net from "node:net";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import type { Client } from "ssh2";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { ProviderForwarder } from "./forwarder.js";
import { CustomProviderError } from "./types.js";

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function createHttpServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  return http.createServer(handler);
}

/** Minimal no-auth SOCKS5 server (RFC 1928) forwarding to the requested target. */
function createSocks5Server(): net.Server {
  return net.createServer((socket) => {
    let stage = 0;
    let remote: net.Socket | null = null;
    socket.on("error", () => {
      remote?.destroy();
      socket.destroy();
    });
    socket.on("data", (chunk: Buffer) => {
      if (stage === 0) {
        stage = 1;
        socket.write(Buffer.from([0x05, 0x00]));
        return;
      }
      if (stage !== 1) return;
      stage = 2;
      const atyp = chunk[3];
      let host: string;
      let port: number;
      let headerLength: number;
      if (atyp === 0x01) {
        host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`;
        port = chunk.readUInt16BE(8);
        headerLength = 10;
      } else if (atyp === 0x03) {
        host = chunk.subarray(5, 5 + chunk[4]).toString("utf8");
        port = chunk.readUInt16BE(5 + chunk[4]);
        headerLength = 7 + chunk[4];
      } else {
        socket.destroy();
        return;
      }
      const leftover = chunk.length > headerLength ? chunk.subarray(headerLength) : null;
      remote = net.connect(port, host, () => {
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        if (leftover) remote!.write(leftover);
        remote!.pipe(socket).pipe(remote!);
      });
      remote.on("error", () => socket.destroy());
    });
  });
}

/** ssh2 Client stub exposing only what the forwarder uses: forwardOut + close event. */
function createFakeSshClient(onForward: (host: string, port: number) => net.Socket) {
  const client = new EventEmitter() as EventEmitter & {
    forwardOut: Client["forwardOut"];
  };
  client.forwardOut = (_srcAddr, _srcPort, host, port, callback) => {
    const socket = onForward(host, port);
    socket.once("connect", () => callback(null, socket as never));
    socket.once("error", (error: Error) => callback(error, null));
  };
  return client as unknown as Client;
}

describe("ProviderForwarder", () => {
  test("tailnet route: connections are piped through the SOCKS5 loopback", async () => {
    const httpServer = createHttpServer((_req, res) => {
      res.end(JSON.stringify({ data: [{ id: "m1" }] }));
    });
    const httpPort = await listen(httpServer);
    const socksServer = createSocks5Server();
    const socksPort = await listen(socksServer);
    const forwarder = new ProviderForwarder({
      logger: createTestLogger(),
      getTailnetSocks: () => ({
        host: "127.0.0.1",
        port: socksPort,
        username: "tsnet",
        password: "rotating",
      }),
    });
    try {
      const effective = await forwarder.effectiveBaseUrl("p1", {
        baseUrl: `http://127.0.0.1:${httpPort}/v1`,
        via: "tailnet",
      });
      expect(effective).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      expect(effective).not.toBe(`http://127.0.0.1:${httpPort}/v1`);
      const response = await fetch(`${effective}/models`);
      expect(response.ok).toBe(true);
      // The same provider reuses the same listener.
      const again = await forwarder.effectiveBaseUrl("p1", {
        baseUrl: `http://127.0.0.1:${httpPort}/v1`,
        via: "tailnet",
      });
      expect(again).toBe(effective);
    } finally {
      forwarder.closeAll();
      httpServer.close();
      socksServer.close();
    }
  });

  test("tailnet route without a ready tailnet fails with tailnet_unavailable", async () => {
    const forwarder = new ProviderForwarder({
      logger: createTestLogger(),
      getTailnetSocks: () => null,
    });
    await expect(
      forwarder.effectiveBaseUrl("p1", { baseUrl: "http://100.64.0.1:11434/v1", via: "tailnet" }),
    ).rejects.toMatchObject({ code: "tailnet_unavailable" } satisfies CustomProviderError);
  });

  test("ssh route: connections become direct-tcpip channels over the lease client", async () => {
    const httpServer = createHttpServer((_req, res) => {
      res.end("ssh-ok");
    });
    const httpPort = await listen(httpServer);
    let acquireCount = 0;
    let releaseCount = 0;
    const client = createFakeSshClient((host, port) => net.connect(port, host));
    const forwarder = new ProviderForwarder({
      logger: createTestLogger(),
      getTailnetSocks: () => null,
      acquireSshClient: async (serverId) => {
        expect(serverId).toBe("srv-1");
        acquireCount += 1;
        return { client, release: () => (releaseCount += 1) };
      },
    });
    try {
      const effective = await forwarder.effectiveBaseUrl("p1", {
        baseUrl: `http://127.0.0.1:${httpPort}/v1`,
        via: "ssh",
        sshServerId: "srv-1",
      });
      expect(effective).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
      const response = await fetch(`${effective}/models`);
      expect(await response.text()).toBe("ssh-ok");
      expect(acquireCount).toBe(1);
      expect(releaseCount).toBe(0);
    } finally {
      forwarder.closeAll();
      httpServer.close();
    }
  });

  test("ssh route: a dropped SSH connection drops the listener so the next spawn re-acquires", async () => {
    const httpServer = createHttpServer((_req, res) => res.end("ok"));
    const httpPort = await listen(httpServer);
    let acquireCount = 0;
    const clients: Array<ReturnType<typeof createFakeSshClient>> = [];
    const forwarder = new ProviderForwarder({
      logger: createTestLogger(),
      getTailnetSocks: () => null,
      acquireSshClient: async () => {
        acquireCount += 1;
        const client = createFakeSshClient((host, port) => net.connect(port, host));
        clients.push(client);
        return { client, release: () => undefined };
      },
    });
    try {
      const first = await forwarder.effectiveBaseUrl("p1", {
        baseUrl: `http://127.0.0.1:${httpPort}/v1`,
        via: "ssh",
        sshServerId: "srv-1",
      });
      // Simulate the SSH connection dying: the listener must drop itself.
      (clients[0] as unknown as EventEmitter).emit("close");
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = await forwarder.effectiveBaseUrl("p1", {
        baseUrl: `http://127.0.0.1:${httpPort}/v1`,
        via: "ssh",
        sshServerId: "srv-1",
      });
      expect(acquireCount).toBe(2);
      expect(second).not.toBe(first);
    } finally {
      forwarder.closeAll();
      httpServer.close();
    }
  });

  test("ssh route: acquire failure surfaces as endpoint_unreachable", async () => {
    const forwarder = new ProviderForwarder({
      logger: createTestLogger(),
      getTailnetSocks: () => null,
      acquireSshClient: async () => {
        throw new Error("connection refused");
      },
    });
    await expect(
      forwarder.effectiveBaseUrl("p1", {
        baseUrl: "http://127.0.0.1:22/v1",
        via: "ssh",
        sshServerId: "srv-1",
      }),
    ).rejects.toMatchObject({ code: "endpoint_unreachable" } satisfies CustomProviderError);
  });

  test("ssh route without sshServerId fails with invalid_provider", async () => {
    const forwarder = new ProviderForwarder({
      logger: createTestLogger(),
      getTailnetSocks: () => null,
      acquireSshClient: async () => {
        throw new Error("should not be called");
      },
    });
    await expect(
      forwarder.effectiveBaseUrl("p1", { baseUrl: "http://127.0.0.1:22/v1", via: "ssh" }),
    ).rejects.toMatchObject({ code: "invalid_provider" } satisfies CustomProviderError);
  });
});
