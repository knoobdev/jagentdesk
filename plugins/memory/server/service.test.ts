import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { MemoryService } from "./service.js";
import { MemoryStore } from "./store.js";

interface AppendedItem {
  agentId: string;
  item: AgentTimelineItem;
}

function createService(options: { enabled?: () => boolean } = {}) {
  const appended: AppendedItem[] = [];
  const broadcasts: unknown[] = [];
  const projects = new Map<string, string>([
    ["agent-a", "proj-a"],
    ["agent-a2", "proj-a"],
    ["agent-b", "proj-b"],
  ]);
  const service = new MemoryService({
    store: new MemoryStore(new Database(":memory:")),
    agentManager: {
      getAgent: (agentId: string) =>
        ({ provider: "claude", activeForegroundTurnId: `turn-of-${agentId}` }) as never,
      appendTimelineItem: async (agentId: string, item: AgentTimelineItem) => {
        appended.push({ agentId, item });
        return { seq: appended.length, epoch: "epoch" };
      },
    },
    projects: {
      list: async () => [],
      forAgent: async (agentId: string) => {
        const projectId = projects.get(agentId);
        return projectId ? { projectId, name: projectId, rootPath: `/work/${projectId}` } : null;
      },
    },
    broadcast: (message) => broadcasts.push(message),
    logger: pino({ level: "silent" }),
    isEnabled: options.enabled ?? (() => true),
  });
  return { service, appended, broadcasts };
}

describe("MemoryService", () => {
  let harness: ReturnType<typeof createService>;
  beforeEach(() => {
    harness = createService();
  });
  afterEach(() => harness.service.store.close());

  it("A41.1/A41.2: a memory one agent remembers reaches a new agent of the same project", async () => {
    const saved = await harness.service.remember({
      agentId: "agent-a",
      text: "This project uses pnpm to install dependencies.",
      scope: "project",
    });
    expect(saved.memory).toMatchObject({
      scope: "project",
      projectId: "proj-a",
      source: { by: "agent", agentId: "agent-a", provider: "claude" },
    });
    // The "Remembered · …" row lands in the saving agent's timeline.
    expect(harness.appended.shift()).toEqual({
      agentId: "agent-a",
      item: expect.objectContaining({
        type: "plugin",
        id: `memory-remembered:${saved.memory.id}`,
        pluginId: "memory",
        kind: "memory-remembered",
        data: { memory: expect.objectContaining({ id: saved.memory.id, scope: "project" }) },
      }),
    });

    const injection = await harness.service.prepareUserTurn({
      agentId: "agent-a2",
      text: "How do I install the dependencies?",
    });
    expect(injection?.memoryIds).toEqual([saved.memory.id]);
    expect(injection?.block).toMatchObject({
      type: "text",
      mimeType: "text/plain",
      title: "Relevant memories",
    });
    expect(injection?.block.text).toContain("[project] This project uses pnpm");

    await injection!.commit({ messageId: "msg-1" });
    expect(harness.appended).toEqual([
      {
        agentId: "agent-a2",
        item: expect.objectContaining({
          type: "plugin",
          id: "memory-used:turn-of-agent-a2",
          pluginId: "memory",
          kind: "memory-used",
          data: {
            turnKey: "turn-of-agent-a2",
            memories: [expect.objectContaining({ id: saved.memory.id, kind: "injected" })],
          },
        }),
      },
    ]);
    expect(harness.service.store.get(saved.memory.id)?.useCount).toBe(1);

    // Another project does not see it.
    expect(
      await harness.service.prepareUserTurn({ agentId: "agent-b", text: "install dependencies" }),
    ).toBeNull();
  });

  it("A41.3: a global memory applies in every project and stops after it is deleted", async () => {
    const saved = await harness.service.remember({
      agentId: "agent-a",
      text: "Always answer in Vietnamese (tiếng Việt).",
      scope: "global",
    });
    const before = await harness.service.prepareUserTurn({
      agentId: "agent-b",
      text: "Answer this in Vietnamese please",
    });
    expect(before?.memoryIds).toEqual([saved.memory.id]);

    harness.service.remove(saved.memory.id);
    expect(
      await harness.service.prepareUserTurn({
        agentId: "agent-b",
        text: "Answer this in Vietnamese please",
      }),
    ).toBeNull();
  });

  it("A41.4: remember refuses text with a secret and stores nothing", async () => {
    await expect(
      harness.service.remember({
        agentId: "agent-a",
        text: "The deploy key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123",
        scope: "project",
      }),
    ).rejects.toMatchObject({ code: "secret" });
    expect(harness.service.store.list()).toEqual([]);
  });

  it("adds searched memories to the same turn's card", async () => {
    const pnpm = await harness.service.remember({
      agentId: "agent-a",
      text: "Install dependencies with pnpm install",
      scope: "project",
    });
    const port = await harness.service.remember({
      agentId: "agent-a",
      text: "The API listens on port 4000",
      scope: "project",
    });
    const injection = await harness.service.prepareUserTurn({
      agentId: "agent-a2",
      text: "install dependencies",
    });
    await injection!.commit({ messageId: "m" });
    await harness.service.search({ agentId: "agent-a2", query: "port" });
    const last = harness.appended.findLast(
      (entry) => entry.item.type === "plugin" && entry.item.kind === "memory-used",
    )!.item;
    expect(last).toMatchObject({ id: "memory-used:turn-of-agent-a2" });
    expect(
      (last as { data: { memories: { id: string; kind: string }[] } }).data.memories.map(
        (entry) => [entry.id, entry.kind],
      ),
    ).toEqual([
      [pnpm.memory.id, "injected"],
      [port.memory.id, "searched"],
    ]);
  });

  it("injects nothing when Memory, auto-inject or the built-in is off", async () => {
    await harness.service.remember({
      agentId: "agent-a",
      text: "Install dependencies with pnpm install",
      scope: "project",
    });
    const turn = { agentId: "agent-a2", text: "install dependencies" };
    harness.service.updateSettings({ autoInject: false });
    expect(await harness.service.prepareUserTurn(turn)).toBeNull();
    harness.service.updateSettings({ autoInject: true, enabled: false });
    expect(await harness.service.prepareUserTurn(turn)).toBeNull();
    await expect(
      harness.service.remember({ agentId: "agent-a", text: "x", scope: "project" }),
    ).rejects.toMatchObject({ code: "disabled" });

    const off = createService({ enabled: () => false });
    await off.service.remember({
      agentId: "agent-a",
      text: "Install dependencies with pnpm install",
      scope: "project",
    });
    expect(await off.service.prepareUserTurn(turn)).toBeNull();
    off.service.store.close();
  });

  it("clamps the token cap setting", () => {
    expect(harness.service.updateSettings({ tokenCap: 5 }).tokenCap).toBe(100);
    expect(harness.service.updateSettings({ tokenCap: 99_999 }).tokenCap).toBe(8_000);
    expect(harness.service.settings()).toMatchObject({ enabled: true, autoInject: true });
  });
});
