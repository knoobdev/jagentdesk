import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client, utils, type ClientChannel } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_SSHD, createTestSshPool, type TestSshPool } from "../test-support/test-sshd.js";
import { KeyInstallService } from "./install-key.js";
import { SessionLogService } from "./session-log.js";

// Against the real sshd from ../test-support/start-test-sshd.sh.

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

function connectWithKey(privateKey: string, passphrase: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect({
      host: TEST_SSHD.host,
      port: TEST_SSHD.port,
      username: TEST_SSHD.username,
      privateKey,
      passphrase,
      tryKeyboard: false,
      readyTimeout: 15_000,
    });
  });
}

function openShell(client: Client): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.shell({ term: "xterm-256color", cols: 120, rows: 30 }, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

function waitForOutput(stream: ClientChannel, marker: string): Promise<void> {
  return new Promise((resolve) => {
    let seen = "";
    const onData = (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (seen.includes(marker)) {
        stream.off("data", onData);
        resolve();
      }
    };
    stream.on("data", onData);
  });
}

// Opt-in: needs the test sshd container (see test-support/start-test-sshd.sh) and JAD_SSH_E2E=1.
describe.runIf(process.env.JAD_SSH_E2E === "1")("S6 against a real sshd", () => {
  let pool: TestSshPool;
  let shell: Client;
  let original: string;

  beforeAll(async () => {
    pool = createTestSshPool();
    shell = (await pool.acquire("shell")).client;
    original = await exec(shell, "cat ~/.ssh/authorized_keys 2>/dev/null; true");
    await exec(shell, "rm -f ~/.ssh/authorized_keys");
  });

  afterAll(async () => {
    await exec(
      shell,
      `printf '%s' '${original.replaceAll("'", "'\\''")}' > ~/.ssh/authorized_keys`,
    );
    pool.close();
  });

  it("installs an Ed25519 key once (700/600), attaches it, and key auth then works", async () => {
    const passphrase = "correct horse battery";
    const pair = utils.generateKeyPairSync("ed25519", {
      passphrase,
      cipher: "aes256-ctr",
      comment: "jagentdesk-test",
    });
    const attached: Array<[string, string]> = [];
    const keys = new KeyInstallService({
      acquire: pool.acquire,
      getPublicKey: async (keyId) => (keyId === "key_a1b2c3" ? pair.public : null),
      attachKey: async (serverId, keyId) => {
        attached.push([serverId, keyId]);
      },
    });
    // An existing file without a trailing newline must not get the key glued onto its last line.
    await exec(
      shell,
      "mkdir -p ~/.ssh && printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl other' > ~/.ssh/authorized_keys && chmod 644 ~/.ssh/authorized_keys",
    );

    expect(await keys.install("srv_a", "key_a1b2c3")).toEqual({
      outcome: "installed",
      path: ".ssh/authorized_keys",
    });
    expect(await keys.install("srv_a", "key_a1b2c3")).toEqual({
      outcome: "already_present",
      path: ".ssh/authorized_keys",
    });

    const lines = (await exec(shell, "cat ~/.ssh/authorized_keys")).split("\n");
    expect(lines).toEqual([
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl other",
      pair.public.trim(),
    ]);
    expect(await exec(shell, "stat -c %a ~/.ssh ~/.ssh/authorized_keys")).toBe("700\n600");
    expect(attached).toEqual([
      ["srv_a", "key_a1b2c3"],
      ["srv_a", "key_a1b2c3"],
    ]);

    const keyClient = await connectWithKey(pair.private, passphrase);
    expect(await exec(keyClient, "whoami")).toBe(TEST_SSHD.username);
    keyClient.end();
    expect(pool.heldLeases()).toBe(1);
  });

  it("records a real shell session without what was typed while echo was off", async () => {
    const sshHome = await mkdtemp(path.join(os.tmpdir(), "jad-logs-sshd-"));
    const logs = new SessionLogService({ sshHome, now: Date.now });
    await logs.setEnabled("srv_a", true);
    const recorder = await logs.startRecording("srv_a");
    if (!recorder) throw new Error("recording did not start");
    const stream = await openShell(shell);
    stream.on("data", (chunk: Buffer) => recorder.write(chunk.toString("utf8")));

    stream.write(
      "printf 'Secret: '; stty -echo; read -r s; stty echo; echo; echo got-${#s}-chars\n",
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    stream.write("hunter2-secret\n");
    await waitForOutput(stream, "got-14-chars");
    stream.write("exit\n");
    await new Promise<void>((resolve) => stream.once("close", () => resolve()));
    await recorder.close();

    const { text } = await logs.read({ kind: "recent", serverId: "srv_a" });
    expect(text).toContain("got-14-chars");
    expect(text).not.toContain("hunter2-secret");
    expect(text).not.toContain(String.fromCharCode(27));
    expect(
      (await logs.search({ kind: "recent", serverId: "srv_a" }, "got-14")).matches,
    ).toHaveLength(1);
    await rm(sshHome, { recursive: true, force: true });
  });
});
