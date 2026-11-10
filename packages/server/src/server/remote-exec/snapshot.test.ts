import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSourceSnapshot, isSecretBasename } from "./snapshot.js";

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

describe("createSourceSnapshot", () => {
  it("collects tracked-modified, untracked and ignored-excluded files with modes and links", async () => {
    const repo = await makeRepo();
    const snapshot = await createSourceSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });

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
    const snapshot = await createSourceSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(snapshot.files.map((file) => file.path)).not.toContain("tracked.txt");
  });

  it("scopes to a subdirectory workspace and uses paths relative to it", async () => {
    const repo = await makeRepo();
    const subdir = path.join(repo, "sub");
    await fs.mkdir(subdir);
    await fs.writeFile(path.join(subdir, "inner.txt"), "inside\n");
    git(repo, ["add", "."]);

    const snapshot = await createSourceSnapshot({ workspacePath: subdir, daemonId: "d1", homeDir });
    expect(snapshot.files.map((file) => file.path)).toEqual(["inner.txt"]);
    expect(snapshot.workspacePath).toBe(subdir);
    const rootSnapshot = await createSourceSnapshot({
      workspacePath: repo,
      daemonId: "d1",
      homeDir,
    });
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

    const snapshot = await createSourceSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(snapshot.skipped).toEqual(["vendor/inner"]);
    expect(snapshot.files.map((file) => file.path)).not.toContain("vendor/inner");
  });

  it("walks a plain (non-git) directory, skipping dependency/cache dirs and nested repo extras", async () => {
    const plain = path.join(root, "plain");
    await fs.mkdir(path.join(plain, "node_modules"), { recursive: true });
    await fs.mkdir(path.join(plain, "build"), { recursive: true });
    await fs.mkdir(path.join(plain, "__pycache__"), { recursive: true });
    await fs.writeFile(path.join(plain, "notes.txt"), "plain root\n");
    await fs.writeFile(path.join(plain, ".env"), "ROOT_SECRET=1\n");
    await fs.writeFile(path.join(plain, "node_modules", "m.js"), "dep\n");
    await fs.writeFile(path.join(plain, "__pycache__", "x.pyc"), "cache\n");
    await fs.writeFile(path.join(plain, "build", "out.js"), "built\n");
    const snapshot = await createSourceSnapshot({ workspacePath: plain, daemonId: "d1", homeDir });
    expect(snapshot.files.map((file) => file.path).toSorted()).toEqual([
      "build/out.js",
      "notes.txt",
    ]);
    expect(snapshot.excludedSecrets).toEqual([".env"]);
  });

  it("walks a non-git tree: nested git repos keep their .gitignore, symlinks stay symlinks", async () => {
    const plain = path.join(root, "plain");
    const repo = path.join(plain, "repo");
    await fs.mkdir(path.join(repo, "build"), { recursive: true });
    await fs.writeFile(path.join(repo, ".gitignore"), "build/\n");
    await fs.writeFile(path.join(repo, "code.ts"), "export {};\n");
    await fs.writeFile(path.join(repo, "build", "x.js"), "ignored\n");
    await fs.writeFile(path.join(repo, ".env"), "SECRET=1\n");
    git(repo, ["init", "-q"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "init"]);
    await fs.mkdir(path.join(plain, "sub"));
    await fs.writeFile(path.join(plain, "sub", "inner.txt"), "walked\n");
    await fs.writeFile(path.join(plain, "target.txt"), "link target\n");
    await fs.symlink("target.txt", path.join(plain, "link.txt"));
    // A directory symlink must not be followed: its content stays out, the link itself is sent.
    await fs.symlink("repo", path.join(plain, "repo-link"));

    const snapshot = await createSourceSnapshot({ workspacePath: plain, daemonId: "d1", homeDir });
    expect(snapshot.files.map((file) => file.path).toSorted()).toEqual([
      "link.txt",
      "repo-link",
      "repo/.gitignore",
      "repo/code.ts",
      "sub/inner.txt",
      "target.txt",
    ]);
    expect(snapshot.excludedSecrets).toEqual(["repo/.env"]);
    const link = snapshot.files.find((file) => file.path === "repo-link");
    expect(link?.symlink).toBe(true);
  });

  it("skips sockets and FIFOs in the walk", async () => {
    const plain = path.join(root, "plain");
    await fs.mkdir(plain);
    await fs.writeFile(path.join(plain, "keep.txt"), "keep\n");
    execFileSync("mkfifo", [path.join(plain, "pipe")]);
    const snapshot = await createSourceSnapshot({ workspacePath: plain, daemonId: "d1", homeDir });
    expect(snapshot.files.map((file) => file.path)).toEqual(["keep.txt"]);
  });

  it("stops the walk with snapshot_too_large over the injected entry cap", async () => {
    const plain = path.join(root, "plain");
    await fs.mkdir(path.join(plain, "a", "b"), { recursive: true });
    await fs.writeFile(path.join(plain, "a", "b", "f.txt"), "x\n");
    await expect(
      createSourceSnapshot({
        workspacePath: plain,
        daemonId: "d1",
        homeDir,
        maxVisitedEntries: 2,
      }),
    ).rejects.toMatchObject({ name: "RemoteExecError", code: "snapshot_too_large" });
    const capped = await createSourceSnapshot({
      workspacePath: plain,
      daemonId: "d1",
      homeDir,
      maxVisitedEntries: 3,
    });
    expect(capped.files.map((file) => file.path)).toEqual(["a/b/f.txt"]);
  });

  it("scopes a git source to the given subdirectory of a work tree", async () => {
    const repo = await makeRepo();
    const subdir = path.join(repo, "sub");
    await fs.mkdir(subdir);
    await fs.writeFile(path.join(subdir, "inner.txt"), "inside\n");
    await fs.writeFile(path.join(subdir, ".env"), "SUB_SECRET=1\n");
    git(repo, ["add", "."]);
    const snapshot = await createSourceSnapshot({ workspacePath: subdir, daemonId: "d1", homeDir });
    expect(snapshot.files.map((file) => file.path)).toEqual(["inner.txt"]);
    expect(snapshot.excludedSecrets).toEqual([".env"]);
  });

  it("produces a deterministic snapshotId and reuses the hash cache", async () => {
    const repo = await makeRepo();
    const first = await createSourceSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(first.snapshotId).toMatch(/^snp_[0-9a-f]{12}$/);

    const cachePath = path.join(homeDir, "remote-exec", "hash-cache", `${first.workspaceKey}.json`);
    await fs.access(cachePath);
    const cacheStat = await fs.stat(cachePath);
    expect(cacheStat.mode & 0o777).toBe(0o600);

    const second = await createSourceSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    expect(second.snapshotId).toBe(first.snapshotId);
  });

  it("rehashes when a file changes but keeps the snapshotId content-stable", async () => {
    const repo = await makeRepo();
    const first = await createSourceSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
    await fs.writeFile(path.join(repo, "untracked.txt"), "changed\n");
    const second = await createSourceSnapshot({ workspacePath: repo, daemonId: "d1", homeDir });
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
