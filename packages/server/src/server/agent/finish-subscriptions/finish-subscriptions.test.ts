import { AgentRunState, type ForegroundPromptStart } from "../agent-run-state.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentStorage } from "../agent-storage.js";
import { parseAgentMessages } from "../agent-messages/index.js";
import { configureAgentMessageDelivery, setupFinishNotification } from "../agent-prompt.js";
import {
  configureFinishSubscriptions,
  type FinishSubscriptionRecord,
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
  const pendingWakeup = { value: false };
  const listeners = new Set<(event: unknown) => void>();
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
    subscribe: vi.fn((listener: (event: unknown) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    hasPendingWakeup: vi.fn(() => pendingWakeup.value),
    onStop: vi.fn(() => () => {}),
    canSteer: vi.fn(() => false),
    getLastAssistantMessage: vi.fn(async () => "Child answer"),
  } as unknown as AgentManager;
  const agentStorage = {
    get: vi.fn(async (agentId: string) =>
      agentId === "child" ? { id: "child", title: "Child task", labels: {} } : null,
    ),
  } as unknown as AgentStorage;
  const emit = (event: unknown) => {
    for (const listener of listeners) listener(event);
  };
  return { agentManager, agentStorage, prompts, streamAgent, pendingWakeup, emit };
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

  test("after restart a completed child wakes the parent without a user prompt", async () => {
    const store = FinishSubscriptionStore.forHome(home, logger);
    await store.add({
      childAgentId: "child",
      callerAgentId: "parent",
      requireParentOwnership: false,
    });
    const after = createParentManager();
    const restored = await restoreFinishSubscriptions({
      agentManager: after.agentManager,
      store,
      isArchived: async () => false,
      reconcile: async (record) => {
        await setupFinishNotification({
          agentManager: after.agentManager,
          agentStorage: after.agentStorage,
          childAgentId: record.childAgentId,
          callerAgentId: record.callerAgentId,
          restoredSubscriptionId: record.id,
          logger,
        }).ready;
      },
      logger,
    });
    expect(restored).toBe(1);
    await vi.waitFor(() => expect(after.prompts).toHaveLength(1), { timeout: 5000 });
    expect(parseAgentMessages(String(after.prompts[0]))).toMatchObject([
      {
        source: { kind: "agent-notification", agentId: "child", event: "finished" },
        text: expect.stringContaining("Child answer"),
      },
    ]);
    await vi.waitFor(async () => expect(await store.list()).toEqual([]));
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
      reconcile: async () => {
        throw new Error("Archived parent must not be reconciled");
      },
      isArchived: async () => true,
      logger,
    });
    expect(restored).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  test("restored delivery retries a rejected parent start without dropping durable intent", async () => {
    const store = FinishSubscriptionStore.forHome(home, logger);
    await store.add({
      childAgentId: "child",
      callerAgentId: "parent",
      requireParentOwnership: false,
    });
    const after = createParentManager();
    configureAgentMessageDelivery(after.agentManager, { quietMs: 0 });
    after.streamAgent.mockImplementationOnce(() => {
      throw new Error("Provider start refused");
    });
    await restoreFinishSubscriptions({
      agentManager: after.agentManager,
      store,
      isArchived: async () => false,
      logger,
      reconcile: async (record, _signal, ids) => {
        await setupFinishNotification({
          agentManager: after.agentManager,
          agentStorage: after.agentStorage,
          childAgentId: record.childAgentId,
          callerAgentId: record.callerAgentId,
          restoredSubscriptionId: record.id,
          restoredSubscriptionIds: ids,
          logger,
        }).ready;
      },
    });
    await vi.waitFor(() => expect(after.streamAgent).toHaveBeenCalledTimes(1));
    expect(await store.list()).toHaveLength(1);
    await vi.waitFor(async () => expect(await store.list()).toEqual([]), { timeout: 5000 });
    expect(after.streamAgent).toHaveBeenCalledTimes(2);
    expect(after.prompts).toHaveLength(1);
  });

  test("restored registrations for the same pair share one acknowledged notification", async () => {
    const store = FinishSubscriptionStore.forHome(home, logger);
    for (let i = 0; i < 2; i++)
      await store.add({
        childAgentId: "child",
        callerAgentId: "parent",
        requireParentOwnership: false,
      });
    const after = createParentManager();
    configureAgentMessageDelivery(after.agentManager, { quietMs: 0 });
    const reconcile = vi.fn(
      async (record: FinishSubscriptionRecord, _signal: AbortSignal, ids: readonly string[]) => {
        await setupFinishNotification({
          agentManager: after.agentManager,
          agentStorage: after.agentStorage,
          childAgentId: record.childAgentId,
          callerAgentId: record.callerAgentId,
          restoredSubscriptionId: record.id,
          restoredSubscriptionIds: ids,
          logger,
        }).ready;
      },
    );
    expect(
      await restoreFinishSubscriptions({
        agentManager: after.agentManager,
        store,
        reconcile,
        isArchived: async () => false,
        logger,
      }),
    ).toBe(2);
    await vi.waitFor(async () => expect(await store.list()).toEqual([]));
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(after.prompts).toHaveLength(1);
  });
});

