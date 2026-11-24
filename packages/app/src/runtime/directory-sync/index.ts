import type { AgentSnapshotPayload } from "@jagentdesk/protocol/messages";
import type {
  DaemonClient,
  FetchAgentsEntry,
  FetchAgentsOptions,
} from "@jagentdesk/client/internal/daemon-client";
import { fetchAgentTimelineOnce } from "@/timeline/fetch-agent-timeline-once";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  useSessionStore,
  type Agent,
  type ProjectDescriptor,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  readLegacyDaemonWorkspaceDirectory,
  buildLegacyWorkspaces,
  shouldUseLegacyDaemonWorkspaceDirectory,
  stampLegacyWorkspaceIds,
} from "@/workspace/legacy-daemon-workspaces";
import type { AgentDirectoryDelta } from "@/utils/agent-directory-sync";
import { AgentDirectoryReplica } from "./agent-replica";
import {
  WorkspaceDirectoryReplica,
  type WorkspaceDirectoryDelta,
  type WorkspaceDirectorySnapshot,
} from "./workspace-replica";
import {
  DirectoryTransactionOwner,
  type DirectorySourceToken,
  type DirectoryTransaction,
} from "./transaction";
import type {
  CachedDirectory,
  CachedWorkspace,
  DirectoryCheckpoint,
  DirectoryReplicaMutation,
} from "@/runtime/replica-cache";

const PAGE_LIMIT = 200;
const AGENT_SORT: NonNullable<FetchAgentsOptions["sort"]> = [
  { key: "updated_at", direction: "desc" },
];

interface AgentSnapshot {
  entries: FetchAgentsEntry[];
  subscriptionId: string | null;
  legacy: boolean;
}

export interface DirectoryConnection {
  client: DaemonClient | null;
  status: "online" | "offline";
  source: DirectorySourceToken;
}

export interface DirectoryCheckpointStorage {
  readAgent(serverId: string, agentId: string): Promise<Agent | undefined>;
  readWorkspace(serverId: string, workspaceId: string): Promise<CachedWorkspace | undefined>;
  readDirectory(serverId: string): Promise<CachedDirectory>;
  commitDirectoryMutations(
    serverId: string,
    mutations: readonly DirectoryReplicaMutation[],
    checkpoint?: DirectoryCheckpoint,
  ): void;
  replaceDirectoryBaseline(serverId: string, directory: CachedDirectory): void;
}

export interface RefreshAgentDirectoryInput {
  filter?: FetchAgentsOptions["filter"];
  subscribe?: FetchAgentsOptions["subscribe"];
  page?: FetchAgentsOptions["page"];
}

export interface RefreshAgentDirectoryResult {
  agents: Map<string, Agent>;
  subscriptionId: string | null;
}

export class DirectorySync {
  private readonly agentTransactions = new DirectoryTransactionOwner<
    AgentSnapshot,
    AgentDirectoryDelta
  >();
  private readonly workspaceTransactions = new DirectoryTransactionOwner<
    WorkspaceDirectorySnapshot,
    WorkspaceDirectoryDelta
  >();
  private readonly agents: AgentDirectoryReplica;
  private readonly workspaces: WorkspaceDirectoryReplica;
  private connection: DirectoryConnection = {
    client: null,
    status: "offline",
    source: { clientGeneration: 0, connectionEpoch: 0 },
  };
  private unsubscribe: (() => void) | null = null;
  private readonly abortSessionWaits = new Set<() => void>();
  private cacheLoad: Promise<void> | null = null;
  private cacheAccepted = false;
  private revision = 0;
  private workspaceRevision = 0;
  private readonly routeDemandIds = new Set<string>();
  private readonly fullDemandSources = new Set<object>();
  private demandRefresh: Promise<void> | null = null;
  private satisfiedDemandSource: DirectorySourceToken | null = null;
  private cursors: DirectoryCheckpoint = {};
  private persistedDirectory: CachedDirectory | null = null;

