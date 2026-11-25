import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createTestJAgentDeskDaemon, DaemonClient } from "./test-utils/index.js";

test("background workspaces are opt-in for discovery and remain addressable by exact id", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jagentdesk-background-"));
  const daemon = await createTestJAgentDeskDaemon({ agentClients: {} });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    await client.connect();
    const added = await client.addProject(root);
    expect(added.error).toBeNull();
    const source = { kind: "directory" as const, path: root, projectId: added.project!.projectId };
    const visible = await client.createWorkspace({ source, title: "Visible" });
    const hidden = await client.createWorkspace({ source, title: "Background", background: true });
    expect(visible.error).toBeNull();
    expect(hidden.error).toBeNull();
    expect(hidden.workspace?.background).toBe(true);
    const filter = { projectId: added.project!.projectId };
    expect((await client.fetchWorkspaces({ filter })).entries.map((entry) => entry.id)).toEqual([
      visible.workspace!.id,
    ]);
    expect(
      (await client.fetchWorkspaces({ filter, includeBackground: true })).entries
        .map((entry) => entry.id)
        .sort(),
    ).toEqual([visible.workspace!.id, hidden.workspace!.id].sort());
    expect(
      (await client.fetchWorkspaces({ filter: { query: hidden.workspace!.id } })).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([hidden.workspace!.id]);
  } finally {
    await client.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  }
});
