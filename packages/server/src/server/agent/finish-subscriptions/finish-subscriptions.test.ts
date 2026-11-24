import { AgentRunState, type ForegroundPromptStart } from "../agent-run-state.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import { parseAgentMessages } from "../agent-messages/index.js";
import { sendPromptToAgent, setupFinishNotification } from "../agent-prompt.js";
import {
  configureFinishSubscriptions,
  FINISH_SUBSCRIPTIONS_FILE,
  FinishSubscriptionStore,
  restoreFinishSubscriptions,
} from "./index.js";

const logger = createTestLogger();

function createParentManager() {
  const parent = { id: "parent", provider: "codex", lifecycle: "idle", config: {} };
  const child = {
    id: "child",
    provider: "codex",
    lifecycle: "idle",
    config: {},
    pendingPermissions: new Map(),
  };
  const prompts: unknown[] = [];
  const streamAgent = vi.fn(
    (_agentId: string, prompt: unknown, _options: unknown, promptStart?: ForegroundPromptStart) => {
      if (promptStart) {
        const runs = new AgentRunState();
        const run = runs.createPendingRun(_agentId);
        promptStart.bind(run);
        runs.settleForegroundStart(run, { status: "started", turnId: "turn-1" });
      }
      prompts.push(prompt);
      return (async function* noop() {})();
    },
  );
  const agentManager = {
    getAgent: vi.fn((agentId: string) => ({ parent, child })[agentId] ?? null),
    reloadStalePluginSession: vi.fn(async () => {}),
    tryRunOutOfBand: vi.fn(() => false),
    hasInFlightRun: vi.fn(() => false),
    hasPendingPermissions: vi.fn(() => false),
    replaceAgentRun: vi.fn(),
    streamAgent,
    subscribe: vi.fn(() => () => {}),
  } as unknown as AgentManager;
  const agentStorage = {
    get: vi.fn(async (agentId: string) =>
      agentId === "child" ? { id: "child", title: "Child task", labels: {} } : null,
    ),
  } as unknown as AgentStorage;
  return { agentManager, agentStorage, prompts, streamAgent };
}