  constructor(
    private readonly serverId: string,
    private readonly callbacks: {
      onAgentStoppedRunning: (agentId: string) => void;
      markAgentLoading: () => void;
      markAgentReady: () => void;
      markAgentError: (error: string) => void;
    },
    private readonly checkpoints?: DirectoryCheckpointStorage,
  ) {
    this.agents = new AgentDirectoryReplica(serverId, callbacks.onAgentStoppedRunning);
    this.workspaces = new WorkspaceDirectoryReplica(serverId);
  }

  connectionChanged(connection: DirectoryConnection): boolean {
    const changed =
      this.connection.client !== connection.client ||
      this.connection.source.clientGeneration !== connection.source.clientGeneration ||
      this.connection.source.connectionEpoch !== connection.source.connectionEpoch;
    const wentOffline = this.connection.status === "online" && connection.status === "offline";
    if (!changed && !wentOffline) {
      this.connection = connection;
      return false;
    }
    this.flushAbortedTransactions();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.connection = connection;
    this.abortPendingSessionWaits();
    if (!connection.client || connection.status !== "online") return true;
    const client = connection.client;
    const source = connection.source;
    this.workspaceTransactions.begin(source, () => ({
      workspaces: new Map(),
      projects: new Map(),
    }));
    const subscriptions = [
      client.on("agent_update", (message) => {
        if (message.type !== "agent_update" || !this.isCurrent(client, source)) return;
        this.revision += 1;
        const recorded = this.agentTransactions.record(source, message.payload);
        if (!recorded) {
          this.agents.applyDelta(message.payload);
          this.persistDirectory();
        }
      }),
      client.on("workspace_update", (message) => {
        if (message.type !== "workspace_update" || !this.isCurrent(client, source)) return;
        this.revision += 1;
        this.workspaceRevision += 1;
        const recorded = this.workspaceTransactions.record(source, message.payload);
        if (!recorded) {
          this.workspaces.applyDelta(message.payload);
          this.persistDirectory();
        }
      }),
      client.on("project.update", (message) => {
        if (message.type !== "project.update" || !this.isCurrent(client, source)) return;
        this.revision += 1;
        this.workspaceRevision += 1;
        const recorded = this.workspaceTransactions.record(source, message.payload);
        if (!recorded) {
          this.workspaces.applyDelta(message.payload);
          this.persistDirectory();
        }
      }),
      client.on("script_status_update", (message) => {
        if (message.type !== "script_status_update" || !this.isCurrent(client, source)) return;
        this.revision += 1;
        this.workspaceRevision += 1;
        const delta: WorkspaceDirectoryDelta = {
          kind: "script_status",
          update: message.payload,
        };
        const recorded = this.workspaceTransactions.record(source, delta);
        if (!recorded) {
          this.workspaces.applyDelta(delta);
          this.persistDirectory();
        }
      }),
      client.on("agent_deleted", (message) => {
        if (message.type === "agent_deleted" && this.isCurrent(client, source)) {
          this.revision += 1;
          this.agents.remove(message.payload.agentId);
          this.persistDirectory();
        }
      }),
      client.on("agent_archived", (message) => {
        if (message.type === "agent_archived" && this.isCurrent(client, source)) {
          this.revision += 1;
          this.agents.archive(message.payload.agentId, message.payload.archivedAt);
          this.persistDirectory();
        }
      }),
    ];
    this.unsubscribe = () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
    if (this.hasDemand()) void this.requestDemandRefresh().catch(() => undefined);
    return true;
  }

  setDemand(source: object, demanded: boolean): void {
    const wasDemanded = this.fullDemandSources.size > 0;
    if (demanded) this.fullDemandSources.add(source);
    else this.fullDemandSources.delete(source);
    if (!wasDemanded && this.fullDemandSources.size > 0) {
      void this.loadCachedDirectory().catch(() => undefined);
      if (this.getOnlineConnection()) void this.requestDemandRefresh().catch(() => undefined);
    }
  }

  setAgentRouteDemand(agentIds: readonly string[]): void {
    const next = new Set(agentIds);
    if (
      next.size === this.routeDemandIds.size &&
      [...next].every((agentId) => this.routeDemandIds.has(agentId))
    ) {
      return;
    }
    this.routeDemandIds.clear();
    for (const agentId of next) this.routeDemandIds.add(agentId);
    if (this.routeDemandIds.size > 0 && this.getOnlineConnection()) {
      void this.requestDemandRefresh().catch(() => undefined);
    }
  }

