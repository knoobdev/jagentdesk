import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceDescriptorPayload } from "@jagentdesk/protocol/messages";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  selectAgentTimelineState,
  useSessionStore,
} from "@/stores/session-store";
import { createUserMessage, type StreamItem } from "@/types/stream";
import { ReplicaCache, type ReplicaCacheStorage } from ".";

const SERVER_ID = "cached-host";
const LRU_SERVER_IDS = ["host-a", "host-b", "host-c"] as const;

class MemoryStorage implements ReplicaCacheStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

function workspace(
  id = "workspace-1",
  projectId = "project-1",
  workspaceDirectory = "/repo/jagentdesk",
): WorkspaceDescriptorPayload {
  return {
    id,
    projectId,
    projectDisplayName: "JAgentDesk",
    projectRootPath: workspaceDirectory,
    workspaceDirectory,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "running",
    statusEnteredAt: "2026-07-18T08:00:00.000Z",
    activityAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function agent(id: string, workspaceId = "workspace-1", cwd = "/repo/jagentdesk") {
  return normalizeAgentSnapshot(
    {
      id,
      provider: "codex",
      cwd,
      workspaceId,
      model: null,
      createdAt: "2026-07-18T08:00:00.000Z",
      updatedAt: "2026-07-18T08:01:00.000Z",
      lastUserMessageAt: "2026-07-18T08:01:00.000Z",
      status: "idle",
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      currentModeId: null,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      title: `Agent ${id}`,
      labels: {},
    },
    SERVER_ID,
  );
}

function message(id: string, text: string): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: new Date("2026-07-18T08:02:00.000Z"),
    timelineCursor: { epoch: "epoch-1", seq: 12 },
  };
}

function seedSession(): void {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, null);
  store.setAgents(SERVER_ID, new Map([["agent-1", agent("agent-1")]]));
  store.setWorkspaces(
    SERVER_ID,
    new Map([
      [
        "workspace-1",
        normalizeWorkspaceDescriptor({
          ...workspace(),
          workspaceKind: "worktree",
          worktreeSlug: "owned-worktree",
        }),
      ],
    ]),
  );
  store.setProjects(SERVER_ID, [
    normalizeProjectDescriptor({
      projectId: "project-1",
      projectKey: "remote:github.com/acme/example",
      projectDisplayName: "JAgentDesk",
      projectRootPath: "/repo/jagentdesk",
      projectKind: "git",
    }),
    normalizeProjectDescriptor({
      projectId: "empty-project",
      projectDisplayName: "Empty project",
      projectRootPath: "/repo/empty",
      projectKind: "directory",
    }),
  ]);
  store.setFocusedAgentId(SERVER_ID, "agent-1");
  store.setAgentStreamTail(SERVER_ID, new Map([["agent-1", [message("message-1", "Cached")]]]));
  store.setAgentTimelineCursor(
    SERVER_ID,
    new Map([["agent-1", { epoch: "epoch-1", startSeq: 1, endSeq: 12 }]]),
  );
  store.setAgentTimelineHasOlder(SERVER_ID, new Map([["agent-1", true]]));
  store.setAgentAuthoritativeHistoryApplied(SERVER_ID, "agent-1", true);
}

function seedTimeline(serverId: string, text: string): void {
  const agentId = `agent-${serverId}`;
  const workspaceId = `workspace-${serverId}`;
  const workspaceDirectory = `/repo/${serverId}`;
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null);
  store.setAgents(serverId, new Map([[agentId, agent(agentId, workspaceId, workspaceDirectory)]]));
  store.setWorkspaces(
    serverId,
    new Map([
      [
        workspaceId,
        normalizeWorkspaceDescriptor(
          workspace(workspaceId, `project-${serverId}`, workspaceDirectory),
        ),
      ],
    ]),
  );
  store.setFocusedAgentId(serverId, agentId);
  store.setAgentStreamTail(serverId, new Map([[agentId, [message(`message-${serverId}`, text)]]]));
}

afterEach(() => {
  const store = useSessionStore.getState();
  store.clearSession(SERVER_ID);
  for (const serverId of LRU_SERVER_IDS) store.clearSession(serverId);
});

