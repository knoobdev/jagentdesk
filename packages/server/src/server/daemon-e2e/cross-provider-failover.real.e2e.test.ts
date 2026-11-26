import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";
import { OpenCodeRuntimeClient } from "../agent/providers/opencode/runtime-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestJAgentDeskDaemon } from "../test-utils/jagentdesk-daemon.js";

/** Real Codex, Claude and OpenCode with their own local sign-in (no OpenRouter key). */
function hasBinary(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type Daemon = Awaited<ReturnType<typeof createTestJAgentDeskDaemon>>;

async function timelineItems(client: DaemonClient, agentId: string): Promise<AgentTimelineItem[]> {
  const timeline = await client.fetchAgentTimeline(agentId, {
    direction: "tail",
    limit: 0,
    projection: "canonical",
  });
  return timeline.entries.map((entry) => entry.item as AgentTimelineItem);
}

async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out after ${timeoutMs} ms`);
}

async function waitForCodexAnswer(client: DaemonClient, agentId: string, word: string) {
  return waitFor(async () => {
    const result = await client.fetchAgent(agentId);
    if (result?.agent.provider !== "codex" || result.agent.status !== "idle") return null;
    const items = await timelineItems(client, agentId);
    const answer = items.findLast((item) => item.type === "assistant_message");
    return answer?.type === "assistant_message" && answer.text.toLowerCase().includes(word)
      ? items
      : null;
  }, 300_000).catch(async (error) => {
    const result = await client.fetchAgent(agentId);
    console.log(
      "agent at timeout:",
      result?.agent.provider,
      result?.agent.status,
      result?.agent.lastError,
    );
    console.log(
      "timeline at timeout:",
      JSON.stringify(await timelineItems(client, agentId)).slice(-4000),
    );
    throw error;
  });
}

async function findUsageLimitRow(client: DaemonClient, agentId: string) {
  const items = await timelineItems(client, agentId);
  const row = items.find((item) => item.type === "notification" && item.usageLimit);
  return row?.type === "notification" ? row : null;
}

function sendFailingTurn(client: DaemonClient, agentId: string, kind: string, word: string) {
  return client.sendMessage(
    agentId,
    `emit synthetic ${kind} failure. Then reply with the single word ${word} and nothing else.`,
  );
}

// Spec 40 A40.5 and A40.6: the mock provider stands in for a provider out of quota (no real
// provider can be forced to report a usage limit); Codex is real.
describe("daemon E2E (mock + real codex) - usage-limit failover", () => {
  let canRun = false;
  let daemon: Daemon;
  let client: DaemonClient;
  const cwd = mkdtempSync(path.join(tmpdir(), "daemon-real-failover-"));

  beforeAll(async () => {
    canRun = hasBinary("codex");
    if (!canRun) return;
    const logger = pino({ level: "silent" });
    daemon = await createTestJAgentDeskDaemon({
      agentClients: {
        mock: new MockLoadTestAgentClient(),
        codex: new CodexAppServerAgentClient(logger),
      },
      // The mock provider is a dev-only provider.
      isDev: true,
      logger,
    });
    // A current app version, so the dev-only mock provider is visible to this client.
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.10.2" });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "failover-real" } });
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  });

  beforeEach((context) => {
    if (!canRun) context.skip();
  });

  async function createMockAgent(title: string) {
    const agent = await client.createAgent({
      cwd,
      title,
      provider: "mock",
      model: "e2e-fast-stream",
    });
    for (const text of ["turn one", "turn two"]) {
      await client.sendMessage(agent.id, text);
      const finish = await client.waitForFinish(agent.id, 60_000);
      expect({ status: finish.status, error: finish.final?.lastError }).toEqual({
        status: "idle",
        error: undefined,
      });
    }
    return agent;
  }

  test("A40.5: a usage limit on turn 3 fails over to Codex and resends turn 3", async () => {
    await client.patchDaemonConfig({
      agentFailover: { enabled: true, order: [{ provider: "codex", model: null }] },
    });
    const agent = await createMockAgent("failover-on");
    await sendFailingTurn(client, agent.id, "usage limit", "PINEAPPLE");
    const items = await waitForCodexAnswer(client, agent.id, "pineapple");

    const failoverRow = items.find(
      (item) => item.type === "notification" && item.providerSwitch?.reason === "failover",
    );
    expect(failoverRow?.type === "notification" ? failoverRow.message : "").toMatch(
      /hit its usage limit — switched to Codex/,
    );
    const turnThree = items.filter(
      (item) => item.type === "user_message" && item.text.includes("PINEAPPLE"),
    );
    // The original turn 3 and its resend carry the same text.
    expect(turnThree).toHaveLength(2);
  }, 420_000);

  test("A40.5: a network failure does not fail over", async () => {
    await client.patchDaemonConfig({
      agentFailover: { enabled: true, order: [{ provider: "codex", model: null }] },
    });
    const agent = await createMockAgent("network-failure");
    await sendFailingTurn(client, agent.id, "network", "MANGO");
    await client.waitForFinish(agent.id, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const result = await client.fetchAgent(agent.id);
    expect(result?.agent.provider).toBe("mock");
    const items = await timelineItems(client, agent.id);
    expect(items.some((item) => item.type === "notification" && item.providerSwitch)).toBe(false);
    expect(items.some((item) => item.type === "notification" && item.usageLimit)).toBe(false);
  }, 120_000);

  test("A40.6: with failover off the usage-limit row offers Continue with Codex", async () => {
    await client.patchDaemonConfig({
      agentFailover: { enabled: false, order: [{ provider: "codex", model: null }] },
    });
    const agent = await createMockAgent("failover-off");
    await sendFailingTurn(client, agent.id, "usage limit", "PAPAYA");
    const notice = await waitFor(() => findUsageLimitRow(client, agent.id), 60_000);
    expect(notice.message).toBe("Mock Load Test usage limit reached");
    expect(notice.usageLimit).toEqual({
      provider: "mock",
      failover: "off",
      suggestion: { provider: "codex", model: null },
    });
    expect((await client.fetchAgent(agent.id))?.agent.provider).toBe("mock");

    // The card's button.
    await client.continueAgentWithProvider(agent.id, { provider: "codex", model: null });
    await waitForCodexAnswer(client, agent.id, "papaya");
  }, 420_000);
});

// Spec 40 A40.7 on a real Claude parent and real OpenCode child.
describe("daemon E2E (real claude + opencode) - cross-provider children", () => {
  let canRun = false;
  let daemon: Daemon;
  let client: DaemonClient;
  let opencodeModel = "";
  const cwd = mkdtempSync(path.join(tmpdir(), "daemon-real-children-"));

  beforeAll(async () => {
    canRun = hasBinary("claude") && hasBinary("opencode");
    if (!canRun) return;
    const logger = pino({ level: "silent" });
    daemon = await createTestJAgentDeskDaemon({
      agentClients: {
        claude: new ClaudeAgentClient({ logger }),
        opencode: new OpenCodeRuntimeClient(logger),
      },
      logger,
    });
    // A current app version, so the dev-only mock provider is visible to this client.
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.10.2" });
    await client.connect();
    await client.fetchAgents({ subscribe: { subscriptionId: "children-real" } });
    const models = await client.listProviderModels("opencode", { cwd });
    const ids = (models.models ?? []).map((model) => model.id);
    console.log("opencode models:", models.error ?? "", ids.slice(0, 40).join(" "));
    opencodeModel =
      process.env.JAGENTDESK_E2E_OPENCODE_MODEL ??
      ids.find((id) => /^openai\/.*mini/.test(id)) ??
      ids[0] ??
      "";
  });

  afterAll(async () => {
    await client?.close().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
    rmSync(cwd, { recursive: true, force: true });
  });

  beforeEach((context) => {
    if (!canRun) context.skip();
  });

  async function childrenOf(parentId: string) {
    const listed = await client.fetchAgents({ includeBackground: true });
    return listed.entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.id !== parentId && agent.cwd === cwd);
  }

  async function claudeParent(title: string) {
    return client.createAgent({
      cwd,
      title,
      provider: "claude",
      model: "haiku",
      modeId: "bypassPermissions",
    });
  }

  test("A40.7: an allowed child runs on OpenCode; a provider outside the list is refused; off keeps Claude", async () => {
    expect(opencodeModel).not.toBe("");
    await client.patchDaemonConfig({
      crossProviderChildren: {
        enabled: true,
        allowed: [{ provider: "opencode", model: opencodeModel }],
      },
    });
    const parent = await claudeParent("children-on");
    await client.sendMessage(
      parent.id,
      "Call list_child_providers. Then call create_agent with provider set to the suggested entry " +
        "as <provider>/<model> and initialPrompt 'Reply with the single word KIWI.' Do not wait " +
        "for it. Then reply DONE.",
    );
    expect((await client.waitForFinish(parent.id, 240_000)).status).toBe("idle");
    const allowedChildren = await childrenOf(parent.id);
    expect(allowedChildren.map((agent) => agent.provider)).toEqual(["opencode"]);

    await client.sendMessage(
      parent.id,
      "Call create_agent with provider exactly 'codex/gpt-5.4' and initialPrompt 'hi'. Quote the " +
        "tool's error message verbatim in your reply.",
    );
    expect((await client.waitForFinish(parent.id, 240_000)).status).toBe("idle");
    const items = await timelineItems(client, parent.id);
    const refused = items.some(
      (item) =>
        (item.type === "tool_call" &&
          JSON.stringify(item).includes("not an allowed child provider")) ||
        (item.type === "assistant_message" && item.text.includes("not an allowed child provider")),
    );
    expect(refused).toBe(true);
    expect((await childrenOf(parent.id)).map((agent) => agent.provider)).toEqual(["opencode"]);

    await client.patchDaemonConfig({
      crossProviderChildren: { enabled: false, allowed: [] },
    });
    const offParent = await claudeParent("children-off");
    await client.sendMessage(
      offParent.id,
      "Create exactly one child agent with create_agent and initialPrompt 'Reply OK.' If the tool " +
        "refuses a provider, follow its instructions and try once more. Do not wait. Reply DONE.",
    );
    expect((await client.waitForFinish(offParent.id, 240_000)).status).toBe("idle");
    const earlier = new Set([parent.id, ...allowedChildren.map((child) => child.id)]);
    const offChildren = (await childrenOf(offParent.id)).filter((agent) => !earlier.has(agent.id));
    expect(offChildren.map((agent) => agent.provider)).toEqual(["claude"]);
  }, 900_000);
});
