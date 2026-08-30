import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestJAgentDeskDaemon } from "../test-utils/jagentdesk-daemon.js";
import {
  canRunRealProvider,
  createRealProviderClients,
  getRealProviderConfig,
} from "./real-provider-test-config.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-real-switch-provider-"));
}

function compactText(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function assistantMessages(items: AgentTimelineItem[]): string[] {
  return items
    .filter(
      (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
        item.type === "assistant_message",
    )
    .map((item) => item.text);
}

async function getAssistantText(client: DaemonClient, agentId: string): Promise<string> {
  const timeline = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  return assistantMessages(timeline.entries.map((entry) => entry.item)).join("\n");
}

// Switching an agent's provider mid-conversation must carry the prior context to
// the new provider (a native session is not portable, so the daemon replays the
// timeline as a chat-history seed on the next turn).
describe("daemon E2E (real claude + codex) - switch provider preserves context", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = (await canRunRealProvider("claude")) && (await canRunRealProvider("codex"));
  });

  beforeEach((context) => {
    if (!canRun) {
      context.skip();
    }
  });

  test("claude → codex keeps the conversation the new model can answer from", async () => {
    const logger = pino({ level: "silent" });
    const cwd = tmpCwd();
    const daemon = await createTestJAgentDeskDaemon({
      agentClients: createRealProviderClients(["claude", "codex"], logger),
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "switch-provider-real" } });

      // Establish context on the FIRST provider (claude).
      const agent = await client.createAgent({
        cwd,
        title: "switch-provider-real",
        ...getRealProviderConfig("claude"),
      });

      await client.sendMessage(
        agent.id,
        "Remember the code phrase JAGENTDESK_SWITCH_77. Reply exactly: ACK_77",
      );
      const firstFinish = await client.waitForFinish(agent.id, 180_000);
      expect(firstFinish.status).toBe("idle");
      expect(firstFinish.final?.lastError).toBeUndefined();
      expect(compactText(await getAssistantText(client, agent.id))).toContain("ack_77");

      // Switch to a DIFFERENT provider (codex), then keep chatting.
      await client.switchAgentProvider(agent.id, "codex", null);

      await client.sendMessage(
        agent.id,
        "What code phrase did I ask you to remember? Reply with that code phrase and nothing else.",
      );
      const secondFinish = await client.waitForFinish(agent.id, 180_000);
      expect(secondFinish.status).toBe("idle");
      expect(secondFinish.final?.lastError).toBeUndefined();

      // The NEW provider answered from the carried-over context.
      const assistantText = await getAssistantText(client, agent.id);
      expect(compactText(assistantText)).toContain("jagentdesk_switch_77");
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 420_000);
});