describe("ReplicaCache", () => {
  it.each([true, false, undefined])(
    "retains cached workspace background visibility (%s)",
    async (background) => {
      const storage = new MemoryStorage();
      const writer = new ReplicaCache(storage);
      writer.setHosts([SERVER_ID]);
      seedSession();
      useSessionStore
        .getState()
        .setWorkspaces(
          SERVER_ID,
          new Map([["workspace-1", normalizeWorkspaceDescriptor({ ...workspace(), background })]]),
        );
      await writer.flush();
      useSessionStore.getState().clearSession(SERVER_ID);
      const reader = new ReplicaCache(storage);
      reader.setHosts([SERVER_ID]);
      await reader.restore();
      expect(
        useSessionStore.getState().sessions[SERVER_ID]?.workspaces.get("workspace-1")?.background,
      ).toBe(background ?? false);
    },
  );

  it("refreshes workspaces cached without visibility metadata while preserving agents and timeline", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    await writer.flush();
    const key = "@jagentdesk:replica-cache";
    const raw = storage.values.get(key);
    if (!raw) throw new Error("Expected persisted replica");
    storage.values.set(key, raw.replace(/"background":false,/, ""));
    useSessionStore.getState().clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();
    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session.workspaces.size).toBe(0);
    expect(session.hasHydratedWorkspaces).toBe(false);
    expect([...session.agents.keys()]).toEqual(["agent-1"]);
    expect(session.agentStreamTail.get("agent-1")).toEqual([message("message-1", "Cached")]);
  });

  it("restores a displayable stale replica without claiming remote hydration", async () => {
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage);
    writer.setHosts([SERVER_ID]);
    seedSession();
    await writer.flush();

    useSessionStore.getState().clearSession(SERVER_ID);

    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    expect(session).toBeDefined();
    if (!session) throw new Error("Expected restored session");
    expect(session.client).toBeNull();
    expect(session.hasHydratedAgents).toBe(false);
    expect(session.hasHydratedWorkspaces).toBe(false);
    expect(Array.from(session.agents.keys())).toEqual(["agent-1"]);
    expect(Array.from(session.workspaces.keys())).toEqual(["workspace-1"]);
    expect(Array.from(session.projects.keys())).toEqual(["project-1"]);
    expect(session.agents.get("agent-1")?.updatedAt).toBeInstanceOf(Date);
    expect(session.workspaces.get("workspace-1")?.statusEnteredAt).toBeInstanceOf(Date);
    expect(session.workspaces.get("workspace-1")?.worktreeSlug).toBe("owned-worktree");
    expect(session.agentStreamTail.get("agent-1")).toEqual([message("message-1", "Cached")]);
    expect(session.agentAuthoritativeHistoryApplied).toEqual(new Map());
    expect(session.agentTimelineCursor).toEqual(new Map());
    expect(session.agentTimelineHasOlder).toEqual(new Map());
    expect(session.agentTimelineHasNewer).toEqual(new Map());
    expect(session.agentHistorySyncGeneration).toEqual(new Map());
    expect(selectAgentTimelineState(session, "agent-1")).toEqual({
      status: "painted",
      items: [message("message-1", "Cached")],
    });
  });

  it("persists only the focused agent view with a short timeline tail", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    seedSession();

    const store = useSessionStore.getState();
    store.setAgents(SERVER_ID, (agents) =>
      new Map(agents).set("agent-2", agent("agent-2", "workspace-2", "/repo/other")),
    );
<<<<<<< HEAD
    store.setWorkspaces(SERVER_ID, (workspaces) =>
      new Map(workspaces).set(
        "workspace-2",
        normalizeWorkspaceDescriptor(workspace("workspace-2", "project-2", "/repo/other")),
      ),
=======

    expect(titleReads).toBe(0);
    await cache.flush();
    expect(titleReads).toBe(1);
    expect(storage.changes).toHaveLength(1);
    expect(storage.changes[0]?.upserts.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "agent", id: "changed-agent" },
      { kind: "checkpoint", id: "singleton" },
    ]);
    expect(storage.changes[0]?.deletes).toEqual([]);
  });

  it("round-trips identified and anonymous open turns without changing protocol status", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    const identified = agent("identified");
    identified.turn = {
      phase: "open",
      turnId: "turn-1",
      startedAt: new Date("2026-08-31T12:00:00.000Z"),
      cancellationRequestId: null,
    };
    const anonymous = agent("anonymous");
    anonymous.turn = {
      phase: "open",
      turnId: null,
      startedAt: null,
      cancellationRequestId: null,
    };
    writer.commitDirectoryMutations(SERVER_ID, [
      { kind: "agent", type: "upsert", id: identified.id, value: identified },
      { kind: "agent", type: "upsert", id: anonymous.id, value: anonymous },
    ]);
    await writer.flush();

    const restored = await createCache(storage).readDirectory(SERVER_ID);

    expect(restored.agents.get("identified")).toMatchObject({
      status: "idle",
      turn: {
        phase: "open",
        turnId: "turn-1",
        startedAt: new Date("2026-08-31T12:00:00.000Z"),
        cancellationRequestId: null,
      },
    });
    expect(restored.agents.get("anonymous")).toMatchObject({
      status: "idle",
      turn: {
        phase: "open",
        turnId: null,
        startedAt: null,
        cancellationRequestId: null,
      },
    });
  });

  it("coalesces timeline values before serialization", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    let textReads = 0;
    const changedTimeline = timeline();
    Object.defineProperty(changedTimeline.items[0], "text", {
      configurable: true,
      enumerable: true,
      get: () => {
        textReads += 1;
        return "Latest";
      },
    });

    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Old"));
    cache.commitTimeline(SERVER_ID, "agent-1", changedTimeline);

    expect(textReads).toBe(0);
    await cache.flush();
    expect(textReads).toBe(1);
    expect(storage.changes[0]?.upserts.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "timeline", id: "agent-1" },
    ]);
  });

  it("never reads directory rows older than an accepted deferred deletion", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();

    deleteDirectory(cache, SERVER_ID);

    expect(await cache.readAgent(SERVER_ID, "agent-1")).toBeUndefined();
    expect(await cache.readWorkspace(SERVER_ID, "workspace-1")).toBeUndefined();
    expect((await cache.readDirectory(SERVER_ID)).projects.size).toBe(0);
  });

  it("does not return an accepted agent that storage rejected", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    storage.persistentWriteFailure = new Error("disk unavailable");
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();

    const result = await cache.readAgent(SERVER_ID, "agent-1");

    expect(storage.rows.size).toBe(0);
    expect(result).toBeUndefined();
  });

  it("fails closed when an accepted deletion cannot be persisted before a read", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();
    storage.nextWriteFailure = new Error("disk busy");

    deleteDirectory(cache, SERVER_ID);

    expect(await cache.readWorkspace(SERVER_ID, "workspace-1")).toBeUndefined();
  });

  it("gives up a read instead of retrying while the store keeps rejecting writes", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();
    storage.persistentWriteFailure = new Error("QuotaExceededError");
    storage.reads.length = 0;
    storage.readLimit = 5;

    deleteDirectory(cache, SERVER_ID);

    expect(await cache.readWorkspace(SERVER_ID, "workspace-1")).toBeUndefined();
    expect(storage.reads.length).toBeLessThanOrEqual(1);
  });

  it("still reads a host whose rows are stored when another host's write is rejected", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage, noLegacyCleanup);
    cache.setHosts([SERVER_ID, "other-host"]);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();
    storage.persistentWriteFailure = new Error("QuotaExceededError");

    commitDirectory(cache, "other-host", directory());

    expect((await cache.readWorkspace(SERVER_ID, "workspace-1"))?.workspace.id).toBe("workspace-1");
  });

  it("discards an in-flight read across host removal and reactivation", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();
    const started = deferred();
    const release = deferred();
    storage.onRead = started.resolve;
    storage.readGate = release.promise;

    const reading = cache.readAgent(SERVER_ID, "agent-1");
    await started.promise;
    cache.setHosts([]);
    cache.setHosts([SERVER_ID]);
    release.resolve();

    expect(await reading).toBeUndefined();
  });

  it("discards a durable read when the host changes while it is in flight", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();
    const started = deferred();
    const release = deferred();
    storage.onRead = started.resolve;
    storage.readGate = release.promise;

    const reading = cache.readAgent(SERVER_ID, "agent-1");
    await started.promise;
    deleteDirectory(cache, SERVER_ID);
    release.resolve();

    expect(await reading).toBeUndefined();
  });

  it("retries a timeline read when that same timeline changes in flight", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Old"));
    await cache.flush();
    storage.onRead = () => {
      storage.onRead = null;
      cache.commitTimeline(SERVER_ID, "agent-1", timeline("New"));
    };

    expect((await cache.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([timelineItem("New")]);
    expect(storage.reads).toHaveLength(2);
  });

  it("discards a requested row removed by a directory baseline replacement in flight", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    await cache.flush();
    const replacement = directory();
    replacement.agents.clear();
    storage.onRead = () => {
      storage.onRead = null;
      cache.replaceDirectoryBaseline(SERVER_ID, replacement);
    };

    expect(await cache.readAgent(SERVER_ID, "agent-1")).toBeUndefined();
    expect(storage.reads).toHaveLength(2);
  });

  it("never reads a timeline older than an accepted deferred replacement", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    cache.commitTimeline(SERVER_ID, "agent-1", timeline("Old"));
    await cache.flush();

    cache.commitTimeline(SERVER_ID, "agent-1", timeline("New"));

    expect((await cache.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([timelineItem("New")]);
  });

  it("round-trips plugin timeline items", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    const pluginItem: StreamItem = {
      kind: "plugin",
      id: "reports/test-report/1",
      pluginId: "reports",
      pluginItemId: "test-report/1",
      itemKind: "test-report",
      version: 1,
      data: { passed: 4, failed: 0 },
      timestamp: new Date("2026-07-18T08:02:00.000Z"),
      timelineCursor: { epoch: "epoch-1", seq: 12 },
    };
    writer.commitTimeline(SERVER_ID, "agent-1", {
      agentId: "agent-1",
      items: [pluginItem],
      range: { epoch: "epoch-1", startSeq: 12, endSeq: 12 },
      hasOlder: true,
    });
    await writer.flush();

    const reader = createCache(storage);
    expect((await reader.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([pluginItem]);
  });

  it("drops cached plugin timeline items without a plugin-local id", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    const pluginItem = {
      kind: "plugin",
      id: "reports/test-report/1",
      pluginId: "reports",
      pluginItemId: "test-report/1",
      itemKind: "test-report",
      version: 1,
      data: { passed: 4 },
      timestamp: new Date("2026-07-18T08:02:00.000Z"),
    } satisfies StreamItem;
    writer.commitTimeline(SERVER_ID, "agent-1", {
      agentId: "agent-1",
      items: [pluginItem],
      range: { epoch: "epoch-1", startSeq: 12, endSeq: 12 },
      hasOlder: true,
    });
    await writer.flush();
    const row = requireTimelineRow(storage);
    const payload = JSON.parse(row.payload) as { items: Array<Record<string, unknown>> };
    delete payload.items[0]?.pluginItemId;
    storage.rows.set(`${row.serverId}:${row.kind}:${row.id}`, {
      ...row,
      payload: JSON.stringify(payload),
    });

    expect(await createCache(storage).readTimeline(SERVER_ID, "agent-1")).toBeUndefined();
  });

  it("refetches old cached Markdown fragments instead of offering them as whole messages", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    writer.commitTimeline(SERVER_ID, "agent-1", timeline());
    await writer.flush();
    const row = requireTimelineRow(storage);
    const payload = JSON.parse(row.payload) as { items: Array<Record<string, unknown>> };
    Object.assign(payload.items[0]!, { blockGroupId: "message-1", blockIndex: 0 });
    storage.rows.set(`${row.serverId}:${row.kind}:${row.id}`, {
      ...row,
      payload: JSON.stringify(payload),
    });

    expect(await createCache(storage).readTimeline(SERVER_ID, "agent-1")).toBeUndefined();
  });

  it("reads one requested agent and the focused timeline without scanning directory rows", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    commitDirectory(writer, SERVER_ID, directory());
    writer.commitTimeline(SERVER_ID, "agent-1", timeline());
    await writer.flush();

    const reader = createCache(storage);
    expect((await reader.readAgent(SERVER_ID, "agent-1"))?.id).toBe("agent-1");
    expect((await reader.readTimeline(SERVER_ID, "agent-1"))?.items).toEqual([timelineItem()]);
    expect(storage.reads).toEqual([
      { serverId: SERVER_ID, kinds: ["agent"], ids: ["agent-1"] },
      { serverId: SERVER_ID, kinds: ["timeline"], ids: ["agent-1"] },
    ]);
  });

  it("reads one requested workspace and its project without scanning the directory", async () => {
    const storage = new MemoryStorage();
    const writer = createCache(storage);
    commitDirectory(writer, SERVER_ID, directory());
    await writer.flush();

    const reader = createCache(storage);
    const restored = await reader.readWorkspace(SERVER_ID, "workspace-1");

    expect(restored?.workspace.id).toBe("workspace-1");
    expect(restored?.project?.projectId).toBe("project-1");
    expect(storage.reads).toEqual([
      { serverId: SERVER_ID, kinds: ["workspace"], ids: ["workspace-1"] },
      { serverId: SERVER_ID, kinds: ["project"], ids: ["project-1"] },
    ]);
  });

  it("treats a corrupt row as a scoped miss", async () => {
    const storage = new MemoryStorage();
    storage.rows.set(`${SERVER_ID}:agent:agent-1`, {
      serverId: SERVER_ID,
      kind: "agent",
      id: "agent-1",
      payload: "{bad",
    });
    storage.rows.set(`${SERVER_ID}:project:project-1`, {
      serverId: SERVER_ID,
      kind: "project",
      id: "project-1",
      payload: JSON.stringify({
        projectId: "project-1",
        projectDisplayName: "Paseo",
        projectCustomName: null,
        projectCustomIconRevision: null,
        projectRootPath: "/repo/paseo",
        projectKind: "git",
      }),
    });
    const cache = createCache(storage);

    const restored = await cache.readDirectory(SERVER_ID);

    expect(restored.agents.size).toBe(0);
    expect(restored.projects.get("project-1")?.projectDisplayName).toBe("Paseo");
    expect(storage.rows.has(`${SERVER_ID}:agent:agent-1`)).toBe(false);
    expect(storage.rows.has(`${SERVER_ID}:project:project-1`)).toBe(true);
  });

  it("removes a targeted corrupt row from eviction bookkeeping", async () => {
    const otherServerId = "other-host";
    const storage = new MemoryStorage();
    const writer = new ReplicaCache(storage, noLegacyCleanup);
    writer.setHosts([SERVER_ID, otherServerId]);
    commitDirectory(writer, SERVER_ID, directory());
    writer.commitTimeline(SERVER_ID, "agent-1", timeline());
    commitDirectory(writer, otherServerId, directory());
    await writer.flush();
    storage.rows.set(`${SERVER_ID}:agent:agent-1`, {
      serverId: SERVER_ID,
      kind: "agent",
      id: "agent-1",
      payload: `{${"x".repeat(5_000)}`,
    });
    const initialBytes = [...storage.rows.values()].reduce(
      (total, row) => total + Buffer.byteLength(row.payload),
      0,
>>>>>>> Read cached chats while other agents stream (#7074)
    );
    const secondTimeline = Array.from({ length: 60 }, (_, index) =>
      message(`message-${index}`, `Second ${index}`),
    );
    store.setAgentStreamTail(
      SERVER_ID,
      new Map([
        ["agent-1", [message("message-1", "First")]],
        ["agent-2", secondTimeline],
      ]),
    );
    store.setFocusedAgentId(SERVER_ID, "agent-2");
    await cache.flush();

    store.clearSession(SERVER_ID);
    const reader = new ReplicaCache(storage);
    reader.setHosts([SERVER_ID]);
    await reader.restore();

    const session = useSessionStore.getState().sessions[SERVER_ID];
    const timelines = session?.agentStreamTail;
    expect(Array.from(session?.agents.keys() ?? [])).toEqual(["agent-2"]);
    expect(Array.from(session?.workspaces.keys() ?? [])).toEqual(["workspace-2"]);
    expect(Array.from(session?.projects.keys() ?? [])).toEqual(["project-2"]);
    expect(Array.from(timelines?.keys() ?? [])).toEqual(["agent-2"]);
    expect(timelines?.get("agent-2")).toEqual(secondTimeline.slice(-50));

    const persisted = JSON.parse(storage.values.get("@jagentdesk:replica-cache") ?? "null") as {
      version: number;
      hosts: Array<{ timeline: Record<string, unknown> | null }>;
    };
    expect(persisted.version).toBe(3);
    expect(Object.keys(persisted.hosts[0]?.timeline ?? {}).sort()).toEqual(["agentId", "items"]);
  });

  it("persists reconciled rows without caching unreconciled local presentations", async () => {
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);
    seedSession();
    const unreconciled = createUserMessage({
      clientMessageId: "client-pending",
      text: "Pending",
      timestamp: new Date("2026-07-18T08:01:00.000Z"),
    });
    const reconciled = createUserMessage({
      clientMessageId: "client-sent",
      messageId: "provider-sent",
      timelineCursor: { epoch: "epoch-1", seq: 11 },
      text: "Sent",
      timestamp: new Date("2026-07-18T08:01:30.000Z"),
    });
    useSessionStore
      .getState()
      .setAgentStreamTail(SERVER_ID, new Map([["agent-1", [unreconciled, reconciled]]]));

    await cache.flush();
    useSessionStore.getState().clearSession(SERVER_ID);
    await cache.restore();

    expect(useSessionStore.getState().sessions[SERVER_ID]?.agentStreamTail.get("agent-1")).toEqual([
      reconciled,
    ]);
  });

