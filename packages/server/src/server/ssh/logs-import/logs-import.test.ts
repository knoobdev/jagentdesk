import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LogsImportOutboundMessage } from "@jagentdesk/protocol/ssh/logs-import-schemas";
import { parseServersCsv } from "./csv.js";
import {
  SshImporter,
  type SshImportExistingKey,
  type SshImportExistingServer,
  type SshImportKnownHost,
  type SshImportServerInput,
  type SshImportSink,
} from "./importer.js";
import {
  assertPublicKeyLine,
  installPath,
  installScript,
  KeyInstallService,
} from "./install-key.js";
import { handleLogsImportMessage } from "./rpc.js";
import { SessionLogService } from "./session-log.js";
import { TerminalTextCleaner } from "./terminal-text.js";

const ESC = String.fromCharCode(27);

// In-memory stand-in for S1 storage behind the importer's sink contract.
function createMemorySink(existing: SshImportExistingServer[] = []) {
  const servers: Array<SshImportServerInput & { id: string }> = [];
  const groups = new Map<string, string>();
  const knownHosts: SshImportKnownHost[] = [];
  const keys: SshImportExistingKey[] = [];
  let next = 0;
  const sink: SshImportSink = {
    async listServers() {
      return [...existing, ...servers];
    },
    async ensureGroup(groupPath) {
      const key = groupPath.join("/");
      if (!groups.has(key)) groups.set(key, `grp_${(next += 1)}`);
      return groups.get(key) ?? "";
    },
    async saveServer(server) {
      const id = `srv_${(next += 1)}`;
      servers.push({ ...server, id });
      return id;
    },
    async listKnownHosts() {
      return knownHosts;
    },
    async addKnownHost(entry) {
      knownHosts.push(entry);
    },
    async listKeys() {
      return keys;
    },
    async importKey() {
      const id = `key_${(next += 1)}`;
      return id;
    },
  };
  return { sink, servers, groups };
}

describe("terminal text cleaner", () => {
  it("drops colours, titles and cursor moves, even when split across chunks", () => {
    const cleaner = new TerminalTextCleaner();
    const out =
      cleaner.push(`${ESC}]0;user@box: ~${String.fromCharCode(7)}${ESC}[01;32muser@box${ESC}[0`) +
      cleaner.push(`m:~$ ls\r\nREADME.md\r\n`) +
      cleaner.flush();
    expect(out).toBe("user@box:~$ ls\nREADME.md\n");
  });
});

