import { mkdtemp, rm } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server, utils } from "ssh2";
import type { AuthContext, Connection, Session } from "ssh2";
import type { SessionOutboundMessage } from "../messages.js";
import { SshService, type SshTerminalCreatedEvent } from "./ssh-service.js";
import { createTelnetTerminalSession } from "./telnet/terminal-session.js";

// Tab-level behaviours of spec 25.4 against real protocol servers in-process:
// broadcast input, the mobile Password key, the output activity push, and Telnet tabs
// feeding the same hooks (activity + command-history taps) as SSH tabs.

const HOST_KEY = utils.generateKeyPairSync("ed25519").private;
const PASSWORD = "tab-feature-pass-4417";

interface ShellLog {
  user: string;
  received: string;
}

function acceptPassword(ctx: AuthContext): void {
  if (ctx.method === "password" && ctx.password === PASSWORD) ctx.accept();
  else ctx.reject(["password"]);
}

function serveShell(accept: () => Session, log: ShellLog): void {
  const session = accept();
  session.on("pty", (acceptPty) => acceptPty?.());
  session.on("shell", (acceptShell) => {
    const stream = acceptShell();
    stream.write("ready> ");
    stream.on("data", (data: Buffer) => {
      log.received += data.toString("utf8");
    });
  });
}

function serveClient(client: Connection, logs: ShellLog[]): void {
  let user = "";
  client.on("authentication", (ctx) => {
    user = ctx.username;
    acceptPassword(ctx);
  });
  client.on("ready", () => {
    const log: ShellLog = { user, received: "" };
    logs.push(log);
    client.on("session", (accept) => serveShell(accept, log));
  });
  client.on("error", () => undefined);
}

function serveTelnet(socket: net.Socket, received: string[]): void {
  socket.write("telnet-login: ");
  socket.on("data", (data) => {
    received.push(data.toString("latin1"));
    socket.write("ok\r\n");
  });
}

function recordAndTrust(
  message: SessionOutboundMessage,
  pushes: SessionOutboundMessage[],
  service: () => SshService,
): void {
  pushes.push(message);
  if (message.type === "ssh.hostkey.prompt") {
    queueMicrotask(() => service().respondHostKey(message.promptId, "accept"));
  }
}

function logOf(logs: ShellLog[], user: string): ShellLog | undefined {
  return logs.find((log) => log.user === user);
}

function activityFor(pushes: SessionOutboundMessage[], terminalId: string) {
  return pushes.filter((m) => m.type === "ssh.session.activity" && m.terminalId === terminalId);
}

function appendTo(list: string[]): (data: string) => void {
  return (data) => list.push(data);
}

