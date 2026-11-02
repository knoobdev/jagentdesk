import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Client } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ForwardingOutboundMessage,
  SshForwardStateEvent,
} from "@jagentdesk/protocol/ssh/forwarding-schemas";
import { createTestSshPool, type TestSshPool } from "../test-support/test-sshd.js";
import { handleForwardingMessage } from "./rpc.js";
import { ForwardingService } from "./service.js";

// Integration tests against the real sshd from ../test-support/start-test-sshd.sh. Inside the
// container sshd itself listens on 127.0.0.1:2222, which gives every forward a real destination.

const execFileAsync = promisify(execFile);

function exec(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let out = "";
      stream.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      stream.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      stream.on("close", () => resolve(out.trim()));
    });
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function readFirstLine(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      const newline = data.indexOf("\n");
      if (newline >= 0) {
        socket.destroy();
        resolve(data.slice(0, newline).trim());
      }
    });
    socket.on("error", reject);
  });
}

function socksBanner(proxyPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let stage = 0;
    let data = Buffer.alloc(0);
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (stage === 0 && data.length >= 2) {
        data = data.subarray(2);
        stage = 1;
        const host = Buffer.from("localhost");
        socket.write(
          Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0x08, 0xae])]),
        );
      }
      if (stage === 1 && data.length >= 10) {
        if (data[1] !== 0) reject(new Error(`SOCKS reply ${data[1]}`));
        data = data.subarray(10);
        stage = 2;
      }
      const text = data.toString("utf8");
      if (stage === 2 && text.includes("\n")) {
        socket.destroy();
        resolve(text.slice(0, text.indexOf("\n")).trim());
      }
    });
    socket.on("error", reject);
  });
}

