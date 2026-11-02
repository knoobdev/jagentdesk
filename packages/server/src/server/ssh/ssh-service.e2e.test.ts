import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Client } from "ssh2";
import type { SessionOutboundMessage } from "../messages.js";
import { captureTerminalLines } from "../../terminal/terminal-capture.js";
import { SshService } from "./ssh-service.js";

// Real-sshd integration test for SSH S1 + S4 (spec 25.3, 25.16 #1–#3, #7, #8, #14).
// Opt-in: JAD_SSH_E2E=1 with the containers from the S1 brief running:
//   docker run -d --name jad-sshd -p 2222:2222 -e PASSWORD_ACCESS=true -e USER_NAME=jad \
//     -e USER_PASSWORD=jadtest lscr.io/linuxserver/openssh-server
// plus jad-sshd-hop2 (network jad-ssh-net + jad-ssh-inner) and jad-sshd-target
// (jad-ssh-inner only), AllowTcpForwarding yes and `AcceptEnv JAD_*` on all three.

const E2E = process.env.JAD_SSH_E2E === "1";
const HOST = "127.0.0.1";
const PORT = 2222;
const USER = "jad";
const PASSWORD = "jadtest";
const KEY_PASSPHRASE = "e2e-key-passphrase-7731";

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

function hostKeyFile(keyType: string): string {
  if (keyType === "ssh-ed25519") return "ssh_host_ed25519_key.pub";
  if (keyType.startsWith("ecdsa-")) return "ssh_host_ecdsa_key.pub";
  return "ssh_host_rsa_key.pub";
}

function serverFingerprint(container: string, keyType: string): string {
  // `ssh-keygen -lf` prints "<bits> SHA256:<fp> <comment> (<TYPE>)".
  const out = docker(
    "exec",
    container,
    "ssh-keygen",
    "-lf",
    `/config/ssh_host_keys/${hostKeyFile(keyType)}`,
  );
  return out.split(/\s+/)[1];
}

async function waitFor<T>(
  probe: () => T | undefined | null | false,
  timeoutMs = 30_000,
  label = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function execOnClient(client: Client, command: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (d: Buffer) => chunks.push(d));
      stream.on("close", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
    });
  });
}

function relay(socket: net.Socket, host: string, port: number, onOpen: () => void): void {
  const upstream = net.connect(port, host, () => {
    onOpen();
    upstream.pipe(socket).pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
}

/** Minimal HTTP CONNECT proxy that records each tunnel request. */
function startHttpConnectProxy(seen: string[]): Promise<http.Server> {
  const proxy = http.createServer();
  proxy.on("connect", (req, clientSocket: net.Socket, head: Buffer) => {
    seen.push(`http ${req.url} ${req.headers["proxy-authorization"] ?? ""}`);
    const [host, port] = String(req.url).split(":");
    relay(clientSocket, host, Number(port), () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      clientSocket.unshift(head);
    });
  });
  return new Promise((resolve) => proxy.listen(0, HOST, () => resolve(proxy)));
}

function socksRequest(socket: net.Socket, seen: string[], request: Buffer): void {
  const host = request.subarray(4, 8).join(".");
  const port = request.readUInt16BE(8);
  seen.push(`socks ${host}:${port}`);
  relay(socket, host, port, () => socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])));
}

function socksAuth(socket: net.Socket, seen: string[], auth: Buffer): void {
  const userLength = auth[1];
  const user = auth.subarray(2, 2 + userLength).toString();
  const passLength = auth[2 + userLength];
  const pass = auth.subarray(3 + userLength, 3 + userLength + passLength).toString();
  seen.push(`socks-auth ${user}:${pass}`);
  socket.write(Buffer.from([1, 0]));
  socket.once("data", (request: Buffer) => socksRequest(socket, seen, request));
}

/** Minimal SOCKS5 proxy (IPv4 CONNECT, optional username/password) recording requests. */
function startSocks5Proxy(seen: string[]): Promise<net.Server> {
  const proxy = net.createServer((socket) => {
    socket.once("data", (greeting: Buffer) => {
      const wantsAuth = greeting.subarray(2).includes(2);
      socket.write(Buffer.from([5, wantsAuth ? 2 : 0]));
      if (wantsAuth) socket.once("data", (auth: Buffer) => socksAuth(socket, seen, auth));
      else socket.once("data", (request: Buffer) => socksRequest(socket, seen, request));
    });
  });
  return new Promise((resolve) => proxy.listen(0, HOST, () => resolve(proxy)));
}