<<<<<<< HEAD
  it("evicts the least recently written host when the cache exceeds its byte budget", async () => {
=======
  it("reads a persisted timeline across a concurrent directory commit", async () => {
>>>>>>> Read cached chats while other agents stream (#7074)
    const storage = new MemoryStorage();
    const cache = new ReplicaCache(storage, { maxBytes: 7_000 });
    cache.setHosts(LRU_SERVER_IDS.slice(0, 2));
    seedTimeline("host-a", "A".repeat(1_200));
    seedTimeline("host-b", "B".repeat(1_200));
    await cache.flush();

    seedTimeline("host-a", "A".repeat(1_201));
    await cache.flush();

    cache.setHosts(LRU_SERVER_IDS);
    seedTimeline("host-c", "C".repeat(1_200));
    await cache.flush();

    for (const serverId of LRU_SERVER_IDS) {
      useSessionStore.getState().clearSession(serverId);
    }
    const reader = new ReplicaCache(storage, { maxBytes: 7_000 });
    reader.setHosts(LRU_SERVER_IDS);
    await reader.restore();

    expect(Object.keys(useSessionStore.getState().sessions).sort()).toEqual(["host-a", "host-c"]);
  });

  it("rejects version 1 cache data and overwrites it on flush", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      "@jagentdesk:replica-cache",
      JSON.stringify({
        version: 1,
        hosts: [
          {
            serverId: SERVER_ID,
            agents: [],
            workspaces: [],
            emptyProjects: [],
            timeline: {
              agentId: "agent-1",
              items: [],
              cursor: { epoch: "poisoned", startSeq: 1, endSeq: 100 },
              hasOlder: false,
            },
          },
        ],
      }),
    );
    const cache = new ReplicaCache(storage);
    cache.setHosts([SERVER_ID]);

    await cache.restore();
    await cache.flush();

    expect(useSessionStore.getState().sessions[SERVER_ID]).toBeUndefined();
    expect(JSON.parse(storage.values.get("@jagentdesk:replica-cache") ?? "null")).toEqual({
      version: 3,
      hosts: [],
    });
  });

  describe.each(["timeline", "directory"] as const)(
    "while another agent streams %s updates",
    (kind) => {
      async function streamingCache() {
        const storage = new MemoryStorage();
        const cache = createCache(storage);
        commitDirectory(cache, SERVER_ID, directory());
        cache.commitTimeline(SERVER_ID, "agent-1", timeline());
        await cache.flush();
        const readsBefore = storage.reads.length;
        const writesBefore = storage.writes;
        let chunks = 0;
        storage.onRead = () => {
          if (chunks >= 200) return;
          chunks += 1;
          if (kind === "timeline") {
            cache.commitTimeline(SERVER_ID, "agent-2", {
              ...timeline(`chunk ${chunks}`),
              agentId: "agent-2",
            });
          } else {
            cache.commitDirectoryMutations(
              SERVER_ID,
              [{ type: "upsert", kind: "agent", id: "agent-2", value: agent("agent-2") }],
              { agents: { generation: "g", afterSeq: 12 + chunks } },
            );
          }
        };
        return {
          cache,
          expectReads: (count: number, writes = 0) => {
            expect(storage.reads.length - readsBefore).toBe(count);
            expect(storage.writes - writesBefore).toBe(writes);
            expect(chunks).toBe(count);
          },
        };
      }

      it("reads another cached agent without waiting for the stream to stop", async () => {
        const { cache, expectReads } = await streamingCache();

        expect((await cache.readAgent(SERVER_ID, "agent-1"))?.title).toBe("Cached agent");
        expectReads(1);
        await cache.flush();
      });

      it("reads another cached workspace without waiting for the stream to stop", async () => {
        const { cache, expectReads } = await streamingCache();

        expect((await cache.readWorkspace(SERVER_ID, "workspace-1"))?.workspace.name).toBe("main");
        expectReads(2, 1);
        await cache.flush();
      });

      it("reads another cached timeline without waiting for the stream to stop", async () => {
        const { cache, expectReads } = await streamingCache();

        expect(await cache.readTimeline(SERVER_ID, "agent-1")).toEqual(timeline());
        expectReads(1);
        await cache.flush();
      });
    },
  );

  it("reads the directory after persisting a pending baseline replacement", async () => {
    const storage = new MemoryStorage();
    const cache = createCache(storage);
    commitDirectory(cache, SERVER_ID, directory());
    cache.commitTimeline(SERVER_ID, "agent-1", timeline());
    await cache.flush();
    const replacement = directory({ agents: { generation: "g2", afterSeq: 1 } });
    replacement.projects.clear();
    replacement.agents.set("agent-2", agent("agent-2"));
    cache.replaceDirectoryBaseline(SERVER_ID, replacement);

    const read = await cache.readDirectory(SERVER_ID);

    expect([...read.agents.keys()].sort()).toEqual(["agent-1", "agent-2"]);
    expect(read.projects.size).toBe(0);
    expect(read.checkpoint).toEqual({ agents: { generation: "g2", afterSeq: 1 } });
    expect(await cache.readTimeline(SERVER_ID, "agent-1")).toEqual(timeline());
    expect(storage.writes).toBe(2);
  });
});

it("preserves where the workspace's forge is on the web across cache reopen", async () => {
  const storage = new MemoryStorage();
  const writer = new ReplicaCache(storage);
  writer.setHosts([SERVER_ID]);
  seedSession();
  const forgeWeb = { host: "github.com", referenceRepository: "main-owner/repo" };
  const row = normalizeWorkspaceDescriptor({ ...workspace(), background: false, forgeWeb });
  useSessionStore.getState().setWorkspaces(SERVER_ID, new Map([[row.id, row]]));
  await writer.flush();
  useSessionStore.getState().clearSession(SERVER_ID);
  const reader = new ReplicaCache(storage);
  reader.setHosts([SERVER_ID]);
  await reader.restore();
  expect(useSessionStore.getState().sessions[SERVER_ID]?.workspaces.get(row.id)?.forgeWeb).toEqual(
    forgeWeb,
  );
});