describe("import (spec 25.9, criterion 13)", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "jad-import-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const config = [
    "Host bastion",
    "  HostName bastion.example.internal",
    "  User ops",
    "",
    "Host app",
    "  HostName 10.0.0.12",
    "  Port 2200",
    "  User deploy",
    "  ProxyJump bastion",
    "",
    "Host legacy",
    "  HostName 10.0.0.30",
    "  ProxyCommand nc -X 5 -x proxy:1080 %h %p",
    "",
    "Host *.corp",
    "  User me",
  ].join("\n");

  it("turns ProxyJump into a jump chain and reports ProxyCommand as ignored", async () => {
    const { sink, servers } = createMemorySink();
    const importer = new SshImporter({ sink, userHome: home });

    const preview = await importer.preview({ kind: "ssh_config", text: config });
    expect(preview.servers.map((s) => [s.alias, s.address, s.status])).toEqual([
      ["bastion", "bastion.example.internal", "new"],
      ["app", "10.0.0.12", "new"],
      ["legacy", "10.0.0.30", "new"],
    ]);
    expect(preview.issues.map((issue) => [issue.code, issue.severity])).toEqual(
      expect.arrayContaining([
        ["proxy_command", "skipped"],
        ["wildcard_host", "skipped"],
      ]),
    );

    const result = await importer.apply({
      source: { kind: "ssh_config", text: config },
      importKnownHosts: false,
      keyPaths: [],
    });
    expect(result.servers).toEqual({ added: 3, duplicates: 0, failed: [] });
    const bastion = servers.find((s) => s.label === "bastion");
    const app = servers.find((s) => s.label === "app");
    expect(app).toMatchObject({ address: "10.0.0.12", port: 2200, username: "deploy" });
    expect(app?.jumpChain).toEqual([bastion?.id]);
    expect(servers.find((s) => s.label === "legacy")?.jumpChain).toEqual([]);

    const again = await importer.apply({
      source: { kind: "ssh_config", text: config },
      importKnownHosts: false,
      keyPaths: [],
    });
    expect(again.servers).toMatchObject({ added: 0, duplicates: 3 });
  });

  it("imports CSV rows with groups and tags and reports bad rows by line", async () => {
    const csv = [
      "label,address,port,username,group,tags",
      "web-1,192.0.2.10,22,deploy,prod/eu,web;nginx",
      "broken,,abc,,,",
    ].join("\n");
    expect(parseServersCsv(csv, "CSV").issues).toEqual([
      expect.objectContaining({ severity: "error", location: { file: "CSV", line: 3 } }),
    ]);
    const { sink, servers, groups } = createMemorySink();
    const result = await new SshImporter({ sink, userHome: home }).apply({
      source: { kind: "csv", text: csv },
      importKnownHosts: false,
      keyPaths: [],
    });
    expect(result.servers.added).toBe(1);
    expect(servers[0]).toMatchObject({
      label: "web-1",
      address: "192.0.2.10",
      username: "deploy",
      tags: ["web", "nginx"],
      groupId: groups.get("prod/eu"),
    });
  });

  it("reads ~/.ssh/config and known_hosts from the daemon home", async () => {
    await mkdir(path.join(home, ".ssh"), { recursive: true });
    await writeFile(path.join(home, ".ssh", "config"), "Host box\n  HostName 192.0.2.20\n");
    await writeFile(
      path.join(home, ".ssh", "known_hosts"),
      "192.0.2.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n",
    );
    const { sink } = createMemorySink();
    const preview = await new SshImporter({ sink, userHome: home }).preview({
      kind: "ssh_directory",
    });
    expect(preview.servers.map((s) => s.address)).toEqual(["192.0.2.20"]);
    expect(preview.knownHosts).toEqual([
      expect.objectContaining({
        host: "192.0.2.20",
        port: 22,
        keyType: "ssh-ed25519",
        status: "new",
      }),
    ]);
    expect(preview.knownHosts[0].fingerprintSha256).toMatch(/^SHA256:/);
  });
});

