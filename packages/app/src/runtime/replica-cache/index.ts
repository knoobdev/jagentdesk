import { Buffer } from "buffer";
import { z } from "zod";
import {
  AgentSnapshotPayloadSchema,
  ProjectPlacementPayloadSchema,
  WorkspaceDescriptorPayloadSchema,
  WorkspaceProjectDescriptorPayloadSchema,
  type AgentSnapshotPayload,
  type WorkspaceDescriptorPayload,
} from "@jagentdesk/protocol/messages";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  selectAgentTimelineState,
  useSessionStore,
  type Agent,
  type SessionReplica,
  type SessionState,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { isUnreconciledLocalUserMessage, type StreamItem } from "@/types/stream";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";

const STORAGE_KEY = "@jagentdesk:replica-cache";
const LEGACY_STORAGE_KEY = "@jagentdesk:replica-cache";
const CACHE_VERSION = 3;
const PERSIST_DELAY_MS = 750;
const MAX_TIMELINE_ITEMS = 50;
const MAX_CACHE_BYTES = 1024 * 1024;
const DATE_TAG = "__jagentdeskDate";

const StoredAgentSchema = z.object({
  snapshot: AgentSnapshotPayloadSchema,
  projectPlacement: ProjectPlacementPayloadSchema.nullable(),
  lastActivityAt: z.string(),
});

const StoredTimelineSchema = z.object({
  agentId: z.string(),
  items: z.unknown(),
});

const StoredHostSchema = z.object({
  serverId: z.string(),
  agents: z.array(StoredAgentSchema),
  workspaces: z.array(WorkspaceDescriptorPayloadSchema),
  projects: z.array(WorkspaceProjectDescriptorPayloadSchema).optional().default([]),
  emptyProjects: z.array(WorkspaceProjectDescriptorPayloadSchema),
  timeline: StoredTimelineSchema.nullable(),
});

const StoredCacheSchema = z.object({
  version: z.literal(CACHE_VERSION),
  hosts: z.array(StoredHostSchema),
});

type StoredAgent = z.infer<typeof StoredAgentSchema>;
type StoredHost = z.infer<typeof StoredHostSchema>;

export interface ReplicaCacheStorage {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}

interface ReplicaCacheOptions {
  maxBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string";
}

function isStreamItem(value: unknown): value is StreamItem {
  if (!isRecord(value) || !hasString(value, "id") || !(value.timestamp instanceof Date)) {
    return false;
  }
  switch (value.kind) {
    case "user_message":
    case "assistant_message":
      return hasString(value, "text");
    case "thought":
      return hasString(value, "text") && (value.status === "loading" || value.status === "ready");
    case "tool_call":
      return isRecord(value.payload) && isRecord(value.payload.data);
    case "todo_list":
      return hasString(value, "provider") && Array.isArray(value.items);
    case "activity_log":
      return hasString(value, "message") && hasString(value, "activityType");
    case "compaction":
      return value.status === "loading" || value.status === "completed";
    default:
      return false;
  }
}

function encodeDates(value: unknown): unknown {
  if (value instanceof Date) {
    return { [DATE_TAG]: value.toISOString() };
  }
  if (Array.isArray(value)) {
    return value.map(encodeDates);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeDates(entry)]));
}

function decodeDates(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeDates);
  }
  if (!isRecord(value)) {
    return value;
  }
  if (Object.keys(value).length === 1 && typeof value[DATE_TAG] === "string") {
    const date = new Date(value[DATE_TAG]);
    return Number.isNaN(date.getTime()) ? value : date;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, decodeDates(entry)]));
}

function deserializeTimeline(stored: StoredHost["timeline"]): SessionReplica["timeline"] {
  if (!stored) {
    return null;
  }
  const decoded = decodeDates(stored.items);
  if (!Array.isArray(decoded) || !decoded.every(isStreamItem)) {
    return null;
  }
  return {
    agentId: stored.agentId,
    items: decoded,
  };
}

