import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOBS_KEPT, RemoteJobStore } from "./job-store.js";
import type { RemoteJob } from "./types.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-store-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeJob(id: string, overrides?: Partial<RemoteJob>): RemoteJob {
  return {
    id,
    serverId: "srv",
    serverLabel: "Server",
    workspacePath: "/ws",
    workspaceKey: "wsk_1",
    snapshotId: null,
    command: "true",
    status: "succeeded",
    exitCode: 0,
    error: null,
    agentId: null,
    sync: null,
    outputBytes: 0,
    outputTruncated: false,
    createdAtMs: 1000,
    startedAtMs: null,
    finishedAtMs: null,
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe("RemoteJobStore", () => {
  it("persists jobs atomically with 0600 file mode and reloads them", async () => {
    const filePath = path.join(dir, "jobs.json");
    const store = new RemoteJobStore(filePath);
    await store.ensureLoaded();
    await store.upsert(makeJob("rjb_1", { status: "running" }));

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);

    const reloaded = new RemoteJobStore(filePath);
    await reloaded.ensureLoaded();
    expect(reloaded.get("rjb_1")?.status).toBe("running");
  });

  it("keeps the newest 200 jobs by createdAtMs", async () => {
    const store = new RemoteJobStore(path.join(dir, "jobs.json"));
    await store.ensureLoaded();
    for (let i = 0; i < JOBS_KEPT + 5; i += 1) {
      await store.upsert(makeJob(`rjb_${i}`, { createdAtMs: i }));
    }
    expect(store.list().length).toBe(JOBS_KEPT);
    expect(store.get("rjb_0")).toBeNull(); // oldest pruned
    expect(store.get(`rjb_${JOBS_KEPT + 4}`)).not.toBeNull(); // newest kept
    expect(store.list()[0].id).toBe(`rjb_${JOBS_KEPT + 4}`); // newest first
  });

  it("updates in place and lists newest first", async () => {
    const store = new RemoteJobStore(path.join(dir, "jobs.json"));
    await store.ensureLoaded();
    await store.upsert(makeJob("rjb_1", { createdAtMs: 1 }));
    await store.upsert(makeJob("rjb_2", { createdAtMs: 2 }));
    await store.upsert(makeJob("rjb_1", { status: "failed", exitCode: 3, createdAtMs: 1 }));
    expect(store.list().map((job) => job.id)).toEqual(["rjb_2", "rjb_1"]);
    expect(store.get("rjb_1")?.status).toBe("failed");
  });

  it("finds the active job for a (serverId, workspaceKey) pair", async () => {
    const store = new RemoteJobStore(path.join(dir, "jobs.json"));
    await store.ensureLoaded();
    await store.upsert(makeJob("rjb_done", { status: "succeeded" }));
    await store.upsert(makeJob("rjb_running", { status: "running", workspaceKey: "wsk_1" }));
    await store.upsert(makeJob("rjb_other", { status: "running", workspaceKey: "wsk_2" }));
    expect(store.findActive("srv", "wsk_1")?.id).toBe("rjb_running");
    expect(store.findActive("srv", "wsk_3")).toBeNull();
    expect(store.findActive("other", "wsk_1")).toBeNull();
  });

  it("treats a missing or corrupt file as empty", async () => {
    const store = new RemoteJobStore(path.join(dir, "missing.json"));
    await store.ensureLoaded();
    expect(store.list()).toEqual([]);
    const corrupt = path.join(dir, "corrupt.json");
    await fs.writeFile(corrupt, "{not json");
    const broken = new RemoteJobStore(corrupt);
    await broken.ensureLoaded();
    expect(broken.list()).toEqual([]);
  });
});