function keygenAlgo(file: string): string {
  if (file.includes("ed25519")) return "ed25519";
  if (file.includes("ecdsa")) return "ecdsa";
  return "rsa";
}

async function probeBanner(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(PORT, HOST);
    socket.once("data", (data) => {
      socket.destroy();
      resolve(data.toString().startsWith("SSH-"));
    });
    socket.once("error", () => resolve(false));
    setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);
  });
}
async function waitForPort(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await probeBanner()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("sshd did not come back");
}

describe.skipIf(!E2E)("SshService against a real sshd", () => {
  let home: string;
  let service: SshService;
  const pushes: SessionOutboundMessage[] = [];
  let logText = "";

  const pushesOf = <T extends SessionOutboundMessage["type"]>(type: T) =>
    pushes.filter((m): m is Extract<SessionOutboundMessage, { type: T }> => m.type === type);
  const nextPush = async <T extends SessionOutboundMessage["type"]>(
    type: T,
    match: (m: Extract<SessionOutboundMessage, { type: T }>) => boolean,
    timeoutMs = 30_000,
  ) => waitFor(() => pushesOf(type).find(match), timeoutMs, type);

  const screen = (terminalId: string): string => {
    const session = service.getSshTerminalSession(terminalId);
    if (!session) return "";
    return captureTerminalLines(session, { start: 0 }).lines.join("\n");
  };
  const terminalState = (terminalId: string) =>
    service.listSessions().find((s) => s.terminalId === terminalId)?.state;
  const answerHostKeys = (serverId: string, count: number) =>
    (async () => {
      const answered = new Set<string>();
      while (answered.size < count) {
        const prompt = await nextPush(
          "ssh.hostkey.prompt",
          (p) => p.serverId === serverId && !answered.has(p.promptId),
        );
        answered.add(prompt.promptId);
        service.respondHostKey(prompt.promptId, "accept");
      }
    })();
  const run = async (
    terminalId: string,
    command: string,
    expectText: string,
    timeoutMs = 15_000,
  ) => {
    service.getSshTerminalSession(terminalId)!.typeInput(`${command}\r`);
    await waitFor(() => screen(terminalId).includes(expectText), timeoutMs, `output ${expectText}`);
  };
  const saveServer = (fields: Parameters<SshService["saveServer"]>[0], password?: string) =>
    service.saveServer(fields, password ? { password } : {});

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "jad-ssh-e2e-"));
    const logSink = new Writable({
      write(chunk, _enc, cb) {
        logText += chunk.toString();
        cb();
      },
    });
    service = new SshService({
      jagentdeskHome: home,
      logger: pino({ level: "trace" }, logSink),
      broadcast: (message) => pushes.push(message),
      idleCloseMs: 300,
      reconnectDelayMs: () => 1000,
    });
    await service.initialize();
    await waitForPort();
  });

  // Each test only looks at the pushes it caused.
  beforeEach(() => {
    pushes.length = 0;
  });

  afterAll(async () => {
    service?.dispose();
    if (home) await rm(home, { recursive: true, force: true });
  });

  let passwordServerId = "";
  let mainTerminal = "";
  let firstKeyType = "";

  it("password server: secrets stay in the store; first connect asks host key; reject stores nothing", async () => {
    const info = await saveServer(
      { id: "", label: "e2e", address: HOST, port: PORT, username: USER },
      PASSWORD,
    );
    passwordServerId = info.id;
    expect(JSON.stringify(await service.getServerInfo(info.id))).not.toContain(PASSWORD);
    await service.storage.flush();
    expect(await readFile(path.join(home, "ssh", "servers.json"), "utf8")).not.toContain(PASSWORD);
    expect(await service.storage.secrets.get(`ssh.password.${info.id}`)).toBe(PASSWORD);

    const rejected = service.createSession(info.id, { cols: 100, rows: 30 });
    const prompt = await nextPush("ssh.hostkey.prompt", (p) => p.serverId === info.id);
    firstKeyType = prompt.keyType;
    expect(prompt.fingerprintSha256).toBe(serverFingerprint("jad-sshd", prompt.keyType));
    expect(prompt.expiresAtMs - Date.now()).toBeGreaterThan(110_000);
    expect(terminalState(rejected)).toBe("awaiting_hostkey");
    service.respondHostKey(prompt.promptId, "reject");
    const failed = await nextPush(
      "ssh.connection.state",
      (m) => m.terminalId === rejected && m.state === "error",
    );
    expect(failed.error?.code).toBe("host_key_rejected");
    expect(service.storage.listKnownHosts()).toEqual([]);
    await service.storage.flush();
    const knownHostsFile = await readFile(path.join(home, "ssh", "known_hosts.json"), "utf8").catch(
      () => "[]",
    );
    expect(JSON.parse(knownHostsFile)).toEqual([]);
    service.getSshTerminal(rejected)!.kill();
  });

  it("accepting the host key opens an xterm-256color shell without a workspace", async () => {
    mainTerminal = service.createSession(passwordServerId, { cols: 100, rows: 30 });
    await answerHostKeys(passwordServerId, 1);
    await nextPush(
      "ssh.connection.state",
      (m) => m.terminalId === mainTerminal && m.state === "connected",
    );
    expect(service.getSshTerminal(mainTerminal)!.workspaceId).toBe("");
    await run(mainTerminal, "echo TERM=$TERM JAD_$((40+2))", "TERM=xterm-256color JAD_42");
    expect(service.storage.listKnownHosts().map((h) => [h.host, h.port, h.keyType])).toEqual([
      [HOST, PORT, firstKeyType],
    ]);
  });

  it("acquireClient shares one authenticated client per server with ref-counted leases", async () => {
    const a = await service.acquireClient(passwordServerId);
    const b = await service.acquireClient(passwordServerId);
    expect(a.client).toBe(b.client);
    expect(await execOnClient(a.client, "echo lease-ok")).toBe("lease-ok");
    a.release();
    b.release();
    a.release(); // idempotent
    expect(service.isConnected(passwordServerId)).toBe(true); // the terminal still holds a lease
  });

  it("password prompt is relayed when no password is stored", async () => {
    const info = await saveServer({
      id: "",
      label: "ask",
      address: HOST,
      port: PORT,
      username: USER,
      authMethods: ["password"],
    });
    const terminalId = service.createSession(info.id, { cols: 80, rows: 24 });
    const prompt = await nextPush("ssh.auth.prompt", (p) => p.serverId === info.id);
    expect([prompt.kind, prompt.prompts]).toEqual([
      "password",
      [{ prompt: `${USER}@${HOST}'s password:`, echo: false }],
    ]);
    expect(terminalState(terminalId)).toBe("awaiting_auth");
    service.respondAuth(prompt.promptId, [PASSWORD]);
    await nextPush(
      "ssh.connection.state",
      (m) => m.terminalId === terminalId && m.state === "connected",
    );
    service.getSshTerminal(terminalId)!.kill();
  });

  it("env vars and the startup snippet apply when the shell opens", async () => {
    await writeFile(
      path.join(home, "ssh", "snippets.json"),
      JSON.stringify([{ id: "snp_startup", label: "startup", script: "echo STARTUP_$((1+1))" }]),
    );
    const info = await saveServer(
      {
        id: "",
        label: "env",
        address: HOST,
        port: PORT,
        username: USER,
        env: { JAD_E2E_VAR: "env-value-ok" },
        startupSnippetId: "snp_startup",
      },
      PASSWORD,
    );
    const terminalId = service.createSession(info.id, { cols: 100, rows: 30 });
    await waitFor(() => screen(terminalId).includes("STARTUP_2"), 20_000, "startup snippet");
    await run(terminalId, "echo VAR=$JAD_E2E_VAR", "VAR=env-value-ok");
    service.getSshTerminal(terminalId)!.kill();
  });

  it("Ed25519 key with passphrase: keys.json holds only public data; key auth + daemon agent forwarding work", async () => {
    const key = await service.generateKey({
      label: "e2e-key",
      type: "ed25519",
      passphrase: KEY_PASSPHRASE,
    });
    await service.storage.flush();
    const keysJson = await readFile(path.join(home, "ssh", "keys.json"), "utf8");
    expect(keysJson).not.toContain("PRIVATE KEY");
    expect(keysJson).not.toContain(KEY_PASSPHRASE);
    expect(JSON.parse(keysJson)).toEqual([key]);

    // Install the public key with a lease (S6 owns ssh.keys.install_to_server).
    const lease = await service.acquireClient(passwordServerId);
    await execOnClient(
      lease.client,
      `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${key.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
    );
    lease.release();

    const identity = await service.saveIdentity({
      id: "",
      label: "key-identity",
      username: USER,
      keyId: key.id,
    });
    const info = await saveServer({
      id: "",
      label: "key",
      address: HOST,
      port: PORT,
      identityId: identity.id,
      authMethods: ["key"],
      agentForwarding: true,
    });
    const terminalId = service.createSession(info.id, { cols: 120, rows: 30 });
    await nextPush(
      "ssh.connection.state",
      (m) => m.terminalId === terminalId && m.state === "connected",
    );
    // The forwarded agent is the daemon's own and holds exactly the identity key.
    await run(terminalId, "ssh-add -l", key.fingerprintSha256);
    service.getSshTerminal(terminalId)!.kill();
  });

  it("connects through HTTP CONNECT and SOCKS5 proxies", async () => {
    const seen: string[] = [];
    const httpProxy = await startHttpConnectProxy(seen);
    const socks = await startSocks5Proxy(seen);
    try {
      const httpPort = (httpProxy.address() as net.AddressInfo).port;
      const socksPort = (socks.address() as net.AddressInfo).port;
      const viaHttp = await service.saveServer(
        {
          id: "",
          label: "via-http",
          address: HOST,
          port: PORT,
          username: USER,
          proxy: { type: "http", host: HOST, port: httpPort, username: "pu" },
        },
        { password: PASSWORD, proxyPassword: "proxy-pw" },
      );
      const viaSocks = await service.saveServer(
        {
          id: "",
          label: "via-socks",
          address: HOST,
          port: PORT,
          username: USER,
          proxy: { type: "socks5", host: HOST, port: socksPort, username: "su" },
        },
        { password: PASSWORD, proxyPassword: "socks-pw" },
      );
      for (const id of [viaHttp.id, viaSocks.id]) {
        const lease = await service.acquireClient(id);
        lease.release();
      }
      expect(seen).toEqual([
        `http ${HOST}:${PORT} Basic ${Buffer.from("pu:proxy-pw").toString("base64")}`,
        "socks-auth su:socks-pw",
        `socks ${HOST}:${PORT}`,
      ]);
    } finally {
      httpProxy.close();
      socks.close();
    }
  });

  it("jump chain of 2 hops reaches a server only visible from hop 2; each new hop asks its host key", async () => {
    const hop2 = await saveServer(
      { id: "", label: "hop2", address: "jad-sshd-hop2", port: 2222, username: USER },
      PASSWORD,
    );
    const target = await saveServer(
      {
        id: "",
        label: "target",
        address: "jad-sshd-target",
        port: 2222,
        username: USER,
        jumpChain: [passwordServerId, hop2.id],
      },
      PASSWORD,
    );
    const terminalId = service.createSession(target.id, { cols: 100, rows: 30 });
    // hop 0 (127.0.0.1:2222) is already trusted; hop 1 and the target each prompt.
    const first = await nextPush("ssh.hostkey.prompt", (p) => p.serverId === target.id);
    expect([first.address, first.hopIndex, first.hopCount]).toEqual(["jad-sshd-hop2", 1, 3]);
    expect(first.fingerprintSha256).toBe(serverFingerprint("jad-sshd-hop2", first.keyType));
    service.respondHostKey(first.promptId, "accept");
    const second = await nextPush(
      "ssh.hostkey.prompt",
      (p) => p.serverId === target.id && p.promptId !== first.promptId,
    );
    expect([second.address, second.hopIndex]).toEqual(["jad-sshd-target", 2]);
    expect(second.fingerprintSha256).toBe(serverFingerprint("jad-sshd-target", second.keyType));
    service.respondHostKey(second.promptId, "accept");
    await nextPush(
      "ssh.connection.state",
      (m) => m.terminalId === terminalId && m.state === "connected",
    );
    const targetHostname = docker("inspect", "-f", "{{.Config.Hostname}}", "jad-sshd-target");
    await run(terminalId, "echo HOST=$(hostname)", `HOST=${targetHostname}`);
    service.getSshTerminal(terminalId)!.kill();
  });

  it("auto-reconnects in the same tab after the server drops, keeping screen history", async () => {
    await run(mainTerminal, "echo BEFORE_DROP_$((7*6))", "BEFORE_DROP_42");
    pushes.length = 0;
    docker("restart", "-t", "1", "jad-sshd");
    await nextPush(
      "ssh.connection.state",
      (m) => m.terminalId === mainTerminal && m.state === "reconnecting",
      30_000,
    );
    await waitForPort();
    await nextPush(
      "ssh.connection.state",
      (m) => m.terminalId === mainTerminal && m.state === "connected",
      90_000,
    );
    expect(screen(mainTerminal)).toContain("BEFORE_DROP_42");
    await run(mainTerminal, "echo AFTER_DROP_$((8*8))", "AFTER_DROP_64");
  }, 150_000);

  it("a changed host key blocks with host_key_mismatch and both fingerprints; replace restores trust", async () => {
    const oldFingerprint = serverFingerprint("jad-sshd", firstKeyType);
    const file = hostKeyFile(firstKeyType).replace(/\.pub$/, "");
    const algo = keygenAlgo(file);
    service.getSshTerminal(mainTerminal)!.kill();
    docker(
      "exec",
      "jad-sshd",
      "sh",
      "-c",
      `rm -f /config/ssh_host_keys/${file} /config/ssh_host_keys/${file}.pub && ssh-keygen -q -t ${algo} -N '' -f /config/ssh_host_keys/${file}`,
    );
    docker("restart", "-t", "1", "jad-sshd");
    await waitForPort();
    const newFingerprint = serverFingerprint("jad-sshd", firstKeyType);
    expect(newFingerprint).not.toBe(oldFingerprint);
    await waitFor(() => !service.isConnected(passwordServerId), 10_000, "old connection gone");

    const terminalId = service.createSession(passwordServerId, { cols: 220, rows: 24 });
    const blocked = await nextPush(
      "ssh.connection.state",
      (m) => m.terminalId === terminalId && m.state === "error",
    );
    expect(blocked.error).toMatchObject({
      code: "host_key_mismatch",
      storedFingerprint: oldFingerprint,
      receivedFingerprint: newFingerprint,
    });
    expect(screen(terminalId)).toContain(newFingerprint);

    const pub = docker("exec", "jad-sshd", "cat", `/config/ssh_host_keys/${file}.pub`).split(/\s+/);
    service.replaceKnownHost({ host: HOST, port: PORT, keyType: pub[0], publicKey: pub[1] });
    service.reconnectSession(terminalId);
    await nextPush(
      "ssh.connection.state",
      (m) => m.terminalId === terminalId && m.state === "connected",
    );
    service.getSshTerminal(terminalId)!.kill();
  }, 120_000);

  it("daemon logs and plain JSON files never contain a password, passphrase or private key", async () => {
    await service.storage.flush();
    const sshDir = path.join(home, "ssh");
    const jsonFiles = (await readdir(sshDir)).filter(
      (f) => f.endsWith(".json") && f !== "secrets.json",
    );
    const json = (
      await Promise.all(jsonFiles.map((f) => readFile(path.join(sshDir, f), "utf8")))
    ).join("\n");
    for (const haystack of [logText, json]) {
      expect(haystack).not.toContain(PASSWORD);
      expect(haystack).not.toContain(KEY_PASSPHRASE);
      expect(haystack).not.toContain("proxy-pw");
      expect(haystack).not.toContain("PRIVATE KEY");
    }
    expect(logText).toContain("ssh connected");
  });
});

export type { Client };