function serializeAgent(agent: Agent): StoredAgent {
  const snapshot: AgentSnapshotPayload = {
    id: agent.id,
    provider: agent.provider,
    cwd: agent.cwd,
    ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
    model: agent.model,
    ...(agent.features ? { features: agent.features } : {}),
    thinkingOptionId: agent.thinkingOptionId ?? null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    lastUserMessageAt: agent.lastUserMessageAt?.toISOString() ?? null,
    status: agent.status,
    capabilities: agent.capabilities,
    currentModeId: agent.currentModeId,
    availableModes: agent.availableModes,
    pendingPermissions: [],
    persistence: agent.persistence,
    ...(agent.runtimeInfo ? { runtimeInfo: agent.runtimeInfo } : {}),
    ...(agent.lastUsage ? { lastUsage: agent.lastUsage } : {}),
    ...(agent.usageTotals ? { usageTotals: agent.usageTotals } : {}),
    ...(agent.lastError ? { lastError: agent.lastError } : {}),
    title: agent.title,
    labels: agent.labels,
    requiresAttention: agent.requiresAttention ?? false,
    attentionReason: agent.attentionReason ?? null,
    attentionTimestamp: agent.attentionTimestamp?.toISOString() ?? null,
    archivedAt: agent.archivedAt?.toISOString() ?? null,
  };
  return {
    snapshot,
    projectPlacement: agent.projectPlacement ?? null,
    lastActivityAt: agent.lastActivityAt.toISOString(),
  };
}

function deserializeAgent(serverId: string, stored: StoredAgent): Agent {
  return {
    ...normalizeAgentSnapshot(stored.snapshot, serverId),
    lastActivityAt: new Date(stored.lastActivityAt),
    projectPlacement: stored.projectPlacement,
  };
}

function serializeWorkspace(workspace: WorkspaceDescriptor): WorkspaceDescriptorPayload {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    projectDisplayName: workspace.projectDisplayName,
    projectCustomName: workspace.projectCustomName ?? null,
    projectCustomIconRevision: workspace.projectCustomIconRevision ?? null,
    projectRootPath: workspace.projectRootPath,
    workspaceDirectory: workspace.workspaceDirectory,
    worktreeSlug: workspace.worktreeSlug,
    projectKind: workspace.projectKind,
    workspaceKind: workspace.workspaceKind,
    background: workspace.background ?? false,
    name: workspace.name,
    title: workspace.title ?? null,
    pinnedAt: workspace.pinnedAt ?? null,
    status: workspace.status,
    statusEnteredAt: workspace.statusEnteredAt?.toISOString() ?? null,
    activityAt: null,
    archivingAt: workspace.archivingAt,
    diffStat: workspace.diffStat,
    scripts: workspace.scripts,
    gitRuntime: workspace.gitRuntime,
    githubRuntime: workspace.githubRuntime,
    forge: workspace.forge,
    forgeWeb: workspace.forgeWeb,
    project: workspace.project,
  };
}

function serializeProject(project: ProjectDescriptor) {
  return {
    projectId: project.projectId,
    ...(project.projectKey ? { projectKey: project.projectKey } : {}),
    projectDisplayName: project.projectDisplayName,
    projectCustomName: project.projectCustomName,
    projectRootPath: project.projectRootPath,
    projectKind: project.projectKind,
  };
}

function deserializeHost(stored: StoredHost): SessionReplica {
  const agents = stored.agents.map((entry) => deserializeAgent(stored.serverId, entry));
  // Older rows lost visibility metadata. Keep agent/timeline cache data while
  // the ordinary directory refresh fetches authoritative workspace descriptors.
  const workspaces = stored.workspaces
    .filter((workspace) => workspace.background !== undefined)
    .map(normalizeWorkspaceDescriptor);
  const listedProjects = stored.projects.map(normalizeProjectDescriptor);
  const legacyProjects = [
    ...stored.emptyProjects.map(normalizeProjectDescriptor),
    ...workspaces.map(legacyProjectDescriptorFromWorkspace),
  ];
  const projects = new Map(
    [...legacyProjects, ...listedProjects].map((project) => [project.projectId, project]),
  );
  return {
    agents: new Map(agents.map((agent) => [agent.id, agent])),
    workspaces: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    projects,
    timeline: deserializeTimeline(stored.timeline),
  };
}

