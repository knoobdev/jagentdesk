import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "ssh2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  SftpOutboundMessage,
  SshTransferProgress,
} from "@jagentdesk/protocol/ssh/sftp-schemas";
import { createTestSshPool, type TestSshPool } from "../test-support/test-sshd.js";
import { handleSftpMessage } from "./rpc.js";
import { SftpService } from "./service.js";

// Integration tests against the real sshd from ../test-support/start-test-sshd.sh.
// srv_a and srv_b are two saved servers that happen to point at the same sshd, each with its
// own connection, which is enough to exercise server↔server copies.

function exec(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) return reject(error);
      let out = "";
      stream.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      stream.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
      stream.on("close", (code: number) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`${command} → ${code}: ${out}`));
      });
    });
  });
}

describe("SftpService against a real sshd", () => {
  let pool: TestSshPool;
  let service: SftpService;
  let shell: Client;
  let sshDir: string;
  let localDir: string;
  const progress: SshTransferProgress[] = [];
  const remoteRoot = `/tmp/jad-sftp-${process.pid}`;
  const a = { kind: "server", serverId: "srv_a" } as const;
  const b = { kind: "server", serverId: "srv_b" } as const;

  beforeAll(async () => {
    pool = createTestSshPool();
    sshDir = await mkdtemp(path.join(os.tmpdir(), "jad-ssh-home-"));
    localDir = await mkdtemp(path.join(os.tmpdir(), "jad-sftp-local-"));
    service = new SftpService({ acquire: pool.acquire, sshDir, channelIdleMs: 200 });
    service.subscribe((event) => progress.push(event));
    shell = (await pool.acquire("shell")).client;
    await exec(shell, `rm -rf ${remoteRoot} && mkdir -p ${remoteRoot}/a ${remoteRoot}/b`);
  });

  afterAll(async () => {
    await exec(shell, `rm -rf ${remoteRoot}`);
    service.dispose();
    pool.close();
    await rm(sshDir, { recursive: true, force: true });
    await rm(localDir, { recursive: true, force: true });
  });

  it("lists the home directory with hidden files on request", async () => {
    await exec(shell, `touch ~/.jad-hidden-${process.pid}`);
    const visible = await service.list({ endpoint: a, path: "", showHidden: false });
    const all = await service.list({ endpoint: a, path: "", showHidden: true });
    await exec(shell, `rm ~/.jad-hidden-${process.pid}`);

    expect(visible.path).toBe(await exec(shell, "cd ~ && pwd"));
    expect(visible.entries.some((e) => e.name.startsWith("."))).toBe(false);
    expect(all.entries.map((e) => e.name)).toContain(`.jad-hidden-${process.pid}`);
  });

  it("creates, renames, chmods and deletes on the server", async () => {
    await service.mkdir(a, `${remoteRoot}/a/made`);
    await service.rename(a, `${remoteRoot}/a/made`, `${remoteRoot}/a/renamed`);
    await service.chmod(a, `${remoteRoot}/a/renamed`, "750");
    await exec(shell, `echo hi > ${remoteRoot}/a/renamed/f.txt`);

    const entry = await service.stat(a, `${remoteRoot}/a/renamed`);
    expect(entry).toMatchObject({ kind: "directory", permissions: "rwxr-x---", mode: 0o750 });
    expect(await exec(shell, `stat -c %a ${remoteRoot}/a/renamed`)).toBe("750");

    await service.delete(a, `${remoteRoot}/a/renamed`);
    expect(await exec(shell, `test -e ${remoteRoot}/a/renamed && echo yes || echo no`)).toBe("no");
    await expect(service.mkdir(a, `${remoteRoot}/a`)).rejects.toMatchObject({
      code: "already_exists",
    });
    await expect(
      service.list({ endpoint: a, path: `${remoteRoot}/missing`, showHidden: false }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("downloads 100 MB, pauses near 50%, resumes, and the SHA-256 matches", async () => {
    await exec(shell, `head -c 104857600 /dev/urandom > ${remoteRoot}/big.bin`);
    const remoteSha = (await exec(shell, `sha256sum ${remoteRoot}/big.bin`)).split(" ")[0];

    const [queued] = await service.copy({
      source: a,
      sourcePaths: [`${remoteRoot}/big.bin`],
      target: { kind: "daemon" },
      targetDir: localDir,
    });
    const unsubscribe = service.subscribe((event) => {
      const t = event.transfer;
      if (t.id === queued.id && t.status === "running" && t.bytesTransferred >= 50 * 1024 * 1024) {
        unsubscribe();
        service.pauseTransfer(queued.id);
      }
    });
    const paused = await service.settled(queued.id);
    expect(paused.status).toBe("paused");
    const partial = (await stat(path.join(localDir, "big.bin"))).size;
    expect(partial).toBeGreaterThanOrEqual(50 * 1024 * 1024);
    expect(partial).toBeLessThan(104857600);

    service.resumeTransfer(queued.id);
    const done = await service.settled(queued.id);

    expect(done).toMatchObject({ status: "completed", bytesTransferred: 104857600 });
    const localSha = createHash("sha256")
      .update(await readFile(path.join(localDir, "big.bin")))
      .digest("hex");
    expect(localSha).toBe(remoteSha);
    expect(
      progress.some((e) => e.transfer.id === queued.id && e.transfer.status === "paused"),
    ).toBe(true);
  }, 180_000);

  it("copies a directory server↔server and uploads from the daemon with keep-both", async () => {
    await exec(
      shell,
      `mkdir -p ${remoteRoot}/a/tree/sub && echo one > ${remoteRoot}/a/tree/one.txt && echo two > ${remoteRoot}/a/tree/sub/two.txt`,
    );
    const [remote] = await service.copy({
      source: a,
      sourcePaths: [`${remoteRoot}/a/tree`],
      target: b,
      targetDir: `${remoteRoot}/b`,
    });
    expect(await service.settled(remote.id)).toMatchObject({ status: "completed", filesDone: 2 });
    expect(await exec(shell, `cat ${remoteRoot}/b/tree/sub/two.txt`)).toBe("two");

    await writeFile(path.join(localDir, "one.txt"), "from daemon");
    const [upload] = await service.copy({
      source: { kind: "daemon" },
      sourcePaths: [path.join(localDir, "one.txt")],
      target: b,
      targetDir: `${remoteRoot}/b/tree`,
      conflict: "keep-both",
    });
    const uploaded = await service.settled(upload.id);
    expect(uploaded.targetPath).toBe(`${remoteRoot}/b/tree/one (1).txt`);
    expect(await exec(shell, `cat "${remoteRoot}/b/tree/one (1).txt"`)).toBe("from daemon");
    expect(await exec(shell, `cat ${remoteRoot}/b/tree/one.txt`)).toBe("one");
  });

  it("saves editor changes and reports a conflict when the server copy changed", async () => {
    await exec(shell, `printf 'port=80\\n' > ${remoteRoot}/app.conf`);
    const opened = await service.read(a, `${remoteRoot}/app.conf`);
    expect(opened.content).toBe("port=80\n");

    const saved = await service.write({
      endpoint: a,
      path: `${remoteRoot}/app.conf`,
      content: "port=8080\n",
      hasBom: false,
      expectedRevision: opened.version.revision,
    });
    expect(saved.status).toBe("written");
    expect(await exec(shell, `cat ${remoteRoot}/app.conf`)).toBe("port=8080");

    await exec(shell, `printf 'port=9090\\n' > ${remoteRoot}/app.conf`);
    const stale = await service.write({
      endpoint: a,
      path: `${remoteRoot}/app.conf`,
      content: "port=1\n",
      hasBom: false,
      expectedRevision: saved.status === "written" ? saved.version.revision : "",
    });
    expect(stale).toMatchObject({ status: "conflict", current: { size: 10 } });
    expect(await exec(shell, `cat ${remoteRoot}/app.conf`)).toBe("port=9090");

    const overwritten = await service.write({
      endpoint: a,
      path: `${remoteRoot}/app.conf`,
      content: "port=1\n",
      hasBom: false,
    });
    expect(overwritten.status).toBe("written");
    expect(await exec(shell, `cat ${remoteRoot}/app.conf`)).toBe("port=1");
  });

  it("stages a device download where file_download_token_request can serve it", async () => {
    await exec(shell, `printf 'log line\\n' > ${remoteRoot}/server.log`);
    const download = await service.download(a, `${remoteRoot}/server.log`);
    await service.settled(download.transfer.id);

    expect(download.path).toBe("server.log");
    expect(path.dirname(download.cwd)).toBe(path.join(sshDir, "downloads"));
    expect(await readFile(path.join(download.cwd, download.path), "utf8")).toBe("log line\n");

    await service.dismissTransfer(download.transfer.id);
    await expect(stat(download.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("answers RPCs with structured errors and gives leases back when idle", async () => {
    const out: SftpOutboundMessage[] = [];
    const handled = await handleSftpMessage(
      service,
      {
        type: "ssh.sftp.read.request",
        requestId: "req_1",
        endpoint: a,
        path: `${remoteRoot}/nope.txt`,
      } as { type: string },
      (message) => out.push(message),
    );
    expect(handled).toBe(true);
    expect(out).toEqual([
      {
        type: "ssh.sftp.read.response",
        payload: {
          requestId: "req_1",
          error: { code: "not_found", message: `${remoteRoot}/nope.txt does not exist` },
          file: null,
        },
      },
    ]);
    expect(await handleSftpMessage(service, { type: "ssh.servers.list.request" }, () => {})).toBe(
      false,
    );

    // Only the test's own shell lease remains once the SFTP channels have idled out.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(pool.heldLeases()).toBe(1);
  });
});
