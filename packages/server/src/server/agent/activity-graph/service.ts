import { randomUUID } from "node:crypto";
import type pino from "pino";
import type {
  ActivityGraphErrorCode,
  ActivityGraphNodeRef,
  ActivityGraphNodeStatus,
  ActivityGraphNodeStatusEntry,
  ActivityGraphTurnSummary,
  ActivityGraphView,
} from "@jagentdesk/protocol/agent-activity-graph";
import type { AgentManagerEvent, ManagedAgent } from "../agent-manager.js";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import type { ProviderSubagentDescriptor } from "../provider-subagents/store.js";
import {
  buildFlowGraph,
  type ActivityInput,
  type ActivityPermission,
  type ActivityRow,
  type ActivityTurnOutcome,
  type FlowResult,
} from "./flow-builder.js";
import { nodeIndexOf, nodeStatuses, structureKey, type GraphModel } from "./model.js";
import { buildPlanGraph } from "./plan-builder.js";
import { renderActivityGraph, type ActivityGraphRenderer } from "./renderer.js";
import { NO_SPEC_PLAN_SOURCE, type SpecPlanSource } from "./spec-plan-source.js";

// Agent activity graph service (spec 31.3, ADR-0031 §2–3). One per daemon, shared by every client
// session, so a graph is built and rendered once however many clients watch it.
//
// - Builds the graph algorithmically from the agent manager's projected timeline, provider
//   subagents and permission events. Never starts a model turn.
// - Renders only for clients that asked (get) or subscribed; agents nobody watches cost nothing
//   beyond permission/turn bookkeeping.
// - A structural change (nodes or edges, labels) re-renders at most once per RENDER_THROTTLE_MS
//   per agent and view, then pushes `changed`; a status-only change pushes `status` at once.

export const RENDER_THROTTLE_MS = 1_500;
// Stream events arrive in bursts (a tool call's running/completed pair, token merges); one
// evaluation per burst is enough and keeps status pushes well under the 1 s budget (31.7 #2).
export const EVALUATE_DELAY_MS = 120;
const MAX_PERMISSIONS_PER_AGENT = 64;
const HISTORY_CACHE_LIMIT = 8;

export interface ActivityGraphAgentSource {
  subscribe(callback: (event: AgentManagerEvent) => void): () => void;
  getAgent(agentId: string): ManagedAgent | null;
  getTimelineRows(agentId: string): Promise<AgentTimelineRow[]>;
  listProviderSubagents(agentId: string): ProviderSubagentDescriptor[];
}

export type ActivityGraphPush =
  | { type: "changed"; agentId: string; view: ActivityGraphView; graphVersion: number }
  | {
      type: "status";
      agentId: string;
      view: ActivityGraphView;
      graphVersion: number;
      nodes: ActivityGraphNodeStatusEntry[];
    };

export type ActivityGraphListener = (push: ActivityGraphPush) => void;

export interface ActivityGraphSnapshot {
  graphVersion: number;
  html: string;
  nodeIndex: Record<string, ActivityGraphNodeRef>;
  nodes: ActivityGraphNodeStatusEntry[];
  turnIndex: number;
  live: boolean;
  turns: ActivityGraphTurnSummary[];
}

export type ActivityGraphGetResult =
  | { ok: true; snapshot: ActivityGraphSnapshot }
  | { ok: false; error: ActivityGraphErrorCode };

interface RenderedGraph {
  key: string;
  snapshot: ActivityGraphSnapshot;
  statuses: Map<string, ActivityGraphNodeStatus>;
}

interface Channel {
  agentId: string;
  view: ActivityGraphView;
  listeners: Map<string, ActivityGraphListener>;
  rendered: RenderedGraph | null;
  lastRenderAt: number;
  renderTimer: ReturnType<typeof setTimeout> | null;
  evaluateTimer: ReturnType<typeof setTimeout> | null;
  rendering: Promise<void> | null;
  dirtyWhileRendering: boolean;
  specUnsubscribe: (() => void) | null;
}

interface AgentBookkeeping {
  permissions: Map<string, ActivityPermission>;
  outcome: ActivityTurnOutcome | null;
  lastSeq: number;
}

export interface ActivityGraphServiceOptions {
  agents: ActivityGraphAgentSource;
  logger: pino.Logger;
  render?: ActivityGraphRenderer;
  specPlanSource?: SpecPlanSource;
  now?: () => number;
}

function channelKey(agentId: string, view: ActivityGraphView): string {
  return `${agentId}\u0000${view}`;
}