function legacyProjectDescriptorFromWorkspace(workspace: WorkspaceDescriptor): ProjectDescriptor {
  return {
    projectId: workspace.projectId,
    projectKey: null,
    projectDisplayName: workspace.projectDisplayName,
    projectCustomName: workspace.projectCustomName ?? null,
    projectRootPath: workspace.projectRootPath,
    projectKind: workspace.projectKind,
  };
}

interface ReplicaRead {
  serverId: string;
  kinds: readonly ReplicaRowKind[];
  ids?: readonly string[];
  invalidated: boolean;
}

function matchesReplicaRead(read: ReplicaRead, row: ReplicaRowKey): boolean {
  return (
    read.serverId === row.serverId &&
    read.kinds.includes(row.kind) &&
    (!read.ids || read.ids.includes(row.id))
  );
}

export class ReplicaCache {
  private readonly activeServerIds = new Set<string>();
<<<<<<< HEAD
  private readonly storedHosts = new Map<string, StoredHost>();
  private readonly lastFocusedAgentIds = new Map<string, string>();
  private readonly capturedSessions = new Map<string, SessionState>();
=======
  private readonly activeReads = new Set<ReplicaRead>();
  private readonly storedRows = new Map<string, Map<string, ReplicaRow>>();
  private readonly hostBytes = new Map<string, number>();
  private readonly hostWriteOrder = new Map<string, true>();
  private pendingUpserts = new Map<string, StructuredReplicaUpsert>();
  private pendingDeletes = new Map<string, ReplicaRowKey>();
  private pendingBaselines = new Set<string>();
  private readonly invalidatedHosts = new Set<string>();
>>>>>>> Read cached chats while other agents stream (#7074)
  private readonly maxBytes: number;
  private needsPersist = false;
  private unsubscribe: (() => void) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: ReplicaCacheStorage,
    options: ReplicaCacheOptions = {},
  ) {
    const emptyPayloadBytes = Buffer.byteLength(
      JSON.stringify({ version: CACHE_VERSION, hosts: [] }),
      "utf8",
    );
    this.maxBytes = Math.max(options.maxBytes ?? MAX_CACHE_BYTES, emptyPayloadBytes);
  }

  setHosts(serverIds: Iterable<string>): void {
    const next = new Set(serverIds);
    this.activeServerIds.clear();
    for (const serverId of next) this.activeServerIds.add(serverId);
    let removedStoredHost = false;
    for (const serverId of this.storedHosts.keys()) {
      if (!next.has(serverId)) {
        this.storedHosts.delete(serverId);
        removedStoredHost = true;
      }
    }
    for (const serverId of this.lastFocusedAgentIds.keys()) {
      if (!next.has(serverId)) this.lastFocusedAgentIds.delete(serverId);
    }
    for (const serverId of this.capturedSessions.keys()) {
      if (!next.has(serverId)) this.capturedSessions.delete(serverId);
    }
    if (removedStoredHost) this.needsPersist = true;
    if (this.unsubscribe && this.needsPersist) this.schedulePersist();
  }

