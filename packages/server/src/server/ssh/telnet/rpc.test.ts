import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:net";
import type { Socket } from "node:net";
import { handleTelnetMessage, type TelnetResponseMessage } from "./rpc.js";
import { TelnetService } from "./service.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startEchoTelnetServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    // Sessions destroy their socket on kill; a write racing that close emits
    // EPIPE on the server side. Swallow it so teardown stays silent.
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      socket.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const info = server.address();
  if (!info || typeof info === "string") {
    throw new Error("echo server did not report an address");
  }
  return {
    port: info.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function collect(timeoutMs = 8_000): Promise<{
  responses: TelnetResponseMessage[];
  emit: (response: TelnetResponseMessage) => void;
  waitForCount: (count: number) => Promise<void>;
}> {
  const responses: TelnetResponseMessage[] = [];
  return {
    responses,
    emit: (response) => {
      responses.push(response);
    },
    waitForCount: async (count: number) => {
      const deadline = Date.now() + timeoutMs;
      while (responses.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${count} responses`);
        }
        await delay(10);
      }
    },
  };
}

describe("handleTelnetMessage", () => {
  it("returns false for messages it does not own", async () => {
    const service = new TelnetService();
    const { responses, emit } = await collect();
    const handled = await handleTelnetMessage(
      service,
      { type: "ssh.servers.list.request", requestId: "r1" },
      emit,
    );
    expect(handled).toBe(false);
    expect(responses).toEqual([]);
  });

  it("creates a session, registers it, and destroys it via paired responses", async () => {
    const server = await startEchoTelnetServer();
    const service = new TelnetService();
    try {
      const { responses, emit, waitForCount } = await collect();
      const handled = await handleTelnetMessage(
        service,
        {
          type: "ssh.telnet.session.create.request",
          requestId: "r1",
          address: "127.0.0.1",
          port: server.port,
        },
        emit,
      );
      expect(handled).toBe(true);
      await waitForCount(1);
      const created = responses[0];
      expect(created.type).toBe("ssh.telnet.session.create.response");
      if (created.type !== "ssh.telnet.session.create.response") {
        throw new Error("unexpected response type");
      }
      expect(created.payload.requestId).toBe("r1");
      expect(created.payload.error).toBeNull();
      expect(created.payload.terminalId).toBeTruthy();

      const terminalId = created.payload.terminalId!;
      expect(service.getSession(terminalId)).toBeDefined();

      await handleTelnetMessage(
        service,
        { type: "ssh.telnet.session.destroy.request", requestId: "r2", terminalId },
        emit,
      );
      await waitForCount(2);
      const destroyed = responses[1];
      expect(destroyed.type).toBe("ssh.telnet.session.destroy.response");
      if (destroyed.type !== "ssh.telnet.session.destroy.response") {
        throw new Error("unexpected response type");
      }
      expect(destroyed.payload).toEqual({ requestId: "r2", error: null });
      expect(service.getSession(terminalId)).toBeUndefined();

      await handleTelnetMessage(
        service,
        { type: "ssh.telnet.session.destroy.request", requestId: "r3", terminalId },
        emit,
      );
      await waitForCount(3);
      const again = responses[2];
      expect(again.type).toBe("ssh.telnet.session.destroy.response");
      if (again.type !== "ssh.telnet.session.destroy.response") {
        throw new Error("unexpected response type");
      }
      expect(again.payload.error).toContain("unknown telnet session");
    } finally {
      await service.dispose();
      await server.close();
    }
  });

  it("rejects a create request with an empty address without throwing", async () => {
    const service = new TelnetService();
    const { responses, emit, waitForCount } = await collect();
    const handled = await handleTelnetMessage(
      service,
      { type: "ssh.telnet.session.create.request", requestId: "r1", address: "" },
      emit,
    );
    expect(handled).toBe(true);
    await waitForCount(1);
    const response = responses[0];
    expect(response.type).toBe("ssh.telnet.session.create.response");
    if (response.type !== "ssh.telnet.session.create.response") {
      throw new Error("unexpected response type");
    }
    expect(response.payload.terminalId).toBeNull();
    expect(response.payload.error).toBeTypeOf("string");
  });

  it("reports the connect failure when the port is closed", async () => {
    const server = await startEchoTelnetServer();
    const port = server.port;
    await server.close();
    const service = new TelnetService();
    const { responses, emit, waitForCount } = await collect();
    await handleTelnetMessage(
      service,
      { type: "ssh.telnet.session.create.request", requestId: "r1", address: "127.0.0.1", port },
      emit,
    );
    await waitForCount(1);
    const response = responses[0];
    if (response.type !== "ssh.telnet.session.create.response") {
      throw new Error("unexpected response type");
    }
    expect(response.payload.terminalId).toBeNull();
    expect(response.payload.error).toContain("Telnet connection to");
    await service.dispose();
  });
});
