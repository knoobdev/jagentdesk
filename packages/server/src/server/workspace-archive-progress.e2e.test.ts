import { expect, test } from "vitest";
import { createJAgentDeskApi } from "@jagentdesk/client";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createTestJAgentDeskDaemon } from "./test-utils/jagentdesk-daemon.js";

test("another session lists and receives the archiving timestamp during agent teardown", async () => {
  const teardownStarted = Promise.withResolvers<void>();
  const teardownReleased = Promise.withResolvers<void>();
  const daemon = await createTestJAgentDeskDaemon({
    agentClients: createTestAgentClients({
      closeSession: async () => {
        teardownStarted.resolve();
        await teardownReleased.promise;
      },
    }),
  });
  const url = `ws://127.0.0.1:${daemon.port}/ws`;
  const initiator = new DaemonClient({ url });
  const observer = new DaemonClient({ url });
  const jagentdesk = createJAgentDeskApi(observer);

  try {
    await Promise.all([initiator.connect(), observer.connect()]);
    const created = await initiator.createWorkspace({
      source: { kind: "directory", path: daemon.staticDir },
    });
    if (!created.workspace) throw new Error(created.error ?? "Failed to create workspace");
    const workspaceId = created.workspace.id;
    await initiator.createAgent({ provider: "codex", cwd: daemon.staticDir, workspaceId });

    const initial = await jagentdesk.workspaces.list({ subscribe: {} });
    expect(initial.entries.find((entry) => entry.id === workspaceId)?.archivingAt).toBeNull();
    const timestamps: Array<string | null> = [];
    initial.subscription.subscribe({
      snapshot: () => {},
      update: ({ type, payload }) => {
        if (
          type === "workspace_update" &&
          payload.kind === "upsert" &&
          payload.workspace.id === workspaceId
        ) {
          timestamps.push(payload.workspace.archivingAt);
        }
      },
    });

    const archive = initiator.archiveWorkspace(workspaceId);
    try {
      await Promise.race([
        teardownStarted.promise,
        archive.then(() => {
          throw new Error("Archive completed before agent teardown started");
        }),
      ]);

      const initiating = await initiator.fetchWorkspaces();
      const archivingAt = initiating.entries.find((entry) => entry.id === workspaceId)?.archivingAt;
      expect(archivingAt).toEqual(expect.any(String));

      const observed = await jagentdesk.workspaces.list();
      expect(observed.entries.find((entry) => entry.id === workspaceId)?.archivingAt).toBe(
        archivingAt,
      );
      expect(timestamps).toContain(archivingAt);
    } finally {
      teardownReleased.resolve();
      await archive;
    }
  } finally {
    teardownReleased.resolve();
    await jagentdesk.dispose();
    await Promise.all([initiator.close(), observer.close()]);
    await daemon.close();
  }
}, 60_000);