describe("ForwardingService against a real sshd", () => {
  let pool: TestSshPool;
  let shell: Client;
  let sshDir: string;
  let service: ForwardingService;
  const events: SshForwardStateEvent[] = [];

  beforeAll(async () => {
    pool = createTestSshPool();
    shell = (await pool.acquire("shell")).client;
    sshDir = await mkdtemp(path.join(os.tmpdir(), "jad-fwd-home-"));
    service = new ForwardingService({ acquire: pool.acquire, sshDir });
    await service.initialize();
    service.subscribe((event) => events.push(event));
  });

  afterAll(async () => {
    await service.dispose();
    pool.close();
    await rm(sshDir, { recursive: true, force: true });
  });

  it("local: a daemon port reaches a service on the server, and a busy port is port_in_use", async () => {
    const port = await freePort();
    const rule = await service.save({
      label: "sshd on the server",
      kind: "local",
      serverId: "srv_a",
      bindPort: port,
      destHost: "127.0.0.1",
      destPort: 2222,
    });
    const state = await service.start(rule.id);
    expect(state).toMatchObject({ ruleId: rule.id, status: "active", boundPort: port });
    expect(await readFirstLine(port)).toMatch(/^SSH-2\.0-OpenSSH/);
    expect(events.map((e) => e.state.status)).toEqual(
      expect.arrayContaining(["starting", "active"]),
    );

    const busy = await service.save({
      label: "same port",
      kind: "local",
      serverId: "srv_a",
      bindPort: port,
      destHost: "127.0.0.1",
      destPort: 2222,
    });
    const failed = await service.start(busy.id);
    expect(failed).toMatchObject({
      status: "error",
      error: { code: "port_in_use", message: `Port ${port} on 127.0.0.1 is already in use` },
    });
    expect(failed.boundPort).toBeUndefined();

    expect((await service.stop(rule.id)).status).toBe("stopped");
    await expect(readFirstLine(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("remote: a port on the server reaches a service on the daemon machine", async () => {
    const daemonSide = net.createServer((socket) => socket.end("pong from daemon\n"));
    await new Promise<void>((resolve) => daemonSide.listen(0, "127.0.0.1", resolve));
    const { port: daemonPort } = daemonSide.address() as net.AddressInfo;
    const remotePort = 20000 + (process.pid % 20000);
    const rule = await service.save({
      label: "callback",
      kind: "remote",
      serverId: "srv_a",
      bindPort: remotePort,
      destHost: "127.0.0.1",
      destPort: daemonPort,
    });
    expect(await service.start(rule.id)).toMatchObject({ status: "active", boundPort: remotePort });

    expect(await exec(shell, `nc -w 5 127.0.0.1 ${remotePort} </dev/null`)).toBe(
      "pong from daemon",
    );

    await service.stop(rule.id);
    expect(await exec(shell, `nc -z -w 2 127.0.0.1 ${remotePort}; echo $?`)).toBe("1");
    await new Promise<void>((resolve) => daemonSide.close(() => resolve()));
  });

  it("dynamic: SOCKS5 connects through the server, including curl --socks5-hostname", async () => {
    const port = await freePort();
    const rule = await service.save({
      label: "socks",
      kind: "dynamic",
      serverId: "srv_a",
      bindPort: port,
    });
    expect((await service.start(rule.id)).status).toBe("active");
    expect(await socksBanner(port)).toMatch(/^SSH-2\.0-OpenSSH/);

    const httpPort = 30000 + (process.pid % 20000);
    await exec(
      shell,
      `nohup sh -c "printf 'HTTP/1.0 200 OK\\r\\nContent-Length: 13\\r\\n\\r\\nfrom the box\\n' | nc -l 127.0.0.1 ${httpPort}" >/dev/null 2>&1 &`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { stdout } = await execFileAsync("curl", [
      "-s",
      "--max-time",
      "10",
      "--socks5-hostname",
      `127.0.0.1:${port}`,
      `http://127.0.0.1:${httpPort}/`,
    ]);
    expect(stdout).toBe("from the box\n");
    await service.stop(rule.id);
  });

  it("starts a server's attached rules on connect and reports connection_lost when it drops", async () => {
    const lossPool = createTestSshPool();
    const lossService = new ForwardingService({ acquire: lossPool.acquire, sshDir });
    await lossService.initialize();
    const port = await freePort();
    const attached = await lossService.save({
      label: "attached",
      kind: "local",
      serverId: "srv_b",
      bindPort: port,
      destHost: "127.0.0.1",
      destPort: 2222,
    });
    const other = await lossService.save({
      label: "other server",
      kind: "local",
      serverId: "srv_c",
      bindPort: await freePort(),
      destHost: "127.0.0.1",
      destPort: 2222,
    });

    const started = await lossService.startForServer("srv_b", [attached.id, other.id]);
    expect(started.map((s) => [s.ruleId, s.status])).toEqual([[attached.id, "active"]]);

    const lost = new Promise<SshForwardStateEvent>((resolve) =>
      lossService.subscribe((event) => {
        if (event.state.ruleId === attached.id && event.state.status === "error") resolve(event);
      }),
    );
    (await lossPool.acquire("srv_b")).client.end();
    expect((await lost).state.error?.code).toBe("connection_lost");
    await expect(readFirstLine(port)).rejects.toMatchObject({ code: "ECONNREFUSED" });

    await lossService.dispose();
    lossPool.close();
  });

  it("serves the RPCs with persisted rules", async () => {
    const out: ForwardingOutboundMessage[] = [];
    await handleForwardingMessage(
      service,
      { type: "ssh.forward.list.request", requestId: "req_1" } as { type: string },
      (message) => out.push(message),
    );
    const list = out[0];
    expect(list.type).toBe("ssh.forward.list.response");
    if (list.type !== "ssh.forward.list.response") return;
    expect(list.payload.rules.map((r) => r.label)).toEqual(
      expect.arrayContaining(["sshd on the server", "callback", "socks"]),
    );

    out.length = 0;
    await handleForwardingMessage(
      service,
      {
        type: "ssh.forward.save.request",
        requestId: "req_2",
        rule: { label: "bad", kind: "local", serverId: "srv_a", bindPort: 1 },
      } as { type: string },
      (message) => out.push(message),
    );
    expect(out).toEqual([
      {
        type: "ssh.forward.save.response",
        payload: {
          requestId: "req_2",
          error: {
            code: "invalid_rule",
            message: "Local and remote rules need a destination host and port",
          },
          rule: null,
        },
      },
    ]);
  });
});