describe("session logs (spec 25.8)", () => {
  let sshHome: string;
  let clock: number;
  beforeEach(async () => {
    sshHome = await mkdtemp(path.join(os.tmpdir(), "jad-logs-"));
    clock = 1_000;
  });
  afterEach(async () => {
    await rm(sshHome, { recursive: true, force: true });
  });

  it("records only when enabled, strips escapes, and keeps 0600 files", async () => {
    const logs = new SessionLogService({ sshHome, now: () => clock });
    expect(await logs.startRecording("srv_a1b2c3")).toBeNull();

    await logs.setEnabled("srv_a1b2c3", true);
    const recorder = await logs.startRecording("srv_a1b2c3");
    if (!recorder) throw new Error("recording did not start");
    recorder.write(`${ESC}[1mPassword:${ESC}[0m `);
    recorder.write("\r\nWelcome\r\n$ uptime\r\n 10:00 up 3 days\r\n");
    await recorder.close();

    const window = await logs.read({ kind: "recent", serverId: "srv_a1b2c3" });
    expect(window.text).toBe("Password:\nWelcome\n$ uptime\n 10:00 up 3 days\n");
    const file = path.join(sshHome, "logs", "srv_a1b2c3.log");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(sshHome, "logs"))).mode & 0o777).toBe(0o700);

    const found = await logs.search({ kind: "recent", serverId: "srv_a1b2c3" }, "UPTIME");
    expect(found.matches.map((m) => [m.lineNumber, m.line])).toEqual([[3, "$ uptime"]]);
  });

  it("keeps a bookmark when the next session replaces the recent log", async () => {
    const logs = new SessionLogService({ sshHome, now: () => clock });
    await logs.setEnabled("srv_a1b2c3", true);
    const first = await logs.startRecording("srv_a1b2c3");
    first?.write("deploy finished\r\n");
    await first?.close();
    const bookmark = await logs.bookmark("srv_a1b2c3", " release 2 ");
    expect(bookmark.comment).toBe("release 2");

    clock = 2_000;
    const second = await logs.startRecording("srv_a1b2c3");
    second?.write("new session\r\n");
    await second?.close();

    expect((await logs.read({ kind: "recent", serverId: "srv_a1b2c3" })).text).toBe(
      "new session\n",
    );
    expect((await logs.read({ kind: "bookmark", bookmarkId: bookmark.id })).text).toBe(
      "deploy finished\n",
    );
    const updated = await logs.updateBookmark(bookmark.id, "rollback point");
    expect(updated.comment).toBe("rollback point");
    const listing = await logs.list();
    expect(listing.bookmarks.map((b) => b.comment)).toEqual(["rollback point"]);
    expect(listing.logs).toEqual([
      expect.objectContaining({
        serverId: "srv_a1b2c3",
        sessionStartedAtMs: 2_000,
        recording: false,
      }),
    ]);
  });

  it("cuts the oldest text once the log passes its size limit", async () => {
    const logs = new SessionLogService({ sshHome, now: () => clock, maxBytes: 1024 });
    await logs.setEnabled("srv_a1b2c3", true);
    const recorder = await logs.startRecording("srv_a1b2c3");
    for (let line = 1; line <= 200; line += 1) recorder?.write(`line ${line}\r\n`);
    await recorder?.close();

    const file = path.join(sshHome, "logs", "srv_a1b2c3.log");
    const text = await readFile(file, "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
    expect(text.endsWith("line 200\n")).toBe(true);
    expect(text.includes("line 1\n")).toBe(false);
  });
});

describe("install public key script", () => {
  it("accepts only an OpenSSH public key line", () => {
    expect(() => assertPublicKeyLine("ssh-ed25519 AAAA; rm -rf ~")).toThrow(
      expect.objectContaining({ code: "invalid_public_key" }),
    );
    expect(
      assertPublicKeyLine(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl it's me\n",
      ),
    ).toBe(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl it's me",
    );
    expect(installPath({ directory: "~/.ssh/", filename: "authorized_keys2" })).toBe(
      ".ssh/authorized_keys2",
    );
    expect(() =>
      installScript("ssh-ed25519 AAAA", { directory: ".ssh", filename: "../x" }),
    ).toThrow();
  });

  it("answers RPCs with string errors", async () => {
    const out: LogsImportOutboundMessage[] = [];
    const keys = new KeyInstallService({
      acquire: () => Promise.reject(new Error("not used")),
      getPublicKey: async () => null,
      attachKey: async () => undefined,
    });
    const logs = new SessionLogService({ sshHome: os.tmpdir(), now: () => 0 });
    const { sink } = createMemorySink();
    const handled = await handleLogsImportMessage(
      { logs, importer: new SshImporter({ sink, userHome: os.tmpdir() }), keys },
      {
        type: "ssh.keys.install_to_server.request",
        requestId: "req_1",
        keyId: "key_x",
        serverId: "srv_x",
      } as {
        type: string;
      },
      (message) => out.push(message),
    );
    expect(handled).toBe(true);
    expect(out).toEqual([
      {
        type: "ssh.keys.install_to_server.response",
        payload: { requestId: "req_1", error: "Unknown key key_x", outcome: null, path: null },
      },
    ]);
  });
});