  async restore(): Promise<void> {
    let raw: string | null;
    let loadedLegacyStorage = false;
    try {
      raw = await this.storage.getItem(STORAGE_KEY);
      if (!raw) {
        raw = await this.storage.getItem(LEGACY_STORAGE_KEY);
        loadedLegacyStorage = raw !== null;
      }
    } catch {
      return;
    }
    if (!raw) return;
    let parsed: unknown;
    try {
<<<<<<< HEAD
      parsed = JSON.parse(raw);
=======
      await this.prepareStore();
      while (this.activeServerIds.has(serverId)) {
        // A read may only answer from rows the store already holds, so it waits for this host's
        // accepted commits to land. A store that rejects them will keep rejecting them: fail closed
        // rather than re-attempt the write on every pass. A write rejected for another host leaves
        // this host's stored rows readable.
        const read: ReplicaRead = { serverId, kinds, ids, invalidated: false };
        this.activeReads.add(read);
        try {
          if (!(await this.syncPending()) && this.hasPendingHostChanges(serverId)) return [];
          if (read.invalidated || this.hasPendingReadChanges(read)) continue;
          const rows = await this.rowStore.read(serverId, kinds, ids);
          if (
            this.activeServerIds.has(serverId) &&
            !read.invalidated &&
            !this.hasPendingReadChanges(read)
          ) {
            return rows;
          }
        } finally {
          this.activeReads.delete(read);
        }
      }
      return [];
>>>>>>> Read cached chats while other agents stream (#7074)
    } catch {
      return;
    }
    const cache = StoredCacheSchema.safeParse(parsed);
    if (!cache.success) return;
    if (loadedLegacyStorage) this.needsPersist = true;
    for (const host of cache.data.hosts) {
      if (!this.activeServerIds.has(host.serverId)) {
        this.needsPersist = true;
        continue;
      }
      this.storedHosts.set(host.serverId, host);
      if (host.timeline) this.lastFocusedAgentIds.set(host.serverId, host.timeline.agentId);
    }
    if (this.buildBoundedPayload().evicted) this.needsPersist = true;
    for (const host of this.storedHosts.values()) {
      useSessionStore.getState().restoreSessionReplica(host.serverId, deserializeHost(host));
      const session = useSessionStore.getState().sessions[host.serverId];
      if (session) this.capturedSessions.set(host.serverId, session);
    }
  }

<<<<<<< HEAD
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = useSessionStore.subscribe((state) => {
      if (this.activeServerIds.size === 0) return;
      for (const serverId of this.activeServerIds) {
        const focusedAgentId = state.sessions[serverId]?.focusedAgentId;
        if (focusedAgentId) this.lastFocusedAgentIds.set(serverId, focusedAgentId);
=======
  commitDirectoryMutations(
    serverId: string,
    mutations: readonly DirectoryReplicaMutation[],
    checkpoint?: DirectoryCheckpoint,
  ): void {
    if (!this.activeServerIds.has(serverId)) return;
    if (this.invalidatedHosts.has(serverId)) return;
    for (const mutation of mutations) {
      if (mutation.type === "delete") {
        this.queueEntityDelete(serverId, mutation.kind, mutation.id);
      } else {
        this.queueUpsert({
          serverId,
          kind: mutation.kind,
          id: mutation.id,
          value: mutation.value,
        } as StructuredReplicaUpsert);
>>>>>>> Read cached chats while other agents stream (#7074)
      }
      this.schedulePersist();
    });
    if (this.needsPersist) this.schedulePersist();
  }

<<<<<<< HEAD
  reconcileServerId(oldServerId: string, newServerId: string): void {
    const stored = this.storedHosts.get(oldServerId);
    if (stored) {
      this.storedHosts.delete(oldServerId);
      this.storedHosts.set(newServerId, { ...stored, serverId: newServerId });
=======
  replaceDirectoryBaseline(serverId: string, directory: CachedDirectory): void {
    if (!this.activeServerIds.has(serverId)) return;
    this.invalidateHostReads(serverId, ["agent", "workspace", "project", "checkpoint"]);
    // Replacing the directory must not discard independently accepted timeline changes.
    for (const [key, row] of this.pendingUpserts) {
      if (row.serverId === serverId && row.kind !== "timeline") this.pendingUpserts.delete(key);
    }
    for (const [key, row] of this.pendingDeletes) {
      if (row.serverId === serverId && row.kind !== "timeline") this.pendingDeletes.delete(key);
    }
    this.pendingBaselines.add(serverId);
    for (const [id, value] of directory.agents) {
      this.queueUpsert({ serverId, kind: "agent", id, value });
    }
    for (const [id, value] of directory.workspaces) {
      this.queueUpsert({ serverId, kind: "workspace", id, value });
>>>>>>> Read cached chats while other agents stream (#7074)
    }
    const focusedAgentId = this.lastFocusedAgentIds.get(oldServerId);
    if (focusedAgentId) {
      this.lastFocusedAgentIds.delete(oldServerId);
      this.lastFocusedAgentIds.set(newServerId, focusedAgentId);
    }
    const capturedSession = this.capturedSessions.get(oldServerId);
    if (capturedSession) {
      this.capturedSessions.delete(oldServerId);
      this.capturedSessions.set(newServerId, capturedSession);
    }
    if (this.activeServerIds.delete(oldServerId)) this.activeServerIds.add(newServerId);
    this.needsPersist = true;
    this.schedulePersist();
  }

<<<<<<< HEAD
  /**
   * Rewrite the agent ids inside a host's cached snapshot after a migration
   * assigned new ids on the target daemon (idMap: oldAgentId -> newAgentId). Keeps
   * the offline replica coherent until the target daemon re-pushes authoritative
   * agent state on reconnect.
   */
  remapAgentIds(serverId: string, idMap: Record<string, string>): void {
    if (Object.keys(idMap).length === 0) return;
    const remap = (id: string): string => idMap[id] ?? id;
    const stored = this.storedHosts.get(serverId);
    if (stored) {
      this.storedHosts.set(serverId, {
        ...stored,
        agents: stored.agents.map((agent) => ({
          ...agent,
          snapshot: { ...agent.snapshot, id: remap(agent.snapshot.id) },
        })),
        timeline: stored.timeline
          ? { ...stored.timeline, agentId: remap(stored.timeline.agentId) }
          : stored.timeline,
      });
    }
    const focusedAgentId = this.lastFocusedAgentIds.get(serverId);
    if (focusedAgentId) {
      this.lastFocusedAgentIds.set(serverId, remap(focusedAgentId));
=======
  commitTimeline(serverId: string, agentId: string, timeline: CachedTimeline): void {
    if (!this.activeServerIds.has(serverId)) return;
    if (timeline.agentId !== agentId) throw new Error("Timeline cache key does not match payload");
    this.queueUpsert({ serverId, kind: "timeline", id: agentId, value: timeline });
    this.schedulePersist();
  }

  setHosts(serverIds: Iterable<string>): void {
    const next = new Set(serverIds);
    const removed = [...this.activeServerIds].filter((serverId) => !next.has(serverId));
    const added = [...next].filter((serverId) => !this.activeServerIds.has(serverId));
    for (const serverId of [...removed, ...added]) this.invalidateHostReads(serverId);
    this.activeServerIds.clear();
    for (const serverId of next) this.activeServerIds.add(serverId);
    for (const serverId of removed) {
      this.removeStoredHost(serverId);
      this.dropPendingHostChanges(serverId);
      this.invalidatedHosts.delete(serverId);
      this.queueOperation(() => this.rowStore.deleteHost(serverId));
    }
  }

  reconcileServerId(oldServerId: string, newServerId: string): void {
    this.invalidateHostReads(oldServerId);
    this.invalidateHostReads(newServerId);
    const rows = this.storedRows.get(oldServerId);
    if (rows) {
      const newRows = this.storedRows.get(newServerId) ?? new Map<string, ReplicaRow>();
      this.totalBytes -=
        (this.hostBytes.get(oldServerId) ?? 0) + (this.hostBytes.get(newServerId) ?? 0);
      this.storedRows.delete(oldServerId);
      for (const [key, row] of rows) newRows.set(key, { ...row, serverId: newServerId });
      this.storedRows.set(newServerId, newRows);
      const bytes = [...newRows.values()].reduce((sum, row) => sum + rowBytes(row), 0);
      this.hostBytes.delete(oldServerId);
      this.hostBytes.set(newServerId, bytes);
      this.totalBytes += bytes;
      this.hostWriteOrder.delete(oldServerId);
      this.touchHost(newServerId);
>>>>>>> Read cached chats while other agents stream (#7074)
    }
    this.needsPersist = true;
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.captureSessions();
    const { payload } = this.buildBoundedPayload();
    this.needsPersist = false;
    const write = this.writeQueue
      .catch(() => undefined)
<<<<<<< HEAD
      .then(() => this.storage.setItem(STORAGE_KEY, payload));
    this.writeQueue = write;
    await write.catch(() => undefined);
  }

  private captureSessions(): void {
    const sessions = useSessionStore.getState().sessions;
    for (const serverId of this.activeServerIds) {
      const session = sessions[serverId];
      if (!session) continue;
      if (this.capturedSessions.get(serverId) === session) continue;
      this.capturedSessions.set(serverId, session);
      if (session.focusedAgentId) {
        this.lastFocusedAgentIds.set(serverId, session.focusedAgentId);
=======
      .then(async () => {
        const pending = this.drainPendingChanges();
        try {
          await this.prepareStore();
          await this.ensureStoredIndex();
          const changes = this.materializePendingChanges(pending);
          const { changes: boundedChanges, evicted } = await this.fitChangesToBudget(changes);
          if (boundedChanges.upserts.length > 0 || boundedChanges.deletes.length > 0) {
            await this.rowStore.apply(boundedChanges);
            this.applyStoredChanges(boundedChanges);
          }
          for (const serverId of pending.baselines) {
            if (!evicted.has(serverId)) this.invalidatedHosts.delete(serverId);
          }
        } catch {
          this.restorePendingChanges(pending);
          if (this.hasPendingChanges()) this.schedulePersist();
          return false;
        }
        return true;
      });
    // The queue only sequences writes; every consumer decides for itself what a failure means.
    this.writeQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private queueEntityDelete(serverId: string, kind: ReplicaRowKind, id: string): void {
    this.queueDelete({ serverId, kind, id });
  }

  private queueUpsert(row: StructuredReplicaUpsert): void {
    this.invalidateRowReads(row);
    const key = pendingRowKey(row);
    this.pendingDeletes.delete(key);
    this.pendingUpserts.set(key, row);
  }

  private queueDelete(key: ReplicaRowKey): void {
    this.invalidateRowReads(key);
    const pendingKey = pendingRowKey(key);
    this.pendingUpserts.delete(pendingKey);
    this.pendingDeletes.set(pendingKey, key);
  }

  private hasPendingChanges(): boolean {
    return (
      this.pendingUpserts.size > 0 || this.pendingDeletes.size > 0 || this.pendingBaselines.size > 0
    );
  }

  private hasPendingReadChanges(read: ReplicaRead): boolean {
    if (
      this.pendingBaselines.has(read.serverId) &&
      read.kinds.some((kind) => kind !== "timeline")
    ) {
      return true;
    }
    return (
      [...this.pendingUpserts.values()].some((row) => matchesReplicaRead(read, row)) ||
      [...this.pendingDeletes.values()].some((row) => matchesReplicaRead(read, row))
    );
  }

  private invalidateRowReads(row: ReplicaRowKey): void {
    for (const read of this.activeReads) {
      if (matchesReplicaRead(read, row)) read.invalidated = true;
    }
  }

  private invalidateHostReads(serverId: string, kinds?: readonly ReplicaRowKind[]): void {
    for (const read of this.activeReads) {
      if (
        read.serverId === serverId &&
        (!kinds || kinds.some((kind) => read.kinds.includes(kind)))
      ) {
        read.invalidated = true;
      }
    }
  }

  private hasPendingHostChanges(serverId: string): boolean {
    if (this.pendingBaselines.has(serverId)) return true;
    for (const row of this.pendingUpserts.values()) {
      if (row.serverId === serverId) return true;
    }
    for (const row of this.pendingDeletes.values()) {
      if (row.serverId === serverId) return true;
    }
    return false;
  }

  private drainPendingChanges(): PendingReplicaChanges {
    const changes = {
      upserts: [...this.pendingUpserts.values()],
      deletes: [...this.pendingDeletes.values()],
      baselines: this.pendingBaselines,
    };
    this.pendingUpserts = new Map();
    this.pendingDeletes = new Map();
    this.pendingBaselines = new Set();
    return changes;
  }

  private materializePendingChanges(pending: PendingReplicaChanges): ReplicaRowChanges {
    const deletes = new Map(pending.deletes.map((row) => [pendingRowKey(row), row]));
    const upserts: ReplicaRow[] = [];
    for (const upsert of pending.upserts) {
      const row = this.materializeUpsert(upsert);
      if (row) upserts.push(row);
      else deletes.set(pendingRowKey(upsert), upsert);
    }
    for (const serverId of pending.baselines) {
      const replacementKeys = new Set(
        upserts.filter((row) => row.serverId === serverId && row.kind !== "timeline").map(rowKey),
      );
      for (const row of this.storedRows.get(serverId)?.values() ?? []) {
        if (row.kind !== "timeline" && !replacementKeys.has(rowKey(row))) {
          deletes.set(pendingRowKey(row), row);
        }
      }
    }
    return { upserts, deletes: [...deletes.values()] };
  }

  private materializeUpsert(upsert: StructuredReplicaUpsert): ReplicaRow | null {
    let value: unknown;
    switch (upsert.kind) {
      case "agent":
        value = serializeAgent(upsert.value);
        break;
      case "workspace":
        value = serializeWorkspace(upsert.value);
        break;
      case "project":
        value = serializeProject(upsert.value);
        break;
      case "timeline":
        value = serializeTimeline(upsert.value);
        if (!value) return null;
        break;
      case "checkpoint":
        value = serializeDirectoryCheckpoint(upsert.value);
        break;
    }
    return {
      serverId: upsert.serverId,
      kind: upsert.kind,
      id: upsert.id,
      payload: JSON.stringify(value),
    };
  }

  private restorePendingChanges(changes: PendingReplicaChanges): void {
    for (const serverId of changes.baselines) {
      if (this.activeServerIds.has(serverId)) this.pendingBaselines.add(serverId);
    }
    for (const key of changes.deletes) {
      const pendingKey = pendingRowKey(key);
      if (
        this.activeServerIds.has(key.serverId) &&
        !this.pendingUpserts.has(pendingKey) &&
        !this.pendingDeletes.has(pendingKey)
      ) {
        this.queueDelete(key);
      }
    }
    for (const row of changes.upserts) {
      const pendingKey = pendingRowKey(row);
      if (
        this.activeServerIds.has(row.serverId) &&
        !this.pendingUpserts.has(pendingKey) &&
        !this.pendingDeletes.has(pendingKey)
      ) {
        this.queueUpsert(row);
      }
    }
  }

  private applyStoredChanges(changes: ReplicaRowChanges): void {
    const touchedServerIds = new Set<string>();
    for (const key of changes.deletes) {
      const rows = this.storedRows.get(key.serverId);
      const previous = rows?.get(rowKey(key));
      if (previous) {
        rows?.delete(rowKey(key));
        this.adjustHostBytes(key.serverId, -rowBytes(previous));
>>>>>>> Read cached chats while other agents stream (#7074)
      }
      const focusedAgentId = this.lastFocusedAgentIds.get(serverId) ?? null;
      const focusedAgent = focusedAgentId ? session.agents.get(focusedAgentId) : undefined;
      const focusedWorkspace = focusedAgent
        ? ((focusedAgent.workspaceId
            ? session.workspaces.get(focusedAgent.workspaceId)
            : undefined) ??
          Array.from(session.workspaces.values()).find(
            (workspace) => workspace.workspaceDirectory === focusedAgent.cwd,
          ))
        : undefined;
      const timelineState = focusedAgentId
        ? selectAgentTimelineState(session, focusedAgentId)
        : { status: "cold" as const };
      const items =
        timelineState.status === "cold"
          ? undefined
          : timelineState.items.filter(
              (item) => item.kind !== "user_message" || !isUnreconciledLocalUserMessage(item),
            );
      const timeline =
        focusedAgent && items
          ? {
              agentId: focusedAgent.id,
              items: encodeDates(items.slice(-MAX_TIMELINE_ITEMS)),
            }
          : null;
      const stored: StoredHost = {
        serverId,
        agents: focusedAgent ? [serializeAgent(focusedAgent)] : [],
        workspaces: focusedWorkspace ? [serializeWorkspace(focusedWorkspace)] : [],
        projects: focusedWorkspace
          ? [session.projects.get(focusedWorkspace.projectId)].flatMap((project) =>
              project ? [serializeProject(project)] : [],
            )
          : [],
        emptyProjects: [],
        timeline,
      };
      this.storedHosts.delete(serverId);
      this.storedHosts.set(serverId, stored);
    }
  }

  private buildBoundedPayload(): { payload: string; evicted: boolean } {
    let evicted = false;
    let payload = this.serialize();
    while (Buffer.byteLength(payload, "utf8") > this.maxBytes && this.storedHosts.size > 0) {
      const oldestServerId = this.storedHosts.keys().next().value;
      if (oldestServerId === undefined) break;
      this.storedHosts.delete(oldestServerId);
      evicted = true;
      payload = this.serialize();
    }
    return { payload, evicted };
  }

  private serialize(): string {
    return JSON.stringify({
      version: CACHE_VERSION,
      hosts: Array.from(this.storedHosts.values()),
    });
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush();
    }, PERSIST_DELAY_MS);
  }
}
