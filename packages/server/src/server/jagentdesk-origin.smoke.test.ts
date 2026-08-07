import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";

import { createTestJAgentDeskDaemon } from "./test-utils/jagentdesk-daemon.js";

describe("JAgentDesk desktop WebSocket origin", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("accepts the packaged renderer origin", async () => {
    const daemonHandle = await createTestJAgentDeskDaemon();
    const ws = new WebSocket(`ws://127.0.0.1:${daemonHandle.port}/ws`, {
      headers: { Origin: "jagentdesk://app" },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
      await daemonHandle.close();
    }
  });
});
