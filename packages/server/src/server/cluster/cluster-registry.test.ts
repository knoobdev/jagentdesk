import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClusterRegistry } from "./cluster-registry.js";

describe("ClusterRegistry persistence", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "jad-clusters-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reuses the same id for a context across re-imports (stable ids)", () => {
    const reg = new ClusterRegistry({ jagentdeskHome: home });
    const first = reg.importContext("gke_ctx-a", "Cluster A");
    const again = reg.importContext("gke_ctx-a", "Cluster A");
    expect(again.id).toBe(first.id);
    expect(reg.list()).toHaveLength(1);
  });

  it("persists cluster identity and reloads it on a fresh registry (survives restart)", async () => {
    const reg = new ClusterRegistry({ jagentdeskHome: home });
    const created = reg.importContext("gke_ctx-b", "Cluster B");
    // Let the atomic persist flush.
    await new Promise((r) => setTimeout(r, 50));

    const reloaded = new ClusterRegistry({ jagentdeskHome: home });
    await reloaded.initialize();
    const list = reloaded.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);
    expect(list[0].contextName).toBe("gke_ctx-b");
    expect(list[0].displayName).toBe("Cluster B");
    // Reloaded clusters start "saved" (the live connection is re-established).
    expect(list[0].state).toBe("saved");

    // A re-import after restart keeps the persisted id, not a fresh one.
    expect(reloaded.importContext("gke_ctx-b").id).toBe(created.id);
  });

  it("is a no-op store without a home (in-memory only, no throw)", async () => {
    const reg = new ClusterRegistry();
    await reg.initialize();
    const c = reg.importContext("ctx", "C");
    expect(reg.list().map((x) => x.id)).toEqual([c.id]);
  });
});