  dispose(): void {
    this.flushAbortedTransactions();
    this.abortPendingSessionWaits();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.fullDemandSources.clear();
    this.routeDemandIds.clear();
  }

  private hasDemand(): boolean {
    return this.fullDemandSources.size > 0 || this.routeDemandIds.size > 0;
  }

  private requestDemandRefresh(force = false): Promise<void> {
    if (this.demandRefresh) return this.demandRefresh;
    if (!this.hasDemand()) return Promise.resolve();
    if (!this.getOnlineConnection()) {
      return this.fullDemandSources.size > 0 ? this.loadCachedDirectory() : Promise.resolve();
    }
    const source = this.connection.source;
    if (
      !force &&
      this.satisfiedDemandSource?.clientGeneration === source.clientGeneration &&
      this.satisfiedDemandSource.connectionEpoch === source.connectionEpoch
    ) {
      return Promise.resolve();
    }
    const refresh =
      this.fullDemandSources.size > 0
        ? this.refreshAll()
        : Promise.all([
            this.refreshAgentsInternal(
              { subscribe: { subscriptionId: `app:${this.serverId}` } },
              false,
            ),
            this.refreshWorkspacesInternal({ subscribe: true }, false),
          ]).then(() => undefined);
    this.demandRefresh = refresh
      .then(() => {
        this.satisfiedDemandSource = source;
        return undefined;
      })
      .finally(() => {
        this.demandRefresh = null;
        const current = this.connection.source;
        if (
          this.hasDemand() &&
          (current.clientGeneration !== source.clientGeneration ||
            current.connectionEpoch !== source.connectionEpoch)
        ) {
          void this.requestDemandRefresh().catch(() => undefined);
        }
      });
    return this.demandRefresh;
  }

  refreshDemand(): Promise<void> {
    return this.requestDemandRefresh(true);
  }

  async loadCachedAgent(agentId: string): Promise<void> {
    if (!this.checkpoints) return;
    if (useSessionStore.getState().sessions[this.serverId]?.agents.has(agentId)) return;
    const token = this.agents.captureCache(agentId);
    const agent = await this.checkpoints.readAgent(this.serverId, agentId);
    if (!agent) return;
    const session = useSessionStore.getState().sessions[this.serverId];
    if (!session || session.agents.has(agentId)) return;
    this.agents.commitCachedAgent(token, agent);
  }

  async prepareAgentRoute(agentId: string): Promise<void> {
    await this.loadCachedAgent(agentId);
    const agent = useSessionStore.getState().sessions[this.serverId]?.agents.get(agentId);
    if (agent?.workspaceId) await this.loadCachedWorkspace(agent.workspaceId);
  }

  async prepareWorkspaceRoute(workspaceId: string): Promise<void> {
    await this.loadCachedWorkspace(workspaceId);
  }

  private async loadCachedWorkspace(workspaceId: string): Promise<void> {
    if (!this.checkpoints) return;
    if (useSessionStore.getState().sessions[this.serverId]?.workspaces.has(workspaceId)) return;
    const revision = this.workspaceRevision;
    const cached = await this.checkpoints.readWorkspace(this.serverId, workspaceId);
    if (!cached) return;
    if (this.workspaceRevision !== revision) return;
    const session = useSessionStore.getState().sessions[this.serverId];
    if (!session) return;
    this.workspaces.commitCachedWorkspace(cached.workspace, cached.project);
  }

  private loadCachedDirectory(): Promise<void> {
    const checkpoints = this.checkpoints;
    if (!checkpoints) return Promise.resolve();
    this.cacheLoad ??= (async () => {
      const revision = this.revision;
      const initial = useSessionStore.getState().sessions[this.serverId];
      if (!initial) return;
      const initialAgents = initial.agents;
      const initialWorkspaces = initial.workspaces;
      const initialProjects = initial.projects;
      const pristine =
        initialAgents.size === 0 && initialWorkspaces.size === 0 && initialProjects.size === 0;
      const cached = await checkpoints.readDirectory(this.serverId);
      if (this.cacheAccepted || !pristine || this.revision !== revision) return;
      const session = useSessionStore.getState().sessions[this.serverId];
      if (
        !session ||
        session.agents !== initialAgents ||
        session.workspaces !== initialWorkspaces ||
        session.projects !== initialProjects
      ) {
        return;
      }
      this.agents.commitCached(cached.agents);
      this.workspaces.commitCached(cached);
      this.cursors = cached.checkpoint ?? {};
      this.cacheAccepted = true;
    })();
    return this.cacheLoad;
  }

