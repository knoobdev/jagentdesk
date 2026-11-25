import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "./test-utils/index.js";
import { createTestJAgentDeskDaemon } from "./test-utils/jagentdesk-daemon.js";

test("workspace retries retain their resource while edited requests use a new identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jagentdesk-workspace-receipt-"));
  const daemon = await createTestJAgentDeskDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.9.59",
  });
  try {
    await client.connect();
    const request = {
      idempotencyKey: "draft-original",
      source: { kind: "directory" as const, path: directory },
      title: "Original",
    };
    const first = await client.createWorkspace(request);
    expect(first.error).toBeNull();
    const replay = await client.createWorkspace(request);
    expect(replay.error).toBeNull();
    expect(replay.workspace?.id).toBe(first.workspace?.id);
    const conflict = await client.createWorkspace({ ...request, title: "Edited" });
    expect(conflict.workspace).toBeNull();
    expect(conflict.error).toBe("workspace_request_key_conflict");
    const edited = await client.createWorkspace({
      ...request,
      idempotencyKey: "draft-edited",
      title: "Edited",
    });
    expect(edited.error).toBeNull();
    expect(edited.workspace?.id).not.toBe(first.workspace?.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
