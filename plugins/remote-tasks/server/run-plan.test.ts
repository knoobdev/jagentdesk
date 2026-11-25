import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeWorkspaceKey } from "./ids.js";
import { createRunPlan, jobSnapshotId } from "./run-plan.js";
import { RemoteExecError } from "./types.js";
import { SNAPSHOT_MAX_FILE_BYTES, SNAPSHOT_MAX_TOTAL_BYTES } from "./snapshot.js";

// The run plan (spec 33.4): source selection -> per-source snapshots -> run-wide limits ->
// job snapshotId. previewSnapshot and startJob share createRunPlan, so these tests prove the
// shape every caller sees.

let root: string;
let homeDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-plan-"));
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-plan-home-"));
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

/** Non-git cwd with git repo A, git repo B, plain dir C and a root .env (spec 33.10#13). */
async function makeMultiWorkspace(): Promise<string> {
  const cwd = path.join(root, "ws");
  await fs.mkdir(cwd);
  for (const name of ["A", "B", "C"]) {
    await fs.mkdir(path.join(cwd, name));
  }
  await fs.writeFile(path.join(cwd, ".env"), "ROOT_SECRET=1\n");
  await fs.writeFile(path.join(cwd, "A", ".gitignore"), "build/\n");
  await fs.writeFile(path.join(cwd, "A", "code.ts"), "a\n");
  await fs.mkdir(path.join(cwd, "A", "build"));
  await fs.writeFile(path.join(cwd, "A", "build", "x.js"), "ignored\n");
  await fs.writeFile(path.join(cwd, "A", ".env"), "A_SECRET=1\n");
  git(path.join(cwd, "A"), ["init", "-q"]);
  git(path.join(cwd, "A"), ["add", "."]);
  git(path.join(cwd, "A"), ["commit", "-qm", "init"]);
  await fs.writeFile(path.join(cwd, "B", "code.ts"), "b\n");
  git(path.join(cwd, "B"), ["init", "-q"]);
  git(path.join(cwd, "B"), ["add", "."]);
  git(path.join(cwd, "B"), ["commit", "-qm", "init"]);
  await fs.mkdir(path.join(cwd, "C", "node_modules"), { recursive: true });
  await fs.writeFile(path.join(cwd, "C", "node_modules", "m.js"), "dep\n");
  await fs.writeFile(path.join(cwd, "C", "notes.txt"), "plain\n");
  return cwd;
}