  async fetchTimeline(
    agentId: string,
    request: Parameters<DaemonClient["fetchAgentTimeline"]>[1],
  ): Promise<Awaited<ReturnType<DaemonClient["fetchAgentTimeline"]>>> {
    const { client } = this.requireOnline();
    const token = this.agents.captureTimeline(agentId);
    const page = await fetchAgentTimelineOnce(client, agentId, request);
    if (page.agent && this.agents.submitTimelineAgent(token, page.agent)) {
      this.revision += 1;
      this.persistDirectory();
    }
    return page;
  }

  captureSubscribedAgents(
    agentIds: string[],
  ): (agents: Record<string, AgentSnapshotPayload>) => void {
    const tokens = new Map(agentIds.map((id) => [id, this.agents.captureTimeline(id)]));
    return (agents) => {
      let accepted = false;
      for (const [agentId, agent] of Object.entries(agents)) {
        const token = tokens.get(agentId);
        if (token && this.agents.submitTimelineAgent(token, agent)) accepted = true;
      }
      if (!accepted) return;
      this.revision += 1;
      this.persistDirectory();
    };
  }

  async refreshAgents(
    input: RefreshAgentDirectoryInput = {},
  ): Promise<RefreshAgentDirectoryResult> {
    return this.refreshAgentsInternal(input, true);
  }