describe("following a child that ended its turn while still working (Paseo #10864)", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "jagentdesk-finish-following-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function restoreFollowing(after: ReturnType<typeof createParentManager>) {
    const store = FinishSubscriptionStore.forHome(home, logger);
    const reconcile = vi.fn(
      async (record: FinishSubscriptionRecord, _signal: AbortSignal, ids: readonly string[]) => {
        await setupFinishNotification({
          agentManager: after.agentManager,
          agentStorage: after.agentStorage,
          childAgentId: record.childAgentId,
          callerAgentId: record.callerAgentId,
          restoredSubscriptionId: record.id,
          restoredSubscriptionIds: ids,
          restoredFollowingSince: record.followingSince,
          logger,
        }).ready;
      },
    );
    await restoreFinishSubscriptions({
      agentManager: after.agentManager,
      store,
      reconcile,
      isArchived: async () => false,
      logger,
    });
    return { store, reconcile };
  }

  test("a restored follow resumes silently and reports finished once the work drains", async () => {
    const saved = FinishSubscriptionStore.forHome(home, logger);
    const id = await saved.add({
      childAgentId: "child",
      callerAgentId: "parent",
      requireParentOwnership: false,
    });
    const since = new Date().toISOString();
    await saved.markFollowing([id], since);

    const after = createParentManager();
    configureAgentMessageDelivery(after.agentManager, { quietMs: 0 });
    after.pendingWakeup.value = true;
    const { store, reconcile } = await restoreFollowing(after);
    expect(reconcile.mock.calls[0]![0]).toMatchObject({ followingSince: since });

    // The still-working notice was sent before the restart; it is not repeated.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(after.prompts).toEqual([]);
    expect(await store.list()).toHaveLength(1);

    after.pendingWakeup.value = false;
    after.emit({ type: "background_work", agentId: "child", items: [] });
    await vi.waitFor(() => expect(after.prompts).toHaveLength(1));
    expect(parseAgentMessages(String(after.prompts[0]))).toMatchObject([
      {
        source: { kind: "agent-notification", agentId: "child", event: "finished" },
        text: expect.stringContaining("Child answer"),
      },
    ]);
    await vi.waitFor(async () => expect(await store.list()).toEqual([]));
  });

  test("a restored follow past the follow limit ends with an is-still-working notice", async () => {
    const saved = FinishSubscriptionStore.forHome(home, logger);
    const id = await saved.add({
      childAgentId: "child",
      callerAgentId: "parent",
      requireParentOwnership: false,
    });
    await saved.markFollowing([id], new Date(Date.now() - 25 * 60 * 60_000).toISOString());

    const after = createParentManager();
    configureAgentMessageDelivery(after.agentManager, { quietMs: 0 });
    after.pendingWakeup.value = true;
    const { store } = await restoreFollowing(after);

    await vi.waitFor(() => expect(after.prompts).toHaveLength(1));
    expect(parseAgentMessages(String(after.prompts[0]))).toMatchObject([
      {
        source: { kind: "agent-notification", agentId: "child", event: "message" },
        text: expect.stringContaining(
          "Agent child (Child task) is still working: background work that will wake it.",
        ),
      },
    ]);
    await vi.waitFor(async () => expect(await store.list()).toEqual([]));
  });

  test("a restored child with pending work starts following and tells the caller once", async () => {
    const saved = FinishSubscriptionStore.forHome(home, logger);
    await saved.add({
      childAgentId: "child",
      callerAgentId: "parent",
      requireParentOwnership: false,
    });

    const after = createParentManager();
    configureAgentMessageDelivery(after.agentManager, { quietMs: 0 });
    after.pendingWakeup.value = true;
    const { store } = await restoreFollowing(after);

    await vi.waitFor(() => expect(after.prompts).toHaveLength(1));
    expect(parseAgentMessages(String(after.prompts[0]))).toMatchObject([
      {
        source: { kind: "agent-notification", agentId: "child", event: "message" },
        text: expect.stringContaining("ended its turn but is still working"),
      },
    ]);
    await vi.waitFor(async () =>
      expect(await FinishSubscriptionStore.forHome(home, logger).list()).toMatchObject([
        { childAgentId: "child", followingSince: expect.any(String) },
      ]),
    );
    expect(await store.list()).toHaveLength(1);
  });
});
