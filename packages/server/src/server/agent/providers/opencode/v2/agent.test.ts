import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FormInfo, ModelInfo, SessionInfo, SessionMessageInfo } from "@opencode/client";
import { describe, expect, test } from "vitest";

import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import { ProviderSubagentStore } from "../../../provider-subagents/store.js";
import { OpenCodeV2AgentClient } from "./agent.js";
import { V2Harness } from "../test-utils/v2-harness.js";
import type { V2Api } from "./api.js";
import { V2Runtime, type V2RuntimeAcquireOptions } from "./runtime.js";
import { OpenCodeBridge } from "../bridge.js";
import { writeStdioMcpFixture } from "../test-utils/mcp-fixtures.js";

function terminalEvents(events: AgentStreamEvent[]) {
  return events.filter(
    (event) =>
      event.type === "turn_completed" ||
      event.type === "turn_failed" ||
      event.type === "turn_canceled",
  );
}

describe("OpenCode v2 session lifecycle", () => {
  test("reopening replaces and removes plugin instructions", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const created = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      pluginAppendSystemPrompt: ["first"],
    });
    expect(harness.instructions.get("jagentdesk")).toBe("first");
    const handle = created.describePersistence()!;
    await created.close();
    const resumed = await client.resumeSession(handle, {
      cwd: "/tmp/project",
      pluginAppendSystemPrompt: ["changed"],
    });
    expect(harness.instructions.get("jagentdesk")).toBe("changed");
    await resumed.close();
    const cleared = await client.resumeSession(handle, {
      cwd: "/tmp/project",
      pluginAppendSystemPrompt: undefined,
    });
    expect(harness.instructions.has("jagentdesk")).toBe(false);
    await cleared.close();
  });

  test("opening history does not change an existing session instruction", async () => {
    const harness = new V2Harness();
    harness.instructions.set("jagentdesk", "Existing plugin instruction");
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.resumeSession(
      { provider: "opencode", sessionId: "session", metadata: { cwd: "/tmp/project" } },
      { cwd: "/tmp/project" },
      undefined,
      { purpose: "history" },
    );
    try {
      expect(harness.instructions.get("jagentdesk")).toBe("Existing plugin instruction");
    } finally {
      await session.close();
    }
  });

  test("refreshes the existing location before reading a forced catalog", async () => {
    const harness = new V2Harness();
    const refreshed: string[] = [];
    harness.connection.refreshLocation = async (directory) => {
      refreshed.push(directory);
    };
    harness.api.model.list = async () => ({ location: harness.info.location, data: [] });
    harness.api.provider.list = async () => ({
      location: harness.info.location,
      data: [{ id: "test", name: "Test", activation: "enabled", package: "test" }],
    });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/project", force: true });
    await client.fetchCatalog({ scope: "workspace", cwd: "/tmp/project", force: false });
    expect(refreshed).toEqual(["/tmp/project"]);
    await client.shutdown();
  });
  test("completes from execution events without a long-lived HTTP wait", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.startExecution();
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("long-running work");
      await expect.poll(() => harness.prompts).toEqual(["long-running work"]);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
      expect(events.filter((event) => event.type === "turn_completed")).toEqual([]);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(events.filter((event) => event.type === "turn_failed")).toEqual([]);
    } finally {
      await session.close();
    }
  });
  test.each(["reconnect", "watchdog"])(
    "recovers a missed completion through %s without reconnecting a quiet stream",
    async (recovery) => {
      const harness = new V2Harness();
      harness.autoComplete = false;
      let subscriptions = 0;
      const subscribe = harness.api.event.subscribe;
      harness.api.event.subscribe = (options) => {
        subscriptions += 1;
        return subscribe(options);
      };
      const client = new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
      });
      const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        await session.startTurn("finish while disconnected");
        await expect.poll(() => harness.prompts).toHaveLength(1);
        // Persisted completion without its event, as after an upstream stream gap.
        harness.finishExecution("succeeded", false);
        if (recovery === "reconnect")
          harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
        await expect.poll(() => terminalEvents(events), { timeout: 7_000 }).toHaveLength(1);
        expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
        expect(subscriptions).toBe(1);
      } finally {
        await session.close();
      }
    },
    10_000,
  );

  test("does not finish from a previous outcome before prompt admission", async () => {
    const harness = new V2Harness();
    let accept!: () => void;
    harness.prompt = () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("fast execution");
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.startExecution();
      harness.finishExecution();
      accept();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("follows a queued successor until the session is idle", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("first and queued work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.finishExecution();
      harness.startExecution();
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
    } finally {
      await session.close();
    }
  });

  test("discards an idle snapshot overtaken by a new execution event", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    let readSnapshot!: () => void;
    let release!: () => void;
    const reading = new Promise<void>((resolve) => {
      readSnapshot = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await session.startTurn("work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.api.session.get = async () => {
        const snapshot = { ...harness.info };
        readSnapshot();
        await blocked;
        return snapshot;
      };
      harness.finishExecution();
      await reading;
      const reads = harness.activeReads;
      harness.startExecution();
      release();
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
    } finally {
      release();
      await session.close();
    }
  });

  test("does not treat shutdown interruption as a completed or canceled turn", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("resumable work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.active = false;
      // Shutdown does not project an idle outcome; the preceding run's outcome can remain.
      harness.info.outcome = "succeeded";
      harness.push({
        id: "shutdown",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.startExecution();
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("ends the turn when the user dismisses a question", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    let form: FormInfo | null = null;
    harness.api.session.form.list = async () => (form ? [form] : []);
    harness.api.session.form.cancel = async () => {
      form = null;
      harness.active = false;
      // OpenCode 2.0.20 reports a dismissed question as an interruption without a user reason.
      harness.push({
        id: "dismissed",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("ask me something");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      form = {
        id: "question",
        sessionID: "session",
        title: "Color",
        fields: [{ key: "color", type: "string", options: [{ label: "Red", value: "red" }] }],
      };
      harness.push({
        id: "form",
        created: 2,
        type: "form.created",
        data: { form },
      });
      await expect.poll(() => session.getPendingPermissions()).toHaveLength(1);

      await session.respondToPermission("question", { behavior: "deny" });

      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_canceled" });

      await session.startTurn("next message");
      await expect.poll(() => harness.prompts).toHaveLength(2);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(2);
      expect(terminalEvents(events)[1]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("ends the turn when the user denies a tool permission", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    let permission: Awaited<ReturnType<V2Api["permission"]["list"]>>[number] | null = null;
    harness.api.permission.list = async () => (permission ? [permission] : []);
    harness.api.permission.reply = async () => {
      permission = null;
      harness.active = false;
      // OpenCode 2.0.20 reports a denied tool call as an interruption without a user reason.
      harness.push({
        id: "denied",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("run printf");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      permission = {
        id: "approval",
        sessionID: "session",
        action: "shell",
        resources: ["printf TOOL_PERMISSION_QA"],
      };
      harness.push({
        id: "asked",
        created: 2,
        type: "permission.asked",
        data: permission,
      });
      await expect.poll(() => session.getPendingPermissions()).toHaveLength(1);

      await session.respondToPermission("approval", { behavior: "deny" });

      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_canceled" });

      await session.startTurn("next message");
      await expect.poll(() => harness.prompts).toHaveLength(2);
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(2);
      expect(terminalEvents(events)[1]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("keeps the turn resumable after the user denies a child session's permission", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const child = { ...harness.info, id: "child", parentID: "session" };
    harness.api.session.list = async (input) => ({
      data: input?.parentID === "session" ? [child] : [],
      cursor: {},
    });
    let permission: Awaited<ReturnType<V2Api["permission"]["list"]>>[number] | null = {
      id: "child-approval",
      sessionID: "child",
      action: "shell",
      resources: ["pwd"],
    };
    harness.api.permission.list = async (input) =>
      permission && input.sessionID === "child" ? [permission] : [];
    harness.api.permission.reply = async () => {
      permission = null;
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("delegate work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      expect(session.getPendingPermissions()).toHaveLength(1);

      await session.respondToPermission("child-approval", { behavior: "deny" });

      harness.active = false;
      harness.push({
        id: "shutdown",
        created: 3,
        type: "session.execution.interrupted",
        durable: { aggregateID: "session", seq: 3, version: 1 },
        data: { sessionID: "session", reason: "shutdown" },
      });
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.startExecution();
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("recovers the latest execution from the durable log when shutdown and resume events were missed", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      await session.startTurn("resumable work");
      await expect.poll(() => harness.prompts).toHaveLength(1);
      harness.active = false;
      harness.info.outcome = "succeeded";
      harness.api.session.log = async function* () {
        yield {
          id: "shutdown",
          created: 3,
          type: "session.execution.interrupted",
          durable: { aggregateID: "session", seq: 3, version: 1 },
          data: { sessionID: "session", reason: "shutdown" },
        };
      };
      const reads = harness.activeReads;
      harness.push({ id: "reconnect", created: 4, type: "server.connected", data: {} });
      await expect.poll(() => harness.activeReads).toBeGreaterThan(reads);
      expect(terminalEvents(events)).toEqual([]);
      harness.api.session.log = async function* () {
        yield {
          id: "done",
          created: 6,
          type: "session.execution.succeeded",
          durable: { aggregateID: "session", seq: 6, version: 1 },
          data: { sessionID: "session" },
        };
      };
      harness.push({
        id: "reconnect-after-resume",
        created: 7,
        type: "server.connected",
        data: {},
      });
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test("keeps the turn alive through an observation transport failure", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    const active = harness.api.session.active;
    let attempted = false;
    harness.api.session.active = async () => {
      attempted = true;
      throw new Error("fetch failed");
    };
    try {
      await session.startTurn("work");
      await expect.poll(() => attempted).toBe(true);
      expect(terminalEvents(events)).toEqual([]);
      harness.api.session.active = active;
      harness.finishExecution();
      await expect.poll(() => terminalEvents(events)).toHaveLength(1);
      expect(terminalEvents(events)[0]).toMatchObject({ type: "turn_completed" });
    } finally {
      await session.close();
    }
  });

  test.each([
    { variants: ["medium", "custom"], selected: "medium", expected: "medium" },
    { variants: ["custom"], selected: "custom", expected: "custom" },
    { variants: ["high"], selected: "medium", expected: undefined },
    { variants: [], selected: "medium", expected: undefined },
    { variants: ["medium"], selected: "default", expected: undefined },
  ])(
    "model switches retain only supported variants: $selected / $variants",
    async ({ variants, selected, expected }) => {
      const harness = new V2Harness();
      const target: ModelInfo = {
        id: "target",
        modelID: "target",
        providerID: "test",
        name: "Target",
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        variants: variants.map((id) => ({ id })),
        time: { released: 1 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 200000, output: 10000 },
      };
      harness.info.model = { providerID: "test", id: "source", variant: selected };
      harness.api.model.list = async () => ({ location: harness.info.location, data: [target] });
      harness.api.session.switchModel = async ({ model }) => {
        harness.info.model = model;
      };
      const client = new OpenCodeV2AgentClient({
        logger: createTestLogger(),
        runtime: harness.runtime,
      });
      const session = await client.createSession({
        provider: "opencode",
        cwd: "/tmp/project",
        model: "test/source",
        thinkingOptionId: selected,
      });
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      try {
        await session.setModel!("test/target");
        expect(await session.getRuntimeInfo()).toMatchObject({
          model: "test/target",
          thinkingOptionId: expected ?? null,
        });
        expect(session.describePersistence().metadata?.thinkingOptionId).toBe(expected);
        expect(events).toContainEqual({
          type: "thinking_option_changed",
          provider: "opencode",
          thinkingOptionId: expected ?? null,
        });
        await expect(session.setModel!("test/missing")).rejects.toThrow(
          "OpenCode model unavailable",
        );
        harness.api.session.switchModel = async () => {
          throw new Error("Switch failed");
        };
        await expect(session.setModel!("test/target")).rejects.toThrow("Switch failed");
        expect(session.describePersistence().metadata?.thinkingOptionId).toBe(expected);
        expect(harness.info.model).toEqual({
          providerID: "test",
          id: "target",
          ...(expected ? { variant: expected } : {}),
        });
        harness.api.session.switchModel = async ({ model }) => {
          harness.info.model = model;
        };
        harness.api.model.default = async () => ({ location: harness.info.location, data: target });
        await session.setThinkingOption!("unsupported");
        await session.setModel!(null);
        expect((await session.getRuntimeInfo()).thinkingOptionId).toBeNull();
        harness.api.model.list = async () => {
          throw new Error("Catalog unavailable");
        };
        await expect(session.setModel!("test/source")).rejects.toThrow("Catalog unavailable");
        expect((await session.getRuntimeInfo()).model).toBe("test/target");
      } finally {
        await session.close();
      }
    },
  );

  test("restores each same-directory agent environment on reconnect and resume", async () => {
    const first = new V2Harness();
    const second = new V2Harness();
    first.info.id = "session-first";
    second.info.id = "session-second";
    const environments = new Map<string, Record<string, string>>();
    const bind = async (input: { sessionID: string; variables: Record<string, string> }) => {
      environments.set(input.sessionID, { ...input.variables });
    };
    first.api.session.environment = bind;
    second.api.session.environment = bind;
    const clients = [first, second].map(
      (harness) =>
        new OpenCodeV2AgentClient({
          logger: createTestLogger(),
          runtime: harness.runtime,
          settings: {
            env: {
              JAGENTDESK_ENV_TEST: "configured",
              JAGENTDESK_AGENT_ID: "configured",
              ELECTRON_RUN_AS_NODE: "1",
              JAGENTDESK_SUPERVISED: "1",
              CLAUDECODE: "1",
            },
          },
        }),
    );
    const config = { provider: "opencode" as const, cwd: "/tmp/project" };
    const launches = ["first", "second"].map((id) => ({
      env: { JAGENTDESK_AGENT_ID: id, JAGENTDESK_AGENT_CWD: config.cwd },
    }));
    const assertEnvironment = (index: number) => {
      const env = environments.get([first, second][index].info.id);
      expect(env?.PATH).toBe(process.env.PATH);
      expect(env).toMatchObject({ ...launches[index].env, JAGENTDESK_ENV_TEST: "configured" });
      expect(env?.USER).toBe(process.env.USER);
      for (const key of [
        "ELECTRON_RUN_AS_NODE",
        "JAGENTDESK_SUPERVISED",
        "CLAUDECODE",
        "ESBUILD_BINARY_PATH",
        "JAGENTDESK_NODE_ENV",
      ]) {
        expect(env).not.toHaveProperty(key);
      }
    };
    const sessions = await Promise.all(
      clients.map((client, i) => client.createSession(config, launches[i])),
    );
    try {
      assertEnvironment(0);
      assertEnvironment(1);
      environments.clear();
      first.push({ id: "reconnected-first", created: 2, type: "server.connected", data: {} });
      second.push({ id: "reconnected-second", created: 2, type: "server.connected", data: {} });
      await expect.poll(() => environments.size).toBe(2);
      assertEnvironment(0);
      assertEnvironment(1);
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
    }
    environments.clear();
    const resumed = await Promise.all(
      clients.map((client, i) =>
        client.resumeSession(sessions[i].describePersistence(), undefined, launches[i]),
      ),
    );
    try {
      assertEnvironment(0);
      assertEnvironment(1);
      expect(first.prompts).toEqual([]);
      expect(second.prompts).toEqual([]);
    } finally {
      await Promise.all(resumed.map((session) => session.close()));
    }
  });

  test.each(["with", "without"])(
    "removes a tracked child deleted during disconnect %s a launch environment",
    async (launchEnvironment) => {
      const harness = new V2Harness();
      const child: SessionInfo = { ...harness.info, id: "deleted", parentID: "session" };
      const sibling: SessionInfo = { ...harness.info, id: "sibling", parentID: "session" };
      const grandchild: SessionInfo = { ...harness.info, id: "grandchild", parentID: sibling.id };
      const sessions = new Map([[harness.info.id, harness.info]]);
      harness.api.session.list = async ({ parentID } = {}) => ({
        data: parentID ? [...sessions.values()].filter((info) => info.parentID === parentID) : [],
        cursor: {},
      });
      harness.api.session.active = async () =>
        sessions.has(child.id) ? { [child.id]: { type: "running" } } : {};

      const server = createServer(async (request, response) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (pathname === "/api/info") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ version: "2.3.0", pid: 1, urls: [], paths: { tmp: "/tmp" } }),
          );
          return;
        }
        const sessionPath = /^\/api\/session\/([^/]+)(\/environment)?$/.exec(pathname);
        if (!sessionPath) {
          response.writeHead(404).end();
          return;
        }
        const [, sessionID, environmentPath] = sessionPath;
        const info = sessions.get(sessionID);
        if (!info) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              _tag: "SessionNotFoundError",
              sessionID,
              message: "Session not found",
            }),
          );
          return;
        }
        if (environmentPath && request.method === "PUT") {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const { variables } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          harness.environments.push({ sessionID, variables });
          response.writeHead(204).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: info }));
      }).listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      const logger = createTestLogger();
      const runtime = new V2Runtime({
        logger,
        selection: { kind: "explicit", server: { url: `http://127.0.0.1:${address.port}` } },
      });

      try {
        // Keep control of the event stream and turn completion while sending session lookups
        // and environment requests through the same HTTP transport as a real server.
        const connection = await runtime.acquire();
        harness.api.session.get = connection.client.session.get;
        harness.api.session.environment = connection.client.session.environment;
        const client = new OpenCodeV2AgentClient({ logger, runtime: harness.runtime });
        const session = await client.createSession(
          { provider: "opencode", cwd: "/tmp/project" },
          launchEnvironment === "with" ? { env: { JAGENTDESK_AGENT_ID: "parent" } } : undefined,
        );
        const store = new ProviderSubagentStore();
        session.subscribe((event) => {
          if (event.type === "provider_subagent") store.apply("parent", "opencode", event.event);
        });
        try {
          for (const info of [child, sibling, grandchild]) sessions.set(info.id, info);
          harness.push({ id: child.id, created: 2, type: "session.created", data: child });
          const ids = () =>
            store
              .list("parent")
              .map(({ id }) => id)
              .sort();
          await expect.poll(ids).toEqual([child.id, grandchild.id, sibling.id]);
          expect(store.list("parent").find(({ id }) => id === child.id)?.status).toBe("running");

          sessions.delete(child.id);
          harness.environments.length = 0;
          harness.push({ id: "reconnected", created: 3, type: "server.connected", data: {} });

          await expect.poll(ids).toEqual([grandchild.id, sibling.id]);
          if (launchEnvironment === "with") {
            // JAgentDesk restores the launch environment on the agent's own session; descendant
            // sessions are not adopted (that arrives with Paseo #10752, deferred).
            await expect
              .poll(() => harness.environments)
              .toContainEqual(
                expect.objectContaining({
                  sessionID: harness.info.id,
                  variables: expect.objectContaining({ JAGENTDESK_AGENT_ID: "parent" }),
                }),
              );
          }
          await expect(session.run("continue after reconnect")).resolves.toMatchObject({
            sessionId: harness.info.id,
          });
        } finally {
          await session.close();
        }
      } finally {
        await runtime.shutdown();
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      }
    },
  );

  test("reconnects after a helper exits and restores session configuration on the next turn", async () => {
    const first = new V2Harness();
    const second = new V2Harness(1);
    let exit!: (error: Error) => void;
    const exited = new Promise<Error>((resolve) => {
      exit = resolve;
    });
    let acquisitions = 0;
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: {
        acquire: async () => {
          acquisitions += 1;
          return acquisitions === 1 ? { ...first.connection, exited } : second.connection;
        },
        shutdown: async () => undefined,
      },
    });
    first.autoComplete = false;
    second.prompt = async (input) => {
      second.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "recovered" }],
      });
      second.prompts.push(input.text);
    };
    const session = await client.createSession(
      { provider: "opencode", cwd: "/tmp/project" },
      { env: { TOKEN: "test" } },
    );
    const running = session.run("before exit");
    await expect.poll(() => first.prompts).toEqual(["before exit"]);
    exit(new Error("helper exited"));
    await expect(running).rejects.toThrow("helper exited");
    expect(acquisitions).toBe(1);
    try {
      expect((await session.run("after exit")).finalText).toBe("recovered");
      expect(second.prompts).toEqual(["after exit"]);
      expect(second.environments).toMatchObject([
        { sessionID: "session", variables: { TOKEN: "test", PATH: process.env.PATH } },
      ]);
      expect(second.environments).toEqual(first.environments);
      expect(first.releases).toBe(1);
    } finally {
      await session.close();
    }
    await expect(session.startTurn("after close")).rejects.toThrow("OpenCode session is closed");
  });
  test("fails initialization when the event stream ends before connecting", async () => {
    const harness = new V2Harness();
    harness.api.event.subscribe = async function* () {};
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    await expect(
      client.createSession({ provider: "opencode", cwd: "/tmp/project" }),
    ).rejects.toThrow("event stream ended before connecting");
    expect(harness.releases).toBeGreaterThan(0);
  });

  test("returns only validated structured output and preserves it in history", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.history.push({
        id: "user",
        type: "user",
        text: input.text,
        metadata: input.metadata,
        time: { created: 1 },
      });
      harness.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [
          { type: "text", text: "Here is the answer" },
          {
            type: "tool",
            id: "output",
            name: "jagentdesk_structured_output",
            time: { created: 2 },
            state: {
              status: "completed",
              input: { value: { answer: 42 } },
              content: [{ type: "text", text: "accepted" }],
              metadata: { jagentdeskStructuredOutput: { answer: 42 } },
            },
          },
        ],
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      const result = await session.run("answer", {
        outputSchema: {
          type: "object",
          properties: { answer: { const: 42 } },
          required: ["answer"],
        },
      });
      expect(result.finalText).toBe('{"answer":42}');
      const history = [];
      for await (const event of session.streamHistory!()) history.push(event);
      expect(history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "timeline",
            item: expect.objectContaining({ type: "assistant_message", text: result.finalText }),
          }),
        ]),
      );
    } finally {
      await session.close();
    }
  });

  test("fails a structured turn when the model omits the validated output tool", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await expect(session.run("answer", { outputSchema: { type: "object" } })).rejects.toThrow(
        "without submitting the required structured output",
      );
    } finally {
      await session.close();
    }
  });

  test("resumes the native session ID and never replaces a missing session", async () => {
    const harness = new V2Harness();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const handle = {
      provider: "opencode",
      sessionId: "session",
      nativeHandle: "session",
      metadata: { cwd: "/tmp/project" },
    } as const;
    harness.api.session.switchAgent = async ({ agent }) => {
      harness.info.agent = agent;
    };
    harness.api.session.switchModel = async ({ model }) => {
      harness.info.model = model;
    };
    const session = await client.resumeSession(handle, {
      modeId: "plan",
      model: "synthetic/test",
      thinkingOptionId: "low",
    });
    try {
      expect(await session.getRuntimeInfo!()).toMatchObject({
        modeId: "plan",
        model: "synthetic/test",
        thinkingOptionId: "low",
      });
      expect(await session.describePersistence()).toMatchObject({
        sessionId: "session",
        nativeHandle: "session",
      });
      expect(harness.creates).toEqual([]);
    } finally {
      await session.close();
    }
    harness.api.session.get = async () => {
      throw new Error("Session not found");
    };
    await expect(client.resumeSession(handle)).rejects.toThrow("Session not found");
    expect(harness.creates).toEqual([]);
  });

  test("reconciles reconnect snapshots without replaying text or losing repeated chunks", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const finish = () => harness.finishExecution();
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const chunks: string[] = [];
    session.subscribe((event) => {
      if (event.type === "timeline" && event.item.type === "assistant_message")
        chunks.push(event.item.text);
    });
    try {
      const running = session.run("laugh");
      await expect.poll(() => harness.prompts).toEqual(["laugh"]);
      const answer = {
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "ha" }],
      } satisfies SessionMessageInfo;
      harness.history.push(answer);
      harness.push({ id: "reconnect-1", created: 2, type: "server.connected", data: {} });
      await expect.poll(() => chunks).toEqual(["ha"]);
      answer.content[0].text = "haha";
      harness.push({ id: "reconnect-2", created: 3, type: "server.connected", data: {} });
      await expect.poll(() => chunks).toEqual(["ha", "ha"]);
      finish();
      expect((await running).finalText).toBe("haha");
      expect(chunks).toEqual(["ha", "ha"]);
    } finally {
      await session.close();
    }
  });

  test("retries observation failures without replacing the execution error", async () => {
    const harness = new V2Harness();
    harness.info.outcome = "failed";
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      let attempted = false;
      harness.api.session.log = () => {
        attempted = true;
        throw new Error("log unavailable");
      };
      await session.startTurn("hello");
      const failures = () => events.filter((event) => event.type === "turn_failed");
      await expect.poll(() => attempted).toBe(true);
      expect(failures()).toEqual([]);
      harness.api.session.log = async function* () {
        yield {
          id: "failure",
          created: 2,
          durable: { aggregateID: "session", seq: 2, version: 1 },
          type: "session.execution.failed",
          data: { sessionID: "session", error: { type: "provider", message: "quota exhausted" } },
        };
      };
      harness.push({ id: "reconnect", created: 3, type: "server.connected", data: {} });
      await expect.poll(failures).toHaveLength(1);
      expect(failures()[0]).toMatchObject({ error: "quota exhausted" });
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(0);
    } finally {
      await session.close();
    }
  });

  test("waits for prompt acceptance before interrupting", async () => {
    const harness = new V2Harness();
    let accept!: () => void;
    const settle = () => harness.finishExecution("interrupted");
    let interruptions = 0;
    harness.prompt = () =>
      new Promise<void>((resolve) => {
        accept = resolve;
      });

    harness.interrupt = async () => {
      interruptions += 1;
      harness.info.outcome = "interrupted";
      settle();
      return { interrupted: true };
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      const stopping = session.interrupt();
      await Promise.resolve();
      expect(interruptions).toBe(0);
      accept();
      await stopping;
      expect(interruptions).toBe(1);
    } finally {
      await session.close();
    }
  });

  test("completes a submitted turn once and reconciles its final text", async () => {
    const harness = new V2Harness();
    harness.prompt = async (input) => {
      harness.prompts.push(input.text);
      harness.history.push({
        id: "answer",
        type: "assistant",
        agent: "build",
        model: { providerID: "test", id: "model" },
        time: { created: 2 },
        content: [{ type: "text", text: "done" }],
      });
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    try {
      const result = await session.run("hello");
      expect(result.finalText).toBe("done");
      expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
      expect(harness.creates[0]).toMatchObject({
        agent: "build",
        location: { directory: "/tmp/project" },
      });
    } finally {
      await session.close();
    }
    expect(harness.releases).toBe(1);
  });

  test("waits for interruption settlement before submitting replacement work", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const finishFirst = () => harness.finishExecution("interrupted");
    let finishStop!: () => void;
    harness.interrupt = () =>
      new Promise((resolve) => {
        finishStop = () => {
          harness.info.outcome = "interrupted";
          finishFirst();
          resolve({ interrupted: true });
        };
      });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      await expect.poll(() => harness.prompts).toEqual(["first"]);
      const stopping = session.interrupt();
      const replacement = session.startTurn("second");
      await Promise.resolve();
      expect(harness.prompts).toEqual(["first"]);
      harness.autoComplete = true;
      finishStop();
      await stopping;
      await replacement;
      await expect.poll(() => harness.prompts).toEqual(["first", "second"]);
    } finally {
      await session.close();
    }
  });

  test("shares the server for a launch environment, which reaches the session only", async () => {
    const harness = new V2Harness();
    let acquisitions = 0;
    const runtime = {
      acquire: async () => {
        acquisitions += 1;
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const session = await client.createSession(
      { provider: "opencode", cwd: "/tmp/project" },
      { agentId: "agent", env: { HUB_SECRET: "secret", JAGENTDESK_AGENT_ID: "agent" } },
    );
    try {
      expect(acquisitions).toBe(1);
      expect(harness.environments).toMatchObject([
        { sessionID: "session", variables: { HUB_SECRET: "secret", JAGENTDESK_AGENT_ID: "agent" } },
      ]);
    } finally {
      await session.close();
    }
  });

  test("runs MCP servers on the shared server when it reports features.mcpTools", async () => {
    const harness = new V2Harness();
    harness.mcpPathResult = "session";
    const home = await mkdtemp(path.join(tmpdir(), "jagentdesk-v2-session-mcp-"));
    const fixture = await writeStdioMcpFixture(home);
    const bridge = new OpenCodeBridge({ jagentdeskHome: home, logger: createTestLogger() });
    const acquires: Array<V2RuntimeAcquireOptions | undefined> = [];
    const runtime = {
      acquire: async (input?: V2RuntimeAcquireOptions) => {
        acquires.push(input);
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime, bridge });
    const session = await client.createSession(
      {
        provider: "opencode",
        // A stdio server starts in the agent's directory, which must exist.
        cwd: home,
        mcpServers: { local: { type: "stdio", command: process.execPath, args: [fixture.script] } },
      },
      { agentId: "agent", env: { HUB_SECRET: "secret", JAGENTDESK_AGENT_ID: "agent" } },
    );
    try {
      expect(acquires).toEqual([undefined]);
      expect(harness.mcpAdds).toEqual([]);
      expect(bridge.hasMcpTools("session")).toBe(true);
      expect(harness.environments).toMatchObject([
        { sessionID: "session", variables: { HUB_SECRET: "secret", JAGENTDESK_AGENT_ID: "agent" } },
      ]);
    } finally {
      await session.close();
      await rm(home, { recursive: true, force: true });
    }
    expect(bridge.hasMcpTools("session")).toBe(false);
  });

  test("keeps mcp.add on a server of the agent's own when the server lacks features.mcpTools", async () => {
    const harness = new V2Harness();
    harness.mcpPathResult = "legacy";
    const acquires: Array<V2RuntimeAcquireOptions | undefined> = [];
    const runtime = {
      acquire: async (input?: V2RuntimeAcquireOptions) => {
        acquires.push(input);
        return harness.connection;
      },
      shutdown: async () => undefined,
    };
    const client = new OpenCodeV2AgentClient({ logger: createTestLogger(), runtime });
    const env = { HUB_SECRET: "secret", JAGENTDESK_AGENT_ID: "agent" };
    const session = await client.createSession(
      {
        provider: "opencode",
        cwd: "/tmp/project",
        mcpServers: { custom: { type: "stdio", command: "custom", args: ["--flag"] } },
      },
      { agentId: "agent", env },
    );
    try {
      // The shared server decides the path; the session runs on a dedicated one.
      expect(acquires).toEqual([undefined, { env, dedicated: true }]);
      expect(harness.releases).toBe(1);
      expect(harness.mcpAddInputs).toEqual([
        {
          server: "custom",
          location: { directory: "/tmp/project" },
          config: {
            type: "local",
            command: ["custom", "--flag"],
            environment: undefined,
            codemode: false,
          },
        },
      ]);
      expect(harness.environments).toMatchObject([{ sessionID: "session", variables: env }]);
    } finally {
      await session.close();
    }
  });

  test("checks the session's MCP tools in the plugin on the session path", async () => {
    const harness = new V2Harness();
    const home = await mkdtemp(path.join(tmpdir(), "jagentdesk-v2-session-health-"));
    const fixture = await writeStdioMcpFixture(home);
    const bridge = new OpenCodeBridge({ jagentdeskHome: home, logger: createTestLogger() });
    let tools: string[] = [];
    let binds = 0;
    const connection = {
      ...harness.connection,
      bindSession: async () => {
        binds += 1;
      },
      sessionToolsStatus: async () => ({ bound: true, tools }),
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: { acquire: async () => connection, shutdown: async () => undefined },
      bridge,
    });
    const session = await client.createSession({
      provider: "opencode",
      cwd: home,
      mcpServers: { local: { type: "stdio", command: process.execPath, args: [fixture.script] } },
    });
    try {
      const signal = new AbortController().signal;
      const before = binds;
      await expect(session.checkJAgentDeskTools!({ signal })).resolves.toEqual({
        status: "missing",
        reason: "the JAgentDesk plugin in OpenCode is missing this session's MCP tools: local_env",
      });
      // One re-bind was tried before reporting.
      expect(binds - before).toBe(1);
      tools = ["mcp:local_env"];
      await expect(session.checkJAgentDeskTools!({ signal })).resolves.toEqual({ status: "ok" });
    } finally {
      await session.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  test("checks mcp.list for the internal jagentdesk server on the legacy path", async () => {
    const harness = new V2Harness();
    harness.mcpPathResult = "legacy";
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({
      provider: "opencode",
      cwd: "/tmp/project",
      mcpServers: {
        jagentdesk: { type: "http", url: "http://127.0.0.1:1/mcp/agents" },
      },
    });
    try {
      const signal = new AbortController().signal;
      await expect(session.checkJAgentDeskTools!({ signal })).resolves.toEqual({ status: "ok" });
      harness.mcpAdds.length = 0;
      await expect(session.checkJAgentDeskTools!({ signal })).resolves.toEqual({
        status: "missing",
        reason: "the jagentdesk MCP server is not loaded in OpenCode",
      });
    } finally {
      await session.close();
    }
  });

  test("never asks for the MCP path when the agent has no MCP servers or process env", async () => {
    const harness = new V2Harness();
    let asked = 0;
    const connection = {
      ...harness.connection,
      mcpPath: async () => {
        asked += 1;
        return "legacy" as const;
      },
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: { acquire: async () => connection, shutdown: async () => undefined },
    });
    const session = await client.createSession(
      { provider: "opencode", cwd: "/tmp/project" },
      { agentId: "agent", env: { JAGENTDESK_AGENT_ID: "agent" } },
    );
    try {
      expect(asked).toBe(0);
      expect(harness.mcpAdds).toEqual([]);
    } finally {
      await session.close();
    }
  });

  test("refuses replacement work after a failed stop until Stop succeeds", async () => {
    const harness = new V2Harness();
    harness.autoComplete = false;
    const finishFirst = () => harness.finishExecution("interrupted");
    harness.interrupt = async () => {
      throw new Error("stop failed");
    };
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    try {
      await session.startTurn("first");
      await expect.poll(() => harness.prompts).toEqual(["first"]);
      await expect(session.interrupt()).rejects.toThrow("stop failed");
      await expect(session.startTurn("unsafe replacement")).rejects.toThrow("stop failed");
      expect(harness.prompts).toEqual(["first"]);
      harness.interrupt = async () => {
        finishFirst();
        return { interrupted: true };
      };
      await session.interrupt();
      harness.autoComplete = true;
      await session.startTurn("retry");
      await expect.poll(() => harness.prompts).toEqual(["first", "retry"]);
    } finally {
      await session.close();
    }
  });
});

test("OpenCode v2 runtime safety retains shells, queued reports and shared executions", async () => {
  const harness = new V2Harness();
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  try {
    expect(await session.canStopRuntime!()).toBe(true);
    harness.api.shell.list = async () => ({
      location: { directory: "/tmp/project" },
      data: [
        {
          id: "quiet-shell",
          status: "running",
          command: "sleep 7200",
          cwd: "/tmp/project",
          shell: "sh",
          file: "/tmp/out",
          metadata: {},
          time: { started: 1 },
        },
      ],
    });
    expect(await session.canStopRuntime!()).toBe(false);
    harness.api.shell.list = async () => ({ location: { directory: "/tmp/project" }, data: [] });
    harness.api.session.inbox.list = async () => [
      {
        id: "report",
        sessionID: session.id!,
        type: "synthetic",
        delivery: "queue",
        time: { created: 1 },
        payload: { text: "Background child finished" },
      },
    ];
    expect(await session.canStopRuntime!()).toBe(false);
    harness.api.session.inbox.list = async () => [];
    harness.api.session.active = async () => ({
      "unrelated-autonomous-session": { type: "running" },
    });
    expect(await session.canStopRuntime!()).toBe(false);
    harness.api.session.active = async () => ({});
    expect(await session.canStopRuntime!()).toBe(true);
    harness.api.shell.list = async () => {
      throw new Error("No shell inventory");
    };
    await expect(session.canStopRuntime!()).rejects.toThrow("No shell inventory");
  } finally {
    await session.close();
  }
});

test("OpenCode v2 runtime safety follows descendant locations before releasing the last lease", async () => {
  const harness = new V2Harness();
  const child = {
    ...harness.info,
    id: "child",
    parentID: harness.info.id,
    location: { directory: "/tmp/child-worktree" },
  };
  const locations: string[] = [];
  const client = new OpenCodeV2AgentClient({
    logger: createTestLogger(),
    runtime: harness.runtime,
  });
  const session = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
  // A completed native child can still own a quiet shell in another location.
  harness.api.session.list = async (input) => ({
    data: input.parentID === session.id ? [child] : [],
    cursor: {},
  });
  let running = true;
  harness.api.shell.list = async (input) => {
    const directory = input?.location?.directory ?? "";
    locations.push(directory);
    return {
      location: { directory },
      data:
        directory === child.location.directory && running
          ? [
              {
                id: "child-shell",
                status: "running",
                command: "sleep 7200",
                cwd: directory,
                shell: "sh",
                file: "/tmp/out",
                metadata: {},
                time: { started: 1 },
              },
            ]
          : [],
    };
  };
  try {
    expect(await session.canStopRuntime!()).toBe(false);
    expect(locations).toEqual(["/tmp/project", "/tmp/child-worktree"]);
    running = false;
    expect(await session.canStopRuntime!()).toBe(true);
    await session.close();
    expect(harness.releases).toBe(1);
  } finally {
    await session.close();
  }
});

describe("OpenCode v2 history version", () => {
  test("changes when a message lands or the session reverts", async () => {
    const harness = new V2Harness();
    harness.api.message.list = async (input) => {
      const ordered = input.order === "desc" ? harness.history.toReversed() : harness.history;
      return { data: ordered.slice(0, input.limit ?? ordered.length), cursor: {} };
    };
    harness.history.push({ id: "u1", type: "user", text: "first", time: { created: 1 } });
    const client = new OpenCodeV2AgentClient({
      logger: createTestLogger(),
      runtime: harness.runtime,
    });
    const created = await client.createSession({ provider: "opencode", cwd: "/tmp/project" });
    const handle = created.describePersistence()!;
    await created.close();
    const session = await client.resumeSession(handle, { cwd: "/tmp/project" });
    try {
      const first = await session.readHistoryVersion!();
      expect(await session.readHistoryVersion!()).toBe(first);

      harness.history.push({ id: "u2", type: "user", text: "second", time: { created: 2 } });
      const second = await session.readHistoryVersion!();
      expect(second).not.toBe(first);

      harness.info.revert = { messageID: "u2" } as NonNullable<typeof harness.info.revert>;
      expect(await session.readHistoryVersion!()).not.toBe(second);
    } finally {
      await session.close();
    }
  });
});