describe("createRunPlan", () => {
  it("plans the default source for a non-git cwd — not_git_workspace is gone", async () => {
    const cwd = await makeMultiWorkspace();
    const plan = await createRunPlan({ cwd, daemonId: "d1", homeDir });
    expect(plan.kind).toBe("default");
    if (plan.kind !== "default") return;
    expect(plan.snapshot.workspacePath).toBe(cwd);
    const paths = plan.snapshot.files.map((file) => `${file.path}`).toSorted();
    expect(paths).toEqual(["A/.gitignore", "A/code.ts", "B/code.ts", "C/notes.txt"]);
    expect(plan.snapshot.excludedSecrets.toSorted()).toEqual([".env", "A/.env"]);
    expect(plan.snapshot.skipped).toEqual([]);
  });

  it("plans noCode without any snapshot and a null snapshotId", async () => {
    const cwd = await makeMultiWorkspace();
    const plan = await createRunPlan({ cwd, daemonId: "d1", homeDir, noCode: true });
    expect(plan.kind).toBe("noCode");
    expect(jobSnapshotId(plan)).toBeNull();
  });

  it("plans explicit sources with resolved paths and per-source snapshots", async () => {
    const cwd = await makeMultiWorkspace();
    const plan = await createRunPlan({
      cwd,
      daemonId: "d1",
      homeDir,
      source: ["A", "C"],
    });
    expect(plan.kind).toBe("sources");
    if (plan.kind !== "sources") return;
    expect(plan.snapshots.map((entry) => entry.name)).toEqual(["A", "C"]);
    expect(plan.snapshots.map((entry) => entry.path)).toEqual([
      await fs.realpath(path.join(cwd, "A")),
      await fs.realpath(path.join(cwd, "C")),
    ]);
    const aPaths = plan.snapshots[0].snapshot.files.map((file) => file.path);
    expect(aPaths).toEqual([".gitignore", "code.ts"]); // scoped to A, .gitignore honoured
    expect(plan.snapshots[0].snapshot.excludedSecrets).toEqual([".env"]);
    const cPaths = plan.snapshots[1].snapshot.files.map((file) => file.path);
    expect(cPaths).toEqual(["notes.txt"]); // node_modules skipped by the walk
  });

  it("gives one source the source's snapshotId and several sources the aggregate", async () => {
    const cwd = await makeMultiWorkspace();
    const single = await createRunPlan({ cwd, daemonId: "d1", homeDir, source: "A" });
    expect(single.kind).toBe("sources");
    expect(jobSnapshotId(single)).toBe(
      single.kind === "sources" ? single.snapshots[0].snapshot.snapshotId : null,
    );
    const both = await createRunPlan({ cwd, daemonId: "d1", homeDir, source: ["A", "C"] });
    expect(both.kind).toBe("sources");
    if (both.kind !== "sources" || single.kind !== "sources") return;
    expect(jobSnapshotId(both)).not.toBe(jobSnapshotId(single));
    expect(jobSnapshotId(both)).toMatch(/^snp_[0-9a-f]{12}$/);
  });

  it("keeps the aggregate snapshotId stable across repeated plans", async () => {
    const cwd = await makeMultiWorkspace();
    const first = await createRunPlan({ cwd, daemonId: "d1", homeDir, source: ["A", "C"] });
    const second = await createRunPlan({ cwd, daemonId: "d1", homeDir, source: ["C", "A"] });
    expect(jobSnapshotId(first)).toBe(jobSnapshotId(second));
  });

  it("throws snapshot_too_large for one oversized file and reports the largest path", async () => {
    const cwd = path.join(root, "ws");
    await fs.mkdir(cwd);
    const handle = await fs.open(path.join(cwd, "big.bin"), "w");
    await handle.truncate(SNAPSHOT_MAX_FILE_BYTES + 1);
    await handle.close();
    const error = await createRunPlan({ cwd, daemonId: "d1", homeDir }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RemoteExecError);
    expect((error as RemoteExecError).code).toBe("snapshot_too_large");
    expect((error as RemoteExecError).message).toContain("sendCode: false");
    const details = (error as RemoteExecError).details as {
      largest: { path: string; bytes: number }[];
    };
    expect(details.largest[0]).toMatchObject({
      path: "big.bin",
      bytes: SNAPSHOT_MAX_FILE_BYTES + 1,
    });
  });

  it("reads no file content when the size limit fires", async () => {
    const cwd = path.join(root, "ws");
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "small.txt"), "ok\n");
    // Sparse file: stats.size exceeds the per-file limit, disk usage stays tiny.
    const handle = await fs.open(path.join(cwd, "big.bin"), "w");
    await handle.truncate(SNAPSHOT_MAX_FILE_BYTES + 1);
    await handle.close();
    const hasher = vi.fn(async () => {
      throw new Error("content must not be read before the limits pass");
    });
    const error = await createRunPlan({ cwd, daemonId: "d1", homeDir, hasher }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RemoteExecError);
    expect((error as RemoteExecError).code).toBe("snapshot_too_large");
    expect((error as RemoteExecError).message).toContain("sendCode: false");
    expect(hasher).not.toHaveBeenCalled();
  });

  it("enforces the 1 GiB total across all sources of one run", async () => {
    const cwd = path.join(root, "ws");
    await fs.mkdir(path.join(cwd, "A"), { recursive: true });
    await fs.mkdir(path.join(cwd, "B"), { recursive: true });
    // Sparse files: stats.size counts, disk usage stays tiny.
    const a = await fs.open(path.join(cwd, "A", "big.bin"), "w");
    await a.truncate(Math.floor(SNAPSHOT_MAX_TOTAL_BYTES / 2) + 1);
    await a.close();
    const b = await fs.open(path.join(cwd, "B", "big.bin"), "w");
    await b.truncate(Math.floor(SNAPSHOT_MAX_TOTAL_BYTES / 2) + 1);
    await b.close();
    const error = await createRunPlan({ cwd, daemonId: "d1", homeDir, source: ["A", "B"] }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RemoteExecError);
    expect((error as RemoteExecError).code).toBe("snapshot_too_large");
    const details = (error as RemoteExecError).details as {
      largest: { path: string; bytes: number }[];
    };
    // Explicit sources prefix their paths with the source name.
    expect(details.largest.map((entry) => entry.path).toSorted()).toEqual([
      "A/big.bin",
      "B/big.bin",
    ]);
  });
});

describe("computeWorkspaceKey consistency", () => {
  it("uses the cwd-based key for every plan kind", async () => {
    const cwd = await makeMultiWorkspace();
    const expected = computeWorkspaceKey("d1", cwd);
    const def = await createRunPlan({ cwd, daemonId: "d1", homeDir });
    const noCode = await createRunPlan({ cwd, daemonId: "d1", homeDir, noCode: true });
    const sources = await createRunPlan({ cwd, daemonId: "d1", homeDir, source: "A" });
    expect(def.kind === "default" && def.workspaceKey).toBe(expected);
    expect(noCode.workspaceKey).toBe(expected);
    expect(sources.kind === "sources" && sources.workspaceKey).toBe(expected);
  });
});