function toActivityRow(row: AgentTimelineRow): ActivityRow {
  const projected = row as AgentTimelineRow & { seqStart?: number; seqEnd?: number };
  return {
    seq: projected.seqEnd ?? row.seq,
    ...(projected.seqStart !== undefined ? { seqStart: projected.seqStart } : {}),
    item: row.item,
    ...(row.turnId ? { turnId: row.turnId } : {}),
  };
}

export class ActivityGraphService {
  private readonly agents: ActivityGraphAgentSource;
  private readonly logger: pino.Logger;
  private readonly render: ActivityGraphRenderer;
  private readonly specPlanSource: SpecPlanSource;
  private readonly now: () => number;
  private readonly channels = new Map<string, Channel>();
  private readonly bookkeeping = new Map<string, AgentBookkeeping>();
  private readonly historyCache = new Map<string, RenderedGraph>();
  private readonly renderCounts = new Map<string, number>();
  private graphVersion = 0;
  private unsubscribeAgents: (() => void) | null = null;

  constructor(options: ActivityGraphServiceOptions) {
    this.agents = options.agents;
    this.logger = options.logger.child({ module: "activity-graph" });
    this.render = options.render ?? renderActivityGraph;
    this.specPlanSource = options.specPlanSource ?? NO_SPEC_PLAN_SOURCE;
    this.now = options.now ?? Date.now;
    this.unsubscribeAgents = this.agents.subscribe((event) => this.onAgentEvent(event));
  }

  dispose(): void {
    this.unsubscribeAgents?.();
    this.unsubscribeAgents = null;
    for (const channel of this.channels.values()) this.closeChannel(channel);
    this.channels.clear();
  }

  // Renders performed for an agent since the daemon started (spec 31.7 #3 measures this).
  renderCount(agentId: string): number {
    return this.renderCounts.get(agentId) ?? 0;
  }

  subscribe(agentId: string, view: ActivityGraphView, listener: ActivityGraphListener): string {
    const key = channelKey(agentId, view);
    let channel = this.channels.get(key);
    if (!channel) {
      channel = {
        agentId,
        view,
        listeners: new Map(),
        rendered: null,
        lastRenderAt: Number.NEGATIVE_INFINITY,
        renderTimer: null,
        evaluateTimer: null,
        rendering: null,
        dirtyWhileRendering: false,
        specUnsubscribe: null,
      };
      if (view === "plan") {
        const subscribed = channel;
        channel.specUnsubscribe = this.specPlanSource.subscribe(agentId, () =>
          this.scheduleEvaluate(subscribed),
        );
      }
      this.channels.set(key, channel);
    }
    const subscriptionId = randomUUID();
    channel.listeners.set(subscriptionId, listener);
    return subscriptionId;
  }

  unsubscribe(subscriptionId: string): void {
    for (const [key, channel] of this.channels) {
      if (!channel.listeners.delete(subscriptionId)) continue;
      if (channel.listeners.size === 0) {
        this.closeChannel(channel);
        this.channels.delete(key);
      }
      return;
    }
  }

  async get(
    agentId: string,
    view: ActivityGraphView,
    turnIndex?: number,
  ): Promise<ActivityGraphGetResult> {
    const agent = this.agents.getAgent(agentId);
    if (!agent) return { ok: false, error: "not_found" };
    const built = await this.build(agentId, view, turnIndex);
    if (!built) return { ok: false, error: "no_activity" };
    const latest = turnIndex === undefined || built.turns.live || this.isLatestTurn(built);
    const channel = this.channels.get(channelKey(agentId, view));
    if (latest && channel) {
      // The live graph: share the channel's render so pushes and this response agree. Inside the
      // throttle window the last render is returned and the pending re-render pushes `changed`.
      const withinWindow = this.now() - channel.lastRenderAt < RENDER_THROTTLE_MS;
      if (!channel.rendered || !withinWindow) await this.ensureRendered(channel, built);
      else if (structureKey(built.model) !== channel.rendered.key) this.scheduleRender(channel);
      return channel.rendered
        ? { ok: true, snapshot: this.withStatuses(channel.rendered, built.model) }
        : { ok: false, error: "render_failed" };
    }
    const key = `${agentId}\u0000${view}\u0000${built.turns.turnIndex}`;
    const structure = structureKey(built.model);
    const cached = this.historyCache.get(key);
    if (cached && cached.key === structure) {
      return { ok: true, snapshot: this.withStatuses(cached, built.model) };
    }
    const rendered = await this.renderModel(agentId, built);
    if (!rendered) return { ok: false, error: "render_failed" };
    this.historyCache.delete(key);
    this.historyCache.set(key, rendered);
    while (this.historyCache.size > HISTORY_CACHE_LIMIT) {
      const oldest = this.historyCache.keys().next().value;
      if (oldest === undefined) break;
      this.historyCache.delete(oldest);
    }
    return { ok: true, snapshot: rendered.snapshot };
  }