describe("durable finish subscriptions", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "jagentdesk-finish-subscriptions-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("a subscription is written to $JAGENTDESK_HOME and survives a restart", async () => {
    const before = createParentManager();
    configureFinishSubscriptions(
      before.agentManager,
      FinishSubscriptionStore.forHome(home, logger),
    );
    setupFinishNotification({
      agentManager: before.agentManager,
      agentStorage: before.agentStorage,
      childAgentId: "child",
      callerAgentId: "parent",
      waitForTurnStart: true,
      logger,
    });

    await vi.waitFor(async () => {
      const file = JSON.parse(await readFile(join(home, FINISH_SUBSCRIPTIONS_FILE), "utf8"));
      expect(file.subscriptions).toMatchObject([
        { childAgentId: "child", callerAgentId: "parent", requireParentOwnership: false },
      ]);
    });

    // A new daemon process reads the same file.
    const records = await FinishSubscriptionStore.forHome(home, logger).list();
    expect(records).toHaveLength(1);
  });

  test("after a restart the parent is not woken; the notification rides its next turn", async () => {
    const store = FinishSubscriptionStore.forHome(home, logger);
    await store.add({
      childAgentId: "child",
      callerAgentId: "parent",
      requireParentOwnership: true,
    });

    const after = createParentManager();
    const restored = await restoreFinishSubscriptions({
      agentManager: after.agentManager,
      store: FinishSubscriptionStore.forHome(home, logger),
      getAgentTitle: async () => "Child task",
      isArchived: async () => false,
      logger,
    });
    expect(restored).toBe(1);
    // No model turn was started for the parent.
    expect(after.streamAgent).not.toHaveBeenCalled();

    await sendPromptToAgent({
      agentManager: after.agentManager,
      agentStorage: after.agentStorage,
      agentId: "parent",
      prompt: "What's next?",
      messageId: "user-msg-1",
      logger,
    });

    expect(after.prompts).toHaveLength(1);
    const messages = parseAgentMessages(after.prompts[0] as string);
    expect(messages).toMatchObject([
      {
        source: { kind: "agent-notification", agentId: "child", event: "closed" },
        text: expect.stringContaining("daemon restarted"),
      },
      { id: "user-msg-1", source: null, text: "What's next?" },
    ]);
    // Delivered with the turn, so the record is gone and the next turn is plain.
    await vi.waitFor(async () =>
      expect(await FinishSubscriptionStore.forHome(home, logger).list()).toEqual([]),
    );
    await sendPromptToAgent({
      agentManager: after.agentManager,
      agentStorage: after.agentStorage,
      agentId: "parent",
      prompt: "And then?",
      logger,
    });
    expect(after.prompts[1]).toBe("And then?");
  });

  test("subscriptions of archived parents are dropped on restore", async () => {
    const store = FinishSubscriptionStore.forHome(home, logger);
    await store.add({
      childAgentId: "child",
      callerAgentId: "parent",
      requireParentOwnership: true,
    });
    const after = createParentManager();
    const restored = await restoreFinishSubscriptions({
      agentManager: after.agentManager,
      store,
      getAgentTitle: async () => null,
      isArchived: async () => true,
      logger,
    });
    expect(restored).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  test("a command leaves restart notifications for the next model turn", async () => {
    const store = FinishSubscriptionStore.forHome(home, logger);
    await store.add({
      childAgentId: "child",
      callerAgentId: "parent",
      requireParentOwnership: false,
    });
    const after = createParentManager();
    await restoreFinishSubscriptions({
      agentManager: after.agentManager,
      store,
      getAgentTitle: async () => "Child task",
      isArchived: async () => false,
      logger,
    });
    after.agentManager.tryRunOutOfBand = vi.fn(async () => true);
    expect(
      await sendPromptToAgent({
        agentManager: after.agentManager,
        agentStorage: after.agentStorage,
        agentId: "parent",
        prompt: "/goal pause",
        logger,
      }),
    ).toEqual({ disposition: "out_of_band" });
    expect(after.streamAgent).not.toHaveBeenCalled();
    expect(await store.list()).toHaveLength(1);

    after.agentManager.tryRunOutOfBand = vi.fn(async () => false);
    await sendPromptToAgent({
      agentManager: after.agentManager,
      agentStorage: after.agentStorage,
      agentId: "parent",
      prompt: "Continue",
      logger,
    });
    expect(parseAgentMessages(String(after.prompts[0]))).toMatchObject([
      { source: { agentId: "child", event: "closed" } },
      { source: null, text: "Continue" },
    ]);
    expect(await store.list()).toEqual([]);
  });

  test("a rejected parent dispatch keeps its notification for a retry", async () => {
    const store = FinishSubscriptionStore.forHome(home, logger);
    await store.add({
      childAgentId: "child",
      callerAgentId: "parent",
      requireParentOwnership: false,
    });
    const after = createParentManager();
    await restoreFinishSubscriptions({
      agentManager: after.agentManager,
      store,
      getAgentTitle: async () => "Child task",
      isArchived: async () => false,
      logger,
    });
    after.streamAgent.mockImplementationOnce(() => {
      throw new Error("Dispatch rejected");
    });
    const send = () =>
      sendPromptToAgent({
        agentManager: after.agentManager,
        agentStorage: after.agentStorage,
        agentId: "parent",
        prompt: "Continue",
        logger,
      });
    await expect(send()).rejects.toThrow("Dispatch rejected");
    expect(await store.list()).toHaveLength(1);
    await send();
    expect(parseAgentMessages(String(after.prompts[0]))).toMatchObject([
      { source: { agentId: "child", event: "closed" } },
      { source: null, text: "Continue" },
    ]);
    expect(await store.list()).toEqual([]);
  });
});