async function until<T>(probe: () => T | undefined | false, label: string): Promise<T> {
  for (let i = 0; i < 300; i += 1) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${label}`);
}

describe("SSH tab features against in-process servers", () => {
  let sshd: Server;
  let telnetd: net.Server;
  let port = 0;
  let telnetPort = 0;
  let home = "";
  const logs: ShellLog[] = [];
  const telnetReceived: string[] = [];
  const pushes: SessionOutboundMessage[] = [];
  let service: SshService;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "jad-ssh-tabs-"));
    sshd = new Server({ hostKeys: [HOST_KEY] }, (client) => serveClient(client, logs));
    await new Promise<void>((resolve) => sshd.listen(0, "127.0.0.1", resolve));
    port = (sshd.address() as AddressInfo).port;
    // A Telnet server that sends a login banner and records what it receives.
    telnetd = net.createServer((socket) => serveTelnet(socket, telnetReceived));
    await new Promise<void>((resolve) => telnetd.listen(0, "127.0.0.1", resolve));
    telnetPort = (telnetd.address() as AddressInfo).port;
    // Host keys are trusted automatically here: TOFU itself is covered elsewhere.
    service = new SshService({
      jagentdeskHome: home,
      broadcast: (m) => recordAndTrust(m, pushes, () => service),
    });
    await service.initialize();
    service.registerSessionFactory("telnet", (input) =>
      createTelnetTerminalSession({
        id: input.terminalId,
        address: input.host,
        port: input.port,
        cols: input.size.cols,
        rows: input.size.rows,
        name: input.label,
      }),
    );
  });

  afterAll(async () => {
    service.dispose();
    sshd.close();
    telnetd.close();
    await rm(home, { recursive: true, force: true });
  });

  async function openTab(username: string): Promise<string> {
    const saved = await service.saveServer(
      { id: "", label: username, address: "127.0.0.1", port, username, authMethods: ["password"] },
      { password: PASSWORD },
    );
    const terminalId = service.createSession(saved.id, { cols: 80, rows: 24 });
    await until(
      () => service.listSessions().find((s) => s.terminalId === terminalId)?.state === "connected",
      "connected",
    );
    return terminalId;
  }

  it("broadcast mirrors one tab's keystrokes into every tab of the group, and stops when off", async () => {
    const a = await openTab("tab-a");
    const b = await openTab("tab-b");
    const c = await openTab("tab-c");
    const logOfUser = (user: string) => logOf(logs, user)!;
    service.setBroadcast([a, b, c]);
    service.getSshTerminal(a)!.send({ type: "input", data: "uptime\r" });
    await until(() => logOfUser("tab-c").received.includes("uptime\r"), "broadcast to c");
    expect([
      logOfUser("tab-a").received,
      logOfUser("tab-b").received,
      logOfUser("tab-c").received,
    ]).toEqual(["uptime\r", "uptime\r", "uptime\r"]);
    // Turning broadcast off for a: b and c no longer get a's keystrokes.
    service.setBroadcast([a], false);
    service.getSshTerminal(a)!.send({ type: "input", data: "ls\r" });
    await until(() => logOfUser("tab-a").received.endsWith("ls\r"), "local input");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(logOfUser("tab-b").received).toBe("uptime\r");
  });

  it("the Password key types the saved password into the tab; no push carries it", async () => {
    const terminalId = await openTab("tab-pw");
    await service.typePassword(terminalId);
    await until(() => logOf(logs, "tab-pw")?.received === PASSWORD, "password typed");
    expect(JSON.stringify(pushes)).not.toContain(PASSWORD);
  });

  it("pushes ssh.session.activity when output arrives, at most once per second per tab", async () => {
    const terminalId = await openTab("tab-activity");
    const activityPushes = () => activityFor(pushes, terminalId);
    await until(() => activityPushes().length > 0, "activity push");
    // More output right away is coalesced into the next push, not sent at once.
    service.getSshTerminalSession(terminalId)!.pushRemoteOutput("more output\r\n");
    service.getSshTerminalSession(terminalId)!.pushRemoteOutput("and more\r\n");
    expect(activityPushes()).toHaveLength(1);
    await until(() => activityPushes().length === 2, "coalesced push");
    expect(JSON.stringify(activityPushes())).not.toContain("more output");
  });

  it("a Telnet tab gets the same taps (history) and activity pushes as an SSH tab", async () => {
    const created: SshTerminalCreatedEvent[] = [];
    const typed: string[] = [];
    const unsubscribe = service.subscribeTerminalCreated((event) => {
      created.push(event);
      event.session.tapInput(appendTo(typed));
    });
    const saved = await service.saveServer({
      id: "",
      label: "switch",
      address: "127.0.0.1",
      port: telnetPort,
      protocol: "telnet",
    });
    const terminalId = await service.openSession(saved.id, { cols: 80, rows: 24 });
    service.getSshTerminal(terminalId)!.send({ type: "input", data: "show version\r" });
    await until(() => telnetReceived.join("").includes("show version"), "telnet input");
    expect(created.map((event) => [event.terminalId, event.serverId])).toEqual([
      [terminalId, saved.id],
    ]);
    expect(typed).toEqual(["show version\r"]);
    await until(() => activityFor(pushes, terminalId).length > 0, "telnet activity push");
    expect(service.listSessions().find((s) => s.terminalId === terminalId)?.state).toBe(
      "connected",
    );
    unsubscribe();
  });
});
