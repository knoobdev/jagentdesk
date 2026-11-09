import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSnapshot, isSecretBasename, SNAPSHOT_MAX_FILE_BYTES } from "./snapshot.js";
import { RemoteExecError } from "./types.js";

let root: string;
let homeDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-snap-"));
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-home-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], {
    cwd,
    stdio: "ignore",
  });
}

async function makeRepo(): Promise<string> {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  git(repo, ["init", "-q"]);
  await fs.writeFile(path.join(repo, "tracked.txt"), "original\n");
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "init"]);
  await fs.writeFile(path.join(repo, "tracked.txt"), "modified\n");
  await fs.writeFile(path.join(repo, "untracked.txt"), "new\n");
  await fs.writeFile(path.join(repo, "ignored.txt"), "skipped by git\n");
  await fs.writeFile(path.join(repo, ".env"), "SECRET_VALUE=1\n");
  await fs.writeFile(path.join(repo, ".env.example"), "SECRET_VALUE=\n");
  await fs.writeFile(path.join(repo, "id_ed25519"), "PRIVATE KEY\n");
  await fs.writeFile(path.join(repo, "target.txt"), "link target\n");
  await fs.symlink("target.txt", path.join(repo, "link.txt"));
  await fs.writeFile(path.join(repo, "exec.sh"), "#!/bin/sh\n");
  await fs.chmod(path.join(repo, "exec.sh"), 0o755);
  return repo;
}

describe("createSnapshot", () => {
  it("collects tracked-modified, untracked and ignored-excluded files with modes and links", async () => {
    const repo = await makeRepo();
    const snapshot = await createSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });

    const paths = snapshot.files.map((file) => file.path).toSorted();
    expect(paths).toEqual([
      ".env.example",
      ".gitignore",
      "exec.sh",
      "link.txt",
      "target.txt",
      "tracked.txt",
      "untracked.txt",
    ]);
    expect(snapshot.excludedSecrets.toSorted()).toEqual([".env", "id_ed25519"]);

    const tracked = snapshot.files.find((file) => file.path === "tracked.txt");
    expect(tracked?.hash).not.toBeUndefined();
    const exec = snapshot.files.find((file) => file.path === "exec.sh");
    expect(exec?.executable).toBe(true);
    expect(exec?.mode).toBe(0o755);
    const plain = snapshot.files.find((file) => file.path === "tracked.txt");
    expect(plain?.executable).toBe(false);
    const link = snapshot.files.find((file) => file.path === "link.txt");
    expect(link?.symlink).toBe(true);
    expect(link?.size).toBe(0);
    expect(link?.hash).toBe(createHash("sha256").update("target.txt").digest("hex"));
  });

  it("drops tracked files deleted from disk", async () => {
    const repo = await makeRepo();
    await fs.rm(path.join(repo, "untracked.txt"));
    await fs.rm(path.join(repo, "tracked.txt"));
    const snapshot = await createSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(snapshot.files.map((file) => file.path)).not.toContain("tracked.txt");
  });

  it("scopes to a subdirectory workspace and uses paths relative to it", async () => {
    const repo = await makeRepo();
    const subdir = path.join(repo, "sub");
    await fs.mkdir(subdir);
    await fs.writeFile(path.join(subdir, "inner.txt"), "inside\n");
    git(repo, ["add", "."]);

    const snapshot = await createSnapshot({ workspacePath: subdir, daemonId: "d1", homeDir });
    expect(snapshot.files.map((file) => file.path)).toEqual(["inner.txt"]);
    expect(snapshot.workspacePath).toBe(subdir);
    const rootSnapshot = await createSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(rootSnapshot.workspaceKey).not.toBe(snapshot.workspaceKey);
  });

  it("skips submodules (gitlinks) into skipped", async () => {
    const repo = await makeRepo();
    const inner = path.join(root, "inner");
    await fs.mkdir(inner);
    git(inner, ["init", "-q"]);
    await fs.writeFile(path.join(inner, "sub.txt"), "x\n");
    git(inner, ["add", "."]);
    git(inner, ["commit", "-qm", "init"]);
    git(repo, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      inner,
      "vendor/inner",
    ]);
    git(repo, ["commit", "-qm", "submodule"]);

    const snapshot = await createSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(snapshot.skipped).toEqual(["vendor/inner"]);
    expect(snapshot.files.map((file) => file.path)).not.toContain("vendor/inner");
  });

  it("fails with not_git_workspace outside a work tree", async () => {
    const plain = path.join(root, "plain");
    await fs.mkdir(plain);
    await expect(
      createSnapshot({ workspacePath: plain, daemonId: "d1", homeDir }),
    ).rejects.toMatchObject({
      name: "RemoteExecError",
      code: "not_git_workspace",
    } satisfies Partial<RemoteExecError>);
  });

  it("fails with snapshot_too_large and reports the largest paths", async () => {
    const repo = await makeRepo();
    const big = path.join(repo, "big.bin");
    const handle = await fs.open(big, "w");
    await handle.truncate(SNAPSHOT_MAX_FILE_BYTES + 1);
    await handle.close();
    const error = await createSnapshot({ workspacePath: repo, daemonId: "d1", homeDir }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RemoteExecError);
    const details = (error as RemoteExecError).details as {
      largest: { path: string; bytes: number }[];
    };
    expect(details.largest.length).toBeLessThanOrEqual(10);
    expect(details.largest[0]).toMatchObject({
      path: "big.bin",
      bytes: SNAPSHOT_MAX_FILE_BYTES + 1,
    });
  });

  it("produces a deterministic snapshotId and reuses the hash cache", async () => {
    const repo = await makeRepo();
    const first = await createSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(first.snapshotId).toMatch(/^snp_[0-9a-f]{12}$/);

    const cachePath = path.join(homeDir, "remote-exec", "hash-cache", `${first.workspaceKey}.json`);
    await fs.access(cachePath);
    const cacheStat = await fs.stat(cachePath);
    expect(cacheStat.mode & 0o777).toBe(0o600);

    const second = await createSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(second.snapshotId).toBe(first.snapshotId);
  });

  it("rehashes when a file changes but keeps the snapshotId content-stable", async () => {
    const repo = await makeRepo();
    const first = await createSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    await fs.writeFile(path.join(repo, "untracked.txt"), "changed\n");
    const second = await createSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(second.snapshotId).not.toBe(first.snapshotId);
  });
});

describe("isSecretBasename", () => {
  it("applies the spec 33.4 basename rule", () => {
    const secret = [
      ".env",
      ".env.local",
      ".env.production",
      "server.pem",
      "a.key",
      "cert.p12",
      "cert.pfx",
      "id_rsa",
      "id_rsa.pub",
      "id_ecdsa",
      "id_ed25519",
      "id_rsa.txt",
      ".npmrc",
      ".netrc",
      ".pypirc",
    ];
    for (const name of secret) expect(isSecretBasename(name)).toBe(true);
    const kept = [".env.example", ".env.sample", ".env.template", "main.ts", "keynote.txt"];
    for (const name of kept) expect(isSecretBasename(name)).toBe(false);
  });
});