  private async refreshAgentsInternal(
    input: RefreshAgentDirectoryInput,
    loadDirectoryCache: boolean,
  ): Promise<RefreshAgentDirectoryResult> {
    if (loadDirectoryCache) {
      this.primeAgentTransactionForCacheLoad();
      await this.loadCachedDirectory();
    }
    const onlineConnection = this.getOnlineConnection();
    if (!onlineConnection) {
      this.callbacks.markAgentReady();
      return {
        agents: new Map(useSessionStore.getState().sessions[this.serverId]?.agents),
        subscriptionId: null,
      };
    }
    const { client, source } = onlineConnection;
    const transaction = this.agentTransactions.begin(source, () => ({
      entries: [],
      subscriptionId: null,
      legacy: false,
    }));
    this.callbacks.markAgentLoading();
    try {
      await this.waitForSession(client, source);
      const session = useSessionStore.getState().sessions[this.serverId];
      if (!input.filter && shouldUseLegacyDaemonWorkspaceDirectory(session?.serverInfo)) {
        const directory = await readLegacyDaemonWorkspaceDirectory({
          client,
          subscribe: input.subscribe,
          page: input.page,
        });
        if (
          !directory ||
          !this.agentTransactions.isCurrent(transaction) ||
          !this.isCurrent(client, source)
        ) {
          throw new DirectoryRefreshSupersededError("legacy fetch no longer current");
        }
        transaction.snapshot.entries.push(...stampLegacyWorkspaceIds(directory.entries));
        transaction.snapshot.subscriptionId = directory.subscriptionId;
        transaction.snapshot.legacy = true;
      } else {
        await this.fetchAgents(client, source, transaction, input);
      }
      if (!this.isCurrent(client, source) || !this.hasMatchingSession(client, source)) {
        throw new DirectoryRefreshSupersededError("agent completion no longer current");
      }
      const completion = this.agentTransactions.complete(transaction);
      if (completion.kind === "stale") {
        throw new DirectoryRefreshSupersededError("agent completion was superseded");
      }
      if (completion.snapshot.legacy) {
        const store = useSessionStore.getState();
        const workspaces = buildLegacyWorkspaces(completion.snapshot.entries);
        store.setWorkspaces(this.serverId, workspaces);
        store.setProjects(
          this.serverId,
          Array.from(workspaces.values(), legacyProjectDescriptorFromWorkspace),
        );
        store.setHasHydratedWorkspaces(this.serverId, true);
      }
      const deltas = completion.snapshot.legacy
        ? completion.deltas.map((delta) =>
            delta.kind === "upsert"
              ? { ...delta, agent: { ...delta.agent, workspaceId: delta.agent.cwd } }
              : delta,
          )
        : completion.deltas;
      this.revision += 1;
      const agents = this.agents.commitSnapshot(completion.snapshot.entries, deltas);
      this.persistDirectory();
      this.callbacks.markAgentReady();
      return { agents, subscriptionId: completion.snapshot.subscriptionId };
    } catch (error) {
      const deltas = this.agentTransactions.fail(transaction);
      if (deltas) for (const delta of deltas) this.agents.applyDelta(delta);
      if (!(error instanceof DirectoryRefreshSupersededError)) {
        this.callbacks.markAgentError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  async refreshWorkspaces(input?: { subscribe?: boolean }): Promise<void> {
    return this.refreshWorkspacesInternal(input, true);
  }

  private async refreshWorkspacesInternal(
    input: { subscribe?: boolean } | undefined,
    loadDirectoryCache: boolean,
  ): Promise<void> {
    if (loadDirectoryCache) await this.loadCachedDirectory();
    const onlineConnection = this.getOnlineConnection();
    if (!onlineConnection) return;
    const { client, source } = onlineConnection;
    const transaction = this.workspaceTransactions.begin(source, () => ({
      workspaces: new Map(),
      projects: new Map(),
    }));
    try {
      await this.waitForSessionMetadata(client, source);
      const serverInfo = useSessionStore.getState().sessions[this.serverId]?.serverInfo;
      if (serverInfo?.features?.workspaceMultiplicity !== true) {
        const deltas = this.workspaceTransactions.fail(transaction);
        if (deltas) for (const delta of deltas) this.workspaces.applyDelta(delta);
        return;
      }
      const supportsProjectList = serverInfo.features?.projectList === true;
      const projectsReady = supportsProjectList
        ? client.listProjects().then((payload) => {
            this.assertWorkspaceTransactionCurrent(client, source, transaction);
            for (const entry of payload.projects) {
              const project = normalizeProjectDescriptor(entry);
              transaction.snapshot.projects.set(project.projectId, project);
            }
            return undefined;
          })
        : Promise.resolve();
      await Promise.all([
        projectsReady,
        this.fetchWorkspaceSnapshot(
          client,
          source,
          transaction,
          input?.subscribe === true,
          projectsReady,
        ),
      ]);
      if (!supportsProjectList) this.buildLegacyProjectSnapshot(transaction.snapshot);
      if (!this.isCurrent(client, source) || !this.hasMatchingSession(client, source)) {
        throw new DirectoryRefreshSupersededError("workspace completion no longer current");
      }
      const completion = this.workspaceTransactions.complete(transaction);
      if (completion.kind === "stale") {
        throw new DirectoryRefreshSupersededError("workspace completion was superseded");
      }
      this.revision += 1;
      this.workspaceRevision += 1;
      this.workspaces.commitSnapshot(completion.snapshot, completion.deltas);
      this.persistDirectory();
    } catch (error) {
      const deltas = this.workspaceTransactions.fail(transaction);
      if (deltas) for (const delta of deltas) this.workspaces.applyDelta(delta);
      throw error;
    }
  }

  private async fetchWorkspaceSnapshot(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<WorkspaceDirectorySnapshot, WorkspaceDirectoryDelta>,
    initialSubscribe: boolean,
    projectsReady: Promise<void>,
  ): Promise<void> {
    let cursor: string | null = null;
    let subscribe = initialSubscribe;
    while (true) {
      const payload = await client.fetchWorkspaces({
        ...(client.getLastServerInfoMessage()?.features?.backgroundWorkspaces === true
          ? { includeBackground: true }
          : {}),
        sort: [{ key: "activity_at", direction: "desc" }],
        ...(subscribe ? { subscribe: {} } : {}),
        page: cursor ? { limit: PAGE_LIMIT, cursor } : { limit: PAGE_LIMIT },
      });
      // Apply the project baseline before empty-project overlays, regardless of response order.
      await projectsReady;
      this.assertWorkspaceTransactionCurrent(client, source, transaction);
      if (cursor === null && true) {
        transaction.snapshot.workspaces.clear();
      }
      for (const entry of payload.entries) {
        const workspace = normalizeWorkspaceDescriptor(entry);
        transaction.snapshot.workspaces.set(workspace.id, workspace);
      }
      for (const entry of payload.emptyProjects ?? []) {
        const project = normalizeProjectDescriptor(entry);
        transaction.snapshot.projects.set(project.projectId, project);
      }
      if (!payload.pageInfo.hasMore || !payload.pageInfo.nextCursor) return;
      cursor = payload.pageInfo.nextCursor;
      subscribe = false;
    }
  }

  private buildLegacyProjectSnapshot(snapshot: WorkspaceDirectorySnapshot): void {
    for (const workspace of snapshot.workspaces.values()) {
      if (!snapshot.projects.has(workspace.projectId)) {
        const project = legacyProjectDescriptorFromWorkspace(workspace);
        snapshot.projects.set(project.projectId, project);
      }
    }
  }

  async refreshAll(): Promise<void> {
    await Promise.all([
      this.refreshAgents({ subscribe: { subscriptionId: `app:${this.serverId}` } }),
      this.refreshWorkspaces({ subscribe: true }),
    ]);
  }

  private async fetchAgents(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<AgentSnapshot, AgentDirectoryDelta>,
    input: RefreshAgentDirectoryInput,
  ): Promise<void> {
    let cursor = input.page?.cursor ?? null;
    let subscribe = input.subscribe;
    while (true) {
      const limit = input.page?.limit ?? PAGE_LIMIT;
      const payload = await client.fetchAgents({
        ...(input.filter ? { filter: input.filter } : { scope: "active" as const }),
        sort: AGENT_SORT,
        ...(subscribe ? { subscribe } : {}),
        page: cursor ? { limit, cursor } : { limit },
      });
      this.assertAgentTransactionCurrent(client, source, transaction);
      transaction.snapshot.entries.push(...payload.entries);
      transaction.snapshot.subscriptionId ??= payload.subscriptionId ?? null;
      const pageInfo = payload.pageInfo as {
        hasMore?: boolean;
        hasMoreAfter?: boolean;
        nextCursor?: string | null;
        afterCursor?: string | null;
      };
      const hasMore = pageInfo.hasMore ?? pageInfo.hasMoreAfter ?? false;
      const nextCursor = pageInfo.nextCursor ?? pageInfo.afterCursor ?? null;
      if (!hasMore || !nextCursor) break;
      cursor = nextCursor;
      subscribe = undefined;
    }
  }

  private assertAgentTransactionCurrent(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<AgentSnapshot, AgentDirectoryDelta>,
  ): void {
    if (!this.agentTransactions.isCurrent(transaction) || !this.isCurrent(client, source)) {
      throw new DirectoryRefreshSupersededError("agent page no longer current");
    }
  }

  private assertWorkspaceTransactionCurrent(
    client: DaemonClient,
    source: DirectorySourceToken,
    transaction: DirectoryTransaction<WorkspaceDirectorySnapshot, WorkspaceDirectoryDelta>,
  ): void {
    if (!this.workspaceTransactions.isCurrent(transaction) || !this.isCurrent(client, source)) {
      throw new DirectoryRefreshSupersededError("workspace fetch no longer current");
    }
  }

  private requireOnline(): { client: DaemonClient; source: DirectorySourceToken } {
    const connection = this.getOnlineConnection();
    if (!connection) {
      throw new Error(`Host ${this.serverId} is not connected`);
    }
    return connection;
  }

  private getOnlineConnection(): { client: DaemonClient; source: DirectorySourceToken } | null {
    if (!this.connection.client || this.connection.status !== "online") return null;
    return { client: this.connection.client, source: this.connection.source };
  }

  private primeAgentTransactionForCacheLoad(): void {
    const connection = this.getOnlineConnection();
    if (!connection) return;
    this.agentTransactions.begin(connection.source, () => ({
      entries: [],
      subscriptionId: null,
      legacy: false,
    }));
  }

  private persistDirectory(): void {
    if (!this.checkpoints) return;
    const session = useSessionStore.getState().sessions[this.serverId];
    if (!session) return;
    const directory = {
      agents: session.agents,
      workspaces: session.workspaces,
      projects: session.projects,
      checkpoint: this.cursors,
    };
    const previous = this.persistedDirectory;
    this.persistedDirectory = directory;
    if (!previous) {
      this.checkpoints.replaceDirectoryBaseline(this.serverId, directory);
      return;
    }
    const mutations: DirectoryReplicaMutation[] = [];
    for (const [id, value] of directory.agents) {
      if (previous.agents.get(id) !== value)
        mutations.push({ kind: "agent", type: "upsert", id, value });
    }
    for (const id of previous.agents.keys()) {
      if (!directory.agents.has(id)) mutations.push({ kind: "agent", type: "delete", id });
    }
    for (const [id, value] of directory.workspaces) {
      if (previous.workspaces.get(id) !== value)
        mutations.push({ kind: "workspace", type: "upsert", id, value });
    }
    for (const id of previous.workspaces.keys()) {
      if (!directory.workspaces.has(id)) mutations.push({ kind: "workspace", type: "delete", id });
    }
    for (const [id, value] of directory.projects) {
      if (previous.projects.get(id) !== value)
        mutations.push({ kind: "project", type: "upsert", id, value });
    }
    for (const id of previous.projects.keys()) {
      if (!directory.projects.has(id)) mutations.push({ kind: "project", type: "delete", id });
    }
    this.checkpoints.commitDirectoryMutations(this.serverId, mutations, this.cursors);
  }

  private isCurrent(client: DaemonClient, source: DirectorySourceToken): boolean {
    return (
      this.connection.client === client &&
      this.connection.status === "online" &&
      this.connection.source.clientGeneration === source.clientGeneration &&
      this.connection.source.connectionEpoch === source.connectionEpoch
    );
  }

  private async waitForSession(client: DaemonClient, source: DirectorySourceToken): Promise<void> {
    await this.waitForSessionState(client, source, () => this.hasMatchingSession(client, source));
  }

  private async waitForSessionMetadata(
    client: DaemonClient,
    source: DirectorySourceToken,
  ): Promise<void> {
    await this.waitForSessionState(client, source, () => {
      const session = useSessionStore.getState().sessions[this.serverId];
      return this.hasMatchingSession(client, source) && session?.serverInfo !== null;
    });
  }

  private async waitForSessionState(
    client: DaemonClient,
    source: DirectorySourceToken,
    matches: () => boolean,
  ): Promise<void> {
    if (matches()) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let unsubscribe: () => void = () => undefined;
      const finish = (result: "ready" | "aborted") => {
        if (settled) return;
        settled = true;
        unsubscribe();
        this.abortSessionWaits.delete(abort);
        if (result === "ready") resolve();
        else reject(new DirectoryRefreshSupersededError("session wait no longer current"));
      };
      const abort = () => finish("aborted");
      const check = () => {
        if (matches()) {
          finish("ready");
        } else if (!this.isCurrent(client, source)) {
          finish("aborted");
        }
      };
      this.abortSessionWaits.add(abort);
      unsubscribe = useSessionStore.subscribe(check);
      check();
    });
  }

  private hasMatchingSession(client: DaemonClient, source: DirectorySourceToken): boolean {
    const session = useSessionStore.getState().sessions[this.serverId];
    return session?.client === client && session.clientGeneration === source.clientGeneration;
  }

  private flushAbortedTransactions(): void {
    for (const delta of this.agentTransactions.abort()) this.agents.applyDelta(delta);
    for (const delta of this.workspaceTransactions.abort()) this.workspaces.applyDelta(delta);
  }

  private abortPendingSessionWaits(): void {
    for (const abort of this.abortSessionWaits) abort();
  }
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

export class DirectoryRefreshSupersededError extends Error {}

export type { DirectorySourceToken } from "./transaction";
