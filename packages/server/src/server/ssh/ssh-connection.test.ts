import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server, utils } from "ssh2";
import type { AuthContext, Connection, Session } from "ssh2";
import type { SessionOutboundMessage } from "../messages.js";
import { SshService } from "./ssh-service.js";

// Connect-flow behaviors the docker sshd cannot exercise (spec 25.3 step 4): an
// in-process ssh2 server speaks the real SSH protocol and asks keyboard-interactive
// questions (an OTP after the password), like a 2FA-enabled server.

const HOST_KEY = utils.generateKeyPairSync("ed25519").private;
const OTP = "246810";

function askTwoFactor(ctx: AuthContext, answersSeen: string[][]): void {
  if (ctx.method !== "keyboard-interactive") {
    ctx.reject(["keyboard-interactive"]);
    return;
  }
  ctx.prompt(
    [
      { prompt: "Password: ", echo: false },
      { prompt: "One-time code: ", echo: true },
    ],
    "Two-factor login",
    (answers) => {
      answersSeen.push(answers);
      if (answers[0] === "kbd-password" && answers[1] === OTP) ctx.accept();
      else ctx.reject();
    },
  );
}

function serveShell(accept: () => Session): void {
  const session = accept();
  session.on("pty", (acceptPty) => acceptPty?.());
  session.on("shell", (acceptShell) => acceptShell().write("kbd-shell-ready\r\n"));
}

function serveTwoFactorClient(client: Connection, answersSeen: string[][]): void {
  client.on("authentication", (ctx) => askTwoFactor(ctx, answersSeen));
  client.on("ready", () => client.on("session", (accept) => serveShell(accept)));
  client.on("error", () => undefined);
}

function firstOfType<T extends SessionOutboundMessage["type"]>(
  pushes: SessionOutboundMessage[],
  type: T,
): Extract<SessionOutboundMessage, { type: T }> | undefined {
  return pushes.find((m): m is Extract<SessionOutboundMessage, { type: T }> => m.type === type);
}

async function until<T>(probe: () => T | undefined): Promise<T> {
  for (let i = 0; i < 200; i += 1) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}

describe("SSH connect flow against an in-process SSH server", () => {
  let server: Server;
  let port = 0;
  let home = "";
  const answersSeen: string[][] = [];

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "jad-ssh-kbd-"));
    server = new Server({ hostKeys: [HOST_KEY] }, (client) =>
      serveTwoFactorClient(client, answersSeen),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.close();
    await rm(home, { recursive: true, force: true });
  });

  it("relays every keyboard-interactive question and connects with the answers", async () => {
    const pushes: SessionOutboundMessage[] = [];
    const service = new SshService({ jagentdeskHome: home, broadcast: (m) => pushes.push(m) });
    await service.initialize();
    const saved = await service.saveServer({
      id: "",
      label: "2fa",
      address: "127.0.0.1",
      port,
      username: "otp-user",
      authMethods: ["keyboard-interactive"],
    });
    const terminalId = service.createSession(saved.id, { cols: 80, rows: 24 });
    const hostPrompt = await until(() => firstOfType(pushes, "ssh.hostkey.prompt"));
    service.respondHostKey(hostPrompt.promptId, "accept");
    const prompt = await until(() => firstOfType(pushes, "ssh.auth.prompt"));
    expect({
      kind: prompt.kind,
      instructions: prompt.instructions,
      prompts: prompt.prompts,
    }).toEqual({
      kind: "keyboard_interactive",
      instructions: "Two-factor login",
      prompts: [
        { prompt: "Password: ", echo: false },
        { prompt: "One-time code: ", echo: true },
      ],
    });
    expect(service.listSessions()[0].state).toBe("awaiting_auth");
    expect(() => service.respondAuth(prompt.promptId, ["only-one"])).toThrow(
      "Answer count does not match the prompt.",
    );
    service.respondAuth(prompt.promptId, ["kbd-password", OTP]);
    await until(() => (service.listSessions()[0]?.state === "connected" ? true : undefined));
    expect(answersSeen).toEqual([["kbd-password", OTP]]);
    expect(pushes).toContainEqual({ type: "ssh.prompt.resolved", promptId: prompt.promptId });
    expect(service.getSshTerminal(terminalId)).toBeDefined();
    service.dispose();
  });

  it("an unanswered host-key prompt expires and the connect fails with host_key_timeout", async () => {
    const pushes: SessionOutboundMessage[] = [];
    const service = new SshService({
      jagentdeskHome: await mkdtemp(path.join(os.tmpdir(), "jad-ssh-timeout-")),
      broadcast: (m) => pushes.push(m),
      hostKeyTimeoutMs: 300,
    });
    await service.initialize();
    const saved = await service.saveServer({
      id: "",
      label: "t",
      address: "127.0.0.1",
      port,
      username: "u",
    });
    await expect(service.acquireClient(saved.id)).rejects.toMatchObject({
      info: { code: "host_key_timeout", message: "Host key confirmation timed out." },
    });
    expect(service.storage.listKnownHosts()).toEqual([]);
    const prompt = pushes.find((m) => m.type === "ssh.hostkey.prompt") as { promptId: string };
    expect(pushes).toContainEqual({ type: "ssh.prompt.resolved", promptId: prompt.promptId });
    service.dispose();
  });
});
