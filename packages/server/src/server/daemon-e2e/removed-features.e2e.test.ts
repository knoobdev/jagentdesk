import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebSocket } from "ws";
import { expect, test } from "vitest";
import { createTestJAgentDeskDaemon } from "../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

// ADR-0050 removal regression: legacy requests use the ordinary unknown-request path,
// and an existing forums directory is neither loaded nor removed.
test("rejects retired RPCs and preserves retired data across daemon startup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "jad-retired-feature-"));
  const dataDir = path.join(root, ".jagentdesk", "forums");
  const dataFile = path.join(dataDir, "existing.json");
  await mkdir(dataDir, { recursive: true });
  await writeFile(dataFile, "existing user data\n");
  try {
    const daemon = await createTestJAgentDeskDaemon({
      jagentdeskHomeRoot: root,
      staticDir: path.join(root, "static"),
      daemonVersion: "0.9.59",
      cleanup: false,
    });
    let socket!: WebSocket;
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      onWebSocket: (value) => {
        socket = value;
      },
    });
    try {
      await client.connect();
      for (const [index, requestType] of [
        "forum/list",
        "forum.diagram.html.request",
        "forum.unknown.request",
      ].entries()) {
        const requestId = `retired-${index}`;
        const response = new Promise<unknown>((resolve) => {
          const unsubscribe = client.on("rpc_error", (message) => {
            if (message.payload.requestId === requestId) {
              unsubscribe();
              resolve(message.payload);
            }
          });
        });
        socket.send(JSON.stringify({ type: "session", message: { type: requestType, requestId } }));
        expect(await response).toEqual({
          requestId,
          requestType,
          code: "unknown_schema",
          error: `Unknown request, try upgrading the daemon (currently v0.9.59)`,
        });
      }
      // A rejected retired RPC leaves the connection usable by the retained control plane.
      expect((await client.getOrchestrationConfig()).config.enabled).toBe(true);
    } finally {
      await client.close();
      await daemon.close();
    }
    expect(await readFile(dataFile, "utf8")).toBe("existing user data\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