  private isLatestTurn(built: FlowResult): boolean {
    const last = built.turns.turns.at(-1);
    return last ? last.turnIndex === built.turns.turnIndex : true;
  }

  private withStatuses(rendered: RenderedGraph, model: GraphModel): ActivityGraphSnapshot {
    const current = new Map(model.nodes.map((node) => [node.id, node.status]));
    return {
      ...rendered.snapshot,
      nodes: rendered.snapshot.nodes.map((entry) => ({
        id: entry.id,
        status: current.get(entry.id) ?? entry.status,
      })),
    };
  }

  private book(agentId: string): AgentBookkeeping {
    let entry = this.bookkeeping.get(agentId);
    if (!entry) {
      entry = { permissions: new Map(), outcome: null, lastSeq: 0 };
      this.bookkeeping.set(agentId, entry);
    }
    return entry;
  }

  private onAgentEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_stream") {
      const book = this.book(event.agentId);
      if (typeof event.seq === "number") book.lastSeq = Math.max(book.lastSeq, event.seq);
      const stream = event.event;
      switch (stream.type) {
        case "turn_started":
          book.outcome = null;
          break;
        case "turn_completed":
          book.outcome = "completed";
          break;
        case "turn_failed":
          book.outcome = "failed";
          break;
        case "turn_canceled":
          book.outcome = "canceled";
          break;
        case "permission_requested":
          book.permissions.set(stream.request.id, {
            request: stream.request,
            state: "pending",
            afterSeq: book.lastSeq,
          });
          while (book.permissions.size > MAX_PERMISSIONS_PER_AGENT) {
            const oldest = book.permissions.keys().next().value;
            if (oldest === undefined) break;
            book.permissions.delete(oldest);
          }
          break;
        case "permission_resolved": {
          const known = book.permissions.get(stream.requestId);
          if (known) {
            known.state = stream.resolution.behavior === "allow" ? "allowed" : "denied";
          }
          break;
        }
        default:
          break;
      }
      this.evaluateAgent(event.agentId);
      return;
    }
    if (event.type === "agent_state") {
      this.evaluateAgent(event.agent.id);
      return;
    }
    if (event.type === "provider_subagent") {
      const parentId =
        event.event.type === "upsert"
          ? event.event.subagent.parentAgentId
          : event.event.parentAgentId;
      if (event.event.type !== "timeline") this.evaluateAgent(parentId);
      return;
    }
    if (event.type === "timeline_replacement") {
      this.evaluateAgent(event.agentId);
    }
  }

  private evaluateAgent(agentId: string): void {
    for (const view of ["flow", "plan"] as const) {
      const channel = this.channels.get(channelKey(agentId, view));
      if (channel) this.scheduleEvaluate(channel);
    }
  }

  private scheduleEvaluate(channel: Channel): void {
    if (channel.evaluateTimer) return;
    channel.evaluateTimer = setTimeout(() => {
      channel.evaluateTimer = null;
      void this.evaluate(channel).catch((error: unknown) => {
        this.logger.warn(
          { err: error, agentId: channel.agentId },
          "activity graph evaluate failed",
        );
      });
    }, EVALUATE_DELAY_MS);
  }

  private async evaluate(channel: Channel): Promise<void> {
    if (!this.channels.has(channelKey(channel.agentId, channel.view))) return;
    if (channel.rendering) {
      channel.dirtyWhileRendering = true;
      return;
    }
    const built = await this.build(channel.agentId, channel.view);
    if (!built) return;
    const key = structureKey(built.model);
    if (channel.rendered && channel.rendered.key === key) {
      this.pushStatusDiff(channel, built.model);
      return;
    }
    this.scheduleRender(channel);
  }

  private pushStatusDiff(channel: Channel, model: GraphModel): void {
    const rendered = channel.rendered;
    if (!rendered) return;
    const changed: ActivityGraphNodeStatusEntry[] = [];
    for (const node of model.nodes) {
      if (rendered.statuses.get(node.id) === node.status) continue;
      rendered.statuses.set(node.id, node.status);
      changed.push({ id: node.id, status: node.status });
    }
    if (changed.length === 0) return;
    this.emit(channel, {
      type: "status",
      agentId: channel.agentId,
      view: channel.view,
      graphVersion: rendered.snapshot.graphVersion,
      nodes: changed,
    });
  }

  // At most one render per RENDER_THROTTLE_MS per channel: render now when the window allows it,
  // otherwise once when it reopens (with whatever the graph looks like then).
  private scheduleRender(channel: Channel): void {
    if (channel.renderTimer) return;
    const wait = Math.max(0, channel.lastRenderAt + RENDER_THROTTLE_MS - this.now());
    channel.renderTimer = setTimeout(() => {
      channel.renderTimer = null;
      void this.renderChannel(channel).catch((error: unknown) => {
        this.logger.warn({ err: error, agentId: channel.agentId }, "activity graph render failed");
      });
    }, wait);
  }

  private async renderChannel(channel: Channel): Promise<void> {
    if (!this.channels.has(channelKey(channel.agentId, channel.view))) return;
    const built = await this.build(channel.agentId, channel.view);
    if (!built) return;
    await this.ensureRendered(channel, built);
  }

  private async ensureRendered(channel: Channel, built: FlowResult): Promise<void> {
    if (channel.rendering) await channel.rendering;
    const key = structureKey(built.model);
    if (channel.rendered && channel.rendered.key === key) {
      this.pushStatusDiff(channel, built.model);
      return;
    }
    const previousVersion = channel.rendered?.snapshot.graphVersion ?? null;
    channel.rendering = (async () => {
      channel.lastRenderAt = this.now();
      const rendered = await this.renderModel(channel.agentId, built);
      if (rendered) channel.rendered = rendered;
    })();
    try {
      await channel.rendering;
    } finally {
      channel.rendering = null;
    }
    const version = channel.rendered?.snapshot.graphVersion ?? null;
    if (version !== null && version !== previousVersion) {
      this.emit(channel, {
        type: "changed",
        agentId: channel.agentId,
        view: channel.view,
        graphVersion: version,
      });
    }
    if (channel.dirtyWhileRendering) {
      channel.dirtyWhileRendering = false;
      this.scheduleEvaluate(channel);
    }
  }

  private async renderModel(agentId: string, built: FlowResult): Promise<RenderedGraph | null> {
    this.renderCounts.set(agentId, (this.renderCounts.get(agentId) ?? 0) + 1);
    const result = await this.render(built.model);
    if (!result.ok) {
      this.logger.warn(
        { agentId, view: built.model.view, errors: result.errors.slice(0, 5) },
        "activity graph archify render rejected the generated graph",
      );
      return null;
    }
    this.graphVersion += 1;
    const statuses = nodeStatuses(built.model);
    return {
      key: structureKey(built.model),
      statuses: new Map(statuses.map((entry) => [entry.id, entry.status])),
      snapshot: {
        graphVersion: this.graphVersion,
        html: result.html,
        nodeIndex: nodeIndexOf(built.model),
        nodes: statuses,
        turnIndex: built.turns.turnIndex,
        live: built.turns.live,
        turns: built.turns.turns,
      },
    };
  }

  private async build(
    agentId: string,
    view: ActivityGraphView,
    turnIndex?: number,
  ): Promise<FlowResult | null> {
    const agent = this.agents.getAgent(agentId);
    if (!agent) return null;
    const rows = (await this.agents.getTimelineRows(agentId)).map(toActivityRow);
    const book = this.book(agentId);
    const lastRowSeq = rows.at(-1)?.seq ?? 0;
    if (lastRowSeq > book.lastSeq) book.lastSeq = lastRowSeq;
    // Requests still pending in the agent snapshot (e.g. raised before this daemon tracked them).
    for (const request of agent.pendingPermissions.values()) {
      if (!book.permissions.has(request.id)) {
        book.permissions.set(request.id, { request, state: "pending", afterSeq: book.lastSeq });
      }
    }
    const input: ActivityInput = {
      rows,
      subagents: this.agents.listProviderSubagents(agentId),
      permissions: [...book.permissions.values()],
      running: agent.lifecycle === "running",
      latestTurnOutcome: book.outcome,
      ...(turnIndex !== undefined ? { turnIndex } : {}),
      title: agent.config.title ?? undefined,
      cwd: agent.cwd,
    };
    if (view === "plan") {
      const specPlan = await this.specPlanSource.getPlan(agentId);
      return buildPlanGraph(input, specPlan);
    }
    return buildFlowGraph(input);
  }

  private emit(channel: Channel, push: ActivityGraphPush): void {
    for (const listener of channel.listeners.values()) {
      try {
        listener(push);
      } catch (error) {
        this.logger.warn({ err: error }, "activity graph listener failed");
      }
    }
  }

  private closeChannel(channel: Channel): void {
    if (channel.renderTimer) clearTimeout(channel.renderTimer);
    if (channel.evaluateTimer) clearTimeout(channel.evaluateTimer);
    channel.renderTimer = null;
    channel.evaluateTimer = null;
    channel.specUnsubscribe?.();
    channel.specUnsubscribe = null;
  }
}
