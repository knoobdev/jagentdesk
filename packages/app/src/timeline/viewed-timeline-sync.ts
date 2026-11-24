import { replaceWithCanonicalStream } from "@/types/stream";
import {
  planTimelineCatchUpAfter,
  planTimelineTailFetch,
  planTimelineResumeFetch,
  type ProjectedTimelineForwardFetchPlan,
} from "./timeline-sync-plan";
import type { CachedTimeline } from "@/runtime/replica-cache";
import {
  selectAgentTimelineState,
  selectAgentUnsettledTurn,
  useSessionStore,
  type AgentTimelineCursorState,
  type AgentTimelineState,
} from "@/stores/session-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "@jagentdesk/protocol/messages";
import { getSendingClientMessageIds } from "@/composer/submission/model";
import {
  getInitDeferred,
  getInitKey,
  rejectInitDeferred,
  resolveInitDeferred,
} from "@/utils/agent-initialization";
import {
  createSessionAgentStreamReducerQueue,
  type AgentStreamReducerEvent,
  type ProcessTimelineResponseOutput,
  processTimelineResponse,
} from "./session-stream-reducers";
import { isTimelineResumeSnapshotAuthoritative } from "./timeline-sync-plan";

export interface TimelineReplicaStorage {
  readTimeline(serverId: string, agentId: string): Promise<CachedTimeline | undefined>;
  commitTimeline(serverId: string, agentId: string, timeline: CachedTimeline): void;
}

async function prepareCachedTimeline(input: {
  serverId: string;
  agentId: string;
  storage: TimelineReplicaStorage;
  prepareAgent: (agentId: string) => Promise<void>;
  isTurnSettled: () => boolean;
}): Promise<CachedTimeline | undefined> {
  const before = useSessionStore.getState().sessions[input.serverId];
  const beforeTimeline = selectAgentTimelineState(before, input.agentId);
  if (beforeTimeline.status === "synced") return undefined;
  const [stored] = await Promise.all([
    input.storage.readTimeline(input.serverId, input.agentId),
    input.prepareAgent(input.agentId),
  ]);
  if (!stored) return undefined;
  const session = useSessionStore.getState().sessions[input.serverId];
  const currentTimeline = selectAgentTimelineState(session, input.agentId);
  const currentHead = session?.agentStreamHead.get(input.agentId);
  if (currentTimeline.status === "synced") return undefined;
  if (!stored.range) {
    if (beforeTimeline.status === "painted") {
      return currentTimeline.status === "painted" && currentTimeline.items === beforeTimeline.items
        ? stored
        : undefined;
    }
    if (currentTimeline.status !== "cold") return undefined;
  }
  const liveItems =
    currentTimeline.status === "painted"
      ? [...currentTimeline.items, ...(currentHead ?? [])]
      : (currentHead ?? []);
  const replacement = replaceWithCanonicalStream({
    canonical: stored.items,
    previousTail: [],
    previousHead: liveItems,
    sendingClientMessageIds: getSendingClientMessageIds(
      session?.messageSubmissions.get(input.agentId),
    ),
    preserveContinuity: true,
    // Display-only rows claim no coverage over the live head.
    canonicalCoverage: stored.range ?? {
      epoch: liveItems.find((item) => item.timelineCursor)?.timelineCursor?.epoch ?? "",
      endSeq: null,
    },
  });
  useSessionStore.getState().applyAgentTimelineResponseState(input.serverId, input.agentId, {
    items: replacement.tail,
    head: replacement.head,
    range: stored.range,
    older: stored.hasOlder ? "available" : "none",
    newer: false,
    synchronized: false,
    acknowledgedClientMessageIds: replacement.acknowledgedClientMessageIds,
    unsettledTurn: input.isTurnSettled() ? undefined : stored.unsettledTurn,
  });
  return stored;
}

export interface TimelineReplica {
  prepare(agentId: string): Promise<void>;
  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined;
  readRange(agentId: string): AgentTimelineCursorState | undefined;
  timelineUpdated(agentId: string): void;
  catchUpOwed(agentId: string): void;
  catchUpSettled(agentId: string): void;
}

class TimelineReplicaOwner implements TimelineReplica {
  private readonly cachedRanges = new Map<string, AgentTimelineCursorState>();
  private readonly preparations = new Map<string, Promise<void>>();
  // A cache read in flight still carries the turn as it was saved. Once the catch-up has
  // settled, that turn must not come back with the cached messages.
  private readonly settledDuringPreparation = new Set<string>();

  constructor(
    private readonly serverId: string,
    private readonly storage: TimelineReplicaStorage,
    private readonly prepareAgent: (agentId: string) => Promise<void>,
  ) {}

  async prepare(agentId: string): Promise<void> {
    const existing = this.preparations.get(agentId);
    if (existing) return existing;
    const timeline = selectAgentTimelineState(
      useSessionStore.getState().sessions[this.serverId],
      agentId,
    );
    // A route and the visible-chat owner can both prepare before catch-up finishes.
    // Repainting that same cache would treat its history as a live head.
    if (timeline.status !== "cold" && this.cachedRanges.has(agentId)) {
      return;
    }
    const preparation = this.load(agentId).finally(() => {
      if (this.preparations.get(agentId) === preparation) {
        this.preparations.delete(agentId);
        this.settledDuringPreparation.delete(agentId);
      }
    });
    this.preparations.set(agentId, preparation);
    return preparation;
  }

  private async load(agentId: string): Promise<void> {
    const stored = await prepareCachedTimeline({
      serverId: this.serverId,
      agentId,
      storage: this.storage,
      prepareAgent: this.prepareAgent,
      isTurnSettled: () => this.settledDuringPreparation.has(agentId),
    });
    if (!stored) return;
    if (stored.range) {
      this.cachedRanges.set(agentId, stored.range);
    }
  }

  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined {
    const range = this.cachedRanges.get(agentId);
    return range ? { epoch: range.epoch, endSeq: range.endSeq } : undefined;
  }

  readRange(agentId: string): AgentTimelineCursorState | undefined {
    return this.cachedRanges.get(agentId);
  }

  timelineUpdated(agentId: string): void {
    const session = useSessionStore.getState().sessions[this.serverId];
    const timeline = selectAgentTimelineState(session, agentId);
    if (timeline.status === "cold") return;
    if (timeline.status === "synced") this.cachedRanges.delete(agentId);
    this.storage.commitTimeline(this.serverId, agentId, {
      agentId,
      items: [...timeline.items, ...(session?.agentStreamHead.get(agentId) ?? [])],
      range: timeline.status === "synced" ? timeline.range : null,
      hasOlder: timeline.status === "synced" && timeline.older === "available",
      unsettledTurn: selectAgentUnsettledTurn(session, agentId),
    });
  }

  catchUpOwed(agentId: string): void {
    this.settledDuringPreparation.delete(agentId);
    const store = useSessionStore.getState();
    const openTurn = selectAgentUnsettledTurn(store.sessions[this.serverId], agentId);
    if (openTurn) store.setAgentTimelineUnsettledTurn(this.serverId, agentId, openTurn);
  }

  catchUpSettled(agentId: string): void {
    if (this.preparations.has(agentId)) this.settledDuringPreparation.add(agentId);
    useSessionStore.getState().setAgentTimelineUnsettledTurn(this.serverId, agentId, null);
  }
}

export function createTimelineReplica(input: {
  serverId: string;
  storage: TimelineReplicaStorage;
  prepareAgent: (agentId: string) => Promise<void>;
}): TimelineReplica {
  return new TimelineReplicaOwner(input.serverId, input.storage, input.prepareAgent);
}

export interface TimelinePageResult {
  hasNewer: boolean;
  endCursor: { epoch: string; seq: number } | null;
}

export type TimelineResponsePayload = Extract<
  SessionOutboundMessage,
  { type: "fetch_agent_timeline_response" }
>["payload"];

function clearAgentInitializingFlag(serverId: string, agentId: string): void {
  useSessionStore.getState().setInitializingAgents(serverId, (previous) => {
    if (previous.get(agentId) !== true) return previous;
    const next = new Map(previous);
    next.set(agentId, false);
    return next;
  });
}

function commitProcessedTimeline(input: {
  serverId: string;
  payload: TimelineResponsePayload;
  result: ProcessTimelineResponseOutput;
  timeline: AgentTimelineState;
  currentCursor: AgentTimelineCursorState | undefined;
  synchronized: boolean;
}): void {
  const { serverId, payload, result, timeline, currentCursor, synchronized } = input;
  const agentId = payload.agentId;
  const store = useSessionStore.getState();
  if (result.commit !== "discard") {
    store.applyAgentTimelineResponseState(serverId, agentId, {
      items: result.tail,
      head: result.head,
      range: result.cursorChanged ? (result.cursor ?? null) : (currentCursor ?? null),
      older: result.older,
      newer:
        payload.direction === "before"
          ? timeline.status === "synced" && timeline.newer === "available"
          : payload.hasNewer,
      synchronized,
      acknowledgedClientMessageIds: result.acknowledgedClientMessageIds,
    });
    return;
  }
  if (result.acknowledgedClientMessageIds.length > 0) {
    store.setAgentStreamState(serverId, agentId, {
      acknowledgedClientMessageIds: result.acknowledgedClientMessageIds,
    });
  }
  if (payload.direction !== "before") {
    store.setAgentTimelineHasNewer(serverId, (current) => {
      const next = new Map(current);
      next.set(agentId, payload.hasNewer);
      return next;
    });
  }
  store.markAgentHistorySynchronized(serverId, agentId);
  if (synchronized) store.setAgentTimelineUnsettledTurn(serverId, agentId, null);
}

function finalizeProcessedTimeline(input: {
  serverId: string;
  agentId: string;
  initKey: string;
  result: ProcessTimelineResponseOutput;
  synchronized: boolean;
  recoverGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
}): void {
  for (const effect of input.result.sideEffects) {
    if (effect.type === "catch_up") input.recoverGap(input.agentId, effect.cursor);
  }
  if (input.result.clearInitializing) {
    clearAgentInitializingFlag(input.serverId, input.agentId);
  }
  if (input.synchronized) {
    useCreateFlowStore
      .getState()
      .clearByAgent({ serverId: input.serverId, agentId: input.agentId });
    const session = useSessionStore.getState().sessions[input.serverId];
    const agent = session?.agents.get(input.agentId) ?? session?.agentDetails.get(input.agentId);
    if (input.result.clearInitializing && agent && agent.status !== "running")
      input.drainQueuedAgentMessage(input.agentId);
  }
  if (input.result.initResolution === "resolve") resolveInitDeferred(input.initKey);
}

function applyAuthoritativeTimelineResponse(input: {
  serverId: string;
  payload: TimelineResponsePayload;
  cachedCursor?: AgentTimelineCursorState;
  recoverGap: (agentId: string, cursor: { epoch: string; endSeq: number }) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
}): boolean {
  const { serverId, payload } = input;
  const agentId = payload.agentId;
  const initKey = getInitKey(serverId, agentId);
  const session = useSessionStore.getState().sessions[serverId];
  const timeline = selectAgentTimelineState(session, agentId);
  const activeInitDeferred = getInitDeferred(initKey);
  const currentCursor =
    timeline.status === "synced" ? (timeline.range ?? undefined) : input.cachedCursor;
  const result = processTimelineResponse({
    payload,
    currentTail: timeline.status === "cold" ? [] : timeline.items,
    currentHead: session?.agentStreamHead.get(agentId) ?? [],
    currentCursor,
    isInitializing: session?.initializingAgents.get(agentId) === true,
    hasActiveInitDeferred: Boolean(activeInitDeferred),
    initRequestDirection: activeInitDeferred?.requestDirection ?? "tail",
    sendingClientMessageIds: getSendingClientMessageIds(session?.messageSubmissions.get(agentId)),
  });

  if (result.error) {
    if (result.clearInitializing) clearAgentInitializingFlag(serverId, agentId);
    if (result.initResolution === "reject") rejectInitDeferred(initKey, new Error(result.error));
    return false;
  }

  const synchronized = isTimelineResumeSnapshotAuthoritative({
    direction: payload.direction,
    hasNewer: payload.hasNewer,
    error: payload.error,
  });
  commitProcessedTimeline({ serverId, payload, result, timeline, currentCursor, synchronized });
  finalizeProcessedTimeline({
    serverId,
    agentId,
    initKey,
    result,
    synchronized,
    recoverGap: input.recoverGap,
    drainQueuedAgentMessage: input.drainQueuedAgentMessage,
  });
  return true;
}

/**
 * Measured on a dev daemon: set_subscription answers in a mean of 1.4 ms, p99 per-window max
 * 107 ms, max 227 ms. A check slower than this is slow enough to say so on screen.
 */
export const FRESHNESS_CHECK_QUIET_MS = 500;

export type TimelineFreshness = "current" | "behind";

/** The empty after page the daemon would have returned for a cursor already at the head. */
function buildCurrentTimelinePage(
  agentId: string,
  cursor: { epoch: string; endSeq: number },
): TimelineResponsePayload {
  return {
    requestId: "",
    agentId,
    agent: null,
    direction: "after",
    projection: "projected",
    epoch: cursor.epoch,
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 0, maxSeq: cursor.endSeq, nextSeq: cursor.endSeq + 1 },
    startCursor: null,
    endCursor: null,
    hasOlder: false,
    hasNewer: false,
    entries: [],
    error: null,
  };
}

export interface TimelineSubscriptionAnswer {
  timelines?: Record<string, TimelineFreshness>;
  agents?: Record<string, AgentSnapshotPayload>;
}

export interface ViewedTimelineSyncPorts {
  initialDeliveryMode: TimelineDeliveryMode;
  readCursor(agentId: string): { epoch: string; endSeq: number } | undefined;
  prepare(agentId: string): Promise<void>;
  replaceDemandedAgentIds(agentIds: string[]): void;
  onCatchUpOwed(agentId: string): void;
  onCatchUpSettled(agentId: string): void;
  canCheckFreshness(): boolean;
  setSubscription(
    agentIds: string[],
    cursors?: Record<string, { epoch: string; seq: number }>,
  ): Promise<TimelineSubscriptionAnswer | void>;
  applyCurrentTimeline(agentId: string): void;
  fetchPage(
    agentId: string,
    request: ProjectedTimelineForwardFetchPlan,
  ): Promise<TimelinePageResult>;
  reportError(error: unknown): void;
  schedule(task: () => void, delayMs: number): () => void;
}

export type TimelineDeliveryMode = "legacy" | "selective";
export type ViewedTimelineStatus = "ready" | "checking" | "reattaching" | "pending" | "error";

export interface ViewedTimelineUiBridge {
  replaceVisibleAgentIds(sourceId: string, agentIds: string[]): void;
  subscribe(listener: () => void): () => void;
  getAgentTimelineStatus(agentId: string): ViewedTimelineStatus;
  getAgentTimelineError(agentId: string): string | null;
  retryVisibleAgentTimeline(agentId: string): void;
}

export interface ViewedTimelineSync extends ViewedTimelineUiBridge {
  setActive(active: boolean): void;
  setConnected(connected: boolean): void;
  setDeliveryMode(mode: TimelineDeliveryMode): void;
  reconcileAgent(agentId: string): void;
  recoverGap(agentId: string, cursor: { epoch: string; endSeq: number }): void;
  dispose(): void;
}

export type ViewedTimelineOwnerPorts = Omit<
  ViewedTimelineSyncPorts,
  | "prepare"
  | "replaceDemandedAgentIds"
  | "onCatchUpOwed"
  | "onCatchUpSettled"
  | "applyCurrentTimeline"
>;

export interface ViewedTimelineOwner extends ViewedTimelineSync {
  applyTimelineResponse(payload: TimelineResponsePayload): void;
  enqueueStreamEvent(agentId: string, event: AgentStreamReducerEvent): void;
  flushStreamAgent(agentId: string): void;
}

export function createViewedTimelineOwner(input: {
  serverId: string;
  replica: TimelineReplica;
  replaceDemandedAgentIds: (agentIds: string[]) => void;
  drainQueuedAgentMessage: (agentId: string) => void;
  ports: ViewedTimelineOwnerPorts;
}): ViewedTimelineOwner {
  const sync = createViewedTimelineSync({
    ...input.ports,
    prepare: (agentId) => input.replica.prepare(agentId),
    readCursor: (agentId) => input.replica.readCursor(agentId) ?? input.ports.readCursor(agentId),
    replaceDemandedAgentIds: input.replaceDemandedAgentIds,
    applyCurrentTimeline: (agentId) => {
      const cursor = input.replica.readCursor(agentId) ?? input.ports.readCursor(agentId);
      if (!cursor) return;
      const accepted = applyAuthoritativeTimelineResponse({
        serverId: input.serverId,
        payload: buildCurrentTimelinePage(agentId, cursor),
        cachedCursor: input.replica.readRange(agentId),
        recoverGap: (id, gapCursor) => sync.recoverGap(id, gapCursor),
        drainQueuedAgentMessage: input.drainQueuedAgentMessage,
      });
      if (accepted) input.replica.timelineUpdated(agentId);
    },

    onCatchUpOwed: (agentId) => input.replica.catchUpOwed(agentId),
    onCatchUpSettled: (agentId) => input.replica.catchUpSettled(agentId),
  });
  const streamQueue = createSessionAgentStreamReducerQueue({
    serverId: input.serverId,
    setAgentStreamState: (...args) => useSessionStore.getState().setAgentStreamState(...args),
    setAgentTimelineCursor: (...args) => useSessionStore.getState().setAgentTimelineCursor(...args),
    recoverTimelineGap: (agentId, cursor) => sync.recoverGap(agentId, cursor),
    onCommitted: (agentId) => input.replica.timelineUpdated(agentId),
  });
  return {
    ...sync,
    applyTimelineResponse(payload) {
      const accepted = applyAuthoritativeTimelineResponse({
        serverId: input.serverId,
        payload,
        cachedCursor: input.replica.readRange(payload.agentId),
        recoverGap: (agentId, cursor) => sync.recoverGap(agentId, cursor),
        drainQueuedAgentMessage: input.drainQueuedAgentMessage,
      });
      if (accepted) input.replica.timelineUpdated(payload.agentId);
    },
    enqueueStreamEvent(agentId, event) {
      streamQueue.enqueue(agentId, event);
    },
    flushStreamAgent(agentId) {
      streamQueue.flushAgent(agentId);
    },
    dispose() {
      streamQueue.dispose({ flush: true });
      sync.dispose();
    },
  };
}

const RETRY_DELAY_MS = 1_000;
export const VIEWED_TIMELINE_UNSUBSCRIBE_GRACE_MS = 30_000;

type CatchUpStatus = "running" | "complete" | "error";

interface CatchUpState {
  generation: number;
  status: CatchUpStatus;
  request?: ProjectedTimelineForwardFetchPlan;
  cancelRetry?: () => void;
}

function isSameCatchUpRequest(
  left: ProjectedTimelineForwardFetchPlan | undefined,
  right: ProjectedTimelineForwardFetchPlan | undefined,
): boolean {
  if (!left || !right || left.direction !== right.direction) return false;
  if (left.direction !== "after" || right.direction !== "after") return true;
  return left.cursor.epoch === right.cursor.epoch && left.cursor.seq === right.cursor.seq;
}

type CatchUpDecision = "keep" | "keep-and-park" | "replace";

function decideCatchUp(input: {
  current: CatchUpState | undefined;
  request: ProjectedTimelineForwardFetchPlan;
  supersede: boolean;
}): CatchUpDecision {
  if (!input.current) return "replace";
  if (input.supersede) {
    if (
      input.current.status === "running" &&
      isSameCatchUpRequest(input.current.request, input.request)
    ) {
      return "keep";
    }
    if (input.current.status === "running" && input.current.request?.direction === "tail") {
      return "keep-and-park";
    }
    return "replace";
  }
  return input.current.status === "running" || input.current.status === "complete"
    ? "keep"
    : "replace";
}

function normalizeAgentIds(agentIds: string[]): string[] {
  return [...new Set(agentIds)].filter(Boolean).sort();
}

function sameAgentIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((agentId, index) => agentId === right[index]);
}

export function createViewedTimelineSync(ports: ViewedTimelineSyncPorts): ViewedTimelineSync {
  const sources = new Map<string, string[]>();
  const catchUps = new Map<string, CatchUpState>();
  const catchUpGenerations = new Map<string, number>();
  // Authoritative fetch owed but not runnable yet: disconnected, unacknowledged, or parked.
  // Acknowledgement and tail completion are the only drain points.
  const pendingCatchUps = new Map<string, ProjectedTimelineForwardFetchPlan>();
  const lingeringRemovals = new Map<string, () => void>();
  const visibilityCatchUpPending = new Set<string>();
  const visibilityCatchUpErrors = new Map<string, string>();
  // User-initiated retries only. Background retries stay silent; a retry the user asked for
  // owes them a pending state until it settles.
  const manualRetries = new Set<string>();
  const loadedCache = new Set<string>();
  const cacheLoads = new Map<string, Promise<void>>();
  const freshnessChecks = new Map<
    string,
    { quiet: boolean; reattaching: boolean; timer: ReturnType<typeof setTimeout> | null }
  >();
  let freshnessCheckOwed = false;
  const listeners = new Set<() => void>();
  let active = true;
  let connected = false;
  let deliveryMode = ports.initialDeliveryMode;
  let disposed = false;
  let desired: string[] = [];
  let acknowledged: string[] = [];
  let membershipGeneration = 0;
  let reconciling = false;
  let reconcileRequested = false;
  let membershipNeedsRetry = false;
  let cancelMembershipRetry: (() => void) | null = null;

  const visibleAgentIds = () => (active ? normalizeAgentIds([...sources.values()].flat()) : []);
  const effectiveAgentIds = () =>
    normalizeAgentIds([...visibleAgentIds(), ...lingeringRemovals.keys()]);

  const isAcknowledged = (agentId: string) => acknowledged.includes(agentId);
  const isDesired = (agentId: string) => desired.includes(agentId);

  const notifyListeners = () => {
    for (const listener of listeners) listener();
  };

  const setVisibilityCatchUpReady = (agentId: string) => {
    ports.onCatchUpSettled(agentId);
    const wasPending = visibilityCatchUpPending.delete(agentId);
    const hadError = visibilityCatchUpErrors.delete(agentId);
    if (wasPending || hadError) notifyListeners();
  };

  const setVisibilityCatchUpError = (agentIds: string[], error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    let changed = false;
    for (const agentId of agentIds) {
      ports.onCatchUpSettled(agentId);
      if (manualRetries.delete(agentId)) changed = true;
      if (visibilityCatchUpPending.delete(agentId)) changed = true;
      if (visibilityCatchUpErrors.get(agentId) !== message) {
        visibilityCatchUpErrors.set(agentId, message);
        changed = true;
      }
    }
    if (changed) notifyListeners();
  };

  const startFreshnessCheck = (agentId: string, reattaching = false) => {
    if (freshnessChecks.has(agentId)) return;
    freshnessChecks.set(agentId, { quiet: true, reattaching, timer: null });
  };

  // The delay measures the daemon's answer, so it starts when the question is sent. On a cold
  // start the cache read that precedes the question can outlast it on its own.
  const startFreshnessCheckDelay = (agentId: string) => {
    const check = freshnessChecks.get(agentId);
    if (!check || check.timer) return;
    check.timer = setTimeout(() => {
      check.quiet = false;
      notifyListeners();
    }, FRESHNESS_CHECK_QUIET_MS);
  };

  const endFreshnessCheck = (agentId: string) => {
    const check = freshnessChecks.get(agentId);
    if (!check) return;
    if (check.timer) clearTimeout(check.timer);
    freshnessChecks.delete(agentId);
  };

  const endAllFreshnessChecks = () => {
    for (const agentId of freshnessChecks.keys()) endFreshnessCheck(agentId);
  };

  const cancelCatchUp = (agentId: string) => {
    catchUpGenerations.set(agentId, (catchUpGenerations.get(agentId) ?? 0) + 1);
    catchUps.get(agentId)?.cancelRetry?.();
    catchUps.delete(agentId);
    pendingCatchUps.delete(agentId);
  };

  const fetchUntilCurrent = async (
    agentId: string,
    generation: number,
    request: ProjectedTimelineForwardFetchPlan,
  ): Promise<void> => {
    if (
      disposed ||
      !connected ||
      !isDesired(agentId) ||
      !isAcknowledged(agentId) ||
      catchUps.get(agentId)?.generation !== generation
    ) {
      return;
    }

    try {
      const page = await ports.fetchPage(agentId, request);
      if (
        disposed ||
        !connected ||
        !isDesired(agentId) ||
        !isAcknowledged(agentId) ||
        catchUps.get(agentId)?.generation !== generation
      ) {
        return;
      }
      if (page.hasNewer && page.endCursor) {
        await fetchUntilCurrent(agentId, generation, planTimelineCatchUpAfter(page.endCursor));
        return;
      }
      if (page.hasNewer) {
        throw new Error(`Timeline page for ${agentId} hasNewer without an end cursor`);
      }
      catchUps.set(agentId, { generation, status: "complete" });
      const pendingCatchUp = pendingCatchUps.get(agentId);
      if (pendingCatchUp) {
        startCatchUp(agentId, { request: pendingCatchUp, supersede: true });
        return;
      }
      setVisibilityCatchUpReady(agentId);
    } catch (error) {
      if (catchUps.get(agentId)?.generation === generation) {
        const cancelRetry = ports.schedule(() => {
          const current = catchUps.get(agentId);
          if (current?.generation !== generation || current.status !== "error") return;
          startCatchUp(agentId);
        }, RETRY_DELAY_MS);
        catchUps.set(agentId, {
          generation,
          status: "error",
          request,
          cancelRetry,
        });
        setVisibilityCatchUpError([agentId], error);
        ports.reportError(error);
      }
    }
  };

  const ensureCacheLoaded = (agentId: string): void => {
    if (loadedCache.has(agentId) || cacheLoads.has(agentId)) return;
    const load = ports
      .prepare(agentId)
      .catch((error) => ports.reportError(error))
      .finally(() => {
        cacheLoads.delete(agentId);
        loadedCache.add(agentId);
        const pending = pendingCatchUps.get(agentId);
        startCatchUp(agentId, { request: pending, supersede: Boolean(pending) });
      });
    cacheLoads.set(agentId, load);
  };

  const startCatchUp = (
    agentId: string,
    options: {
      request?: ProjectedTimelineForwardFetchPlan;
      supersede?: boolean;
    } = {},
  ) => {
    const { request, supersede = false } = options;
    if (freshnessChecks.has(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      return;
    }
    if (!connected || !isDesired(agentId) || !isAcknowledged(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      return;
    }
    if (!loadedCache.has(agentId)) {
      if (request) pendingCatchUps.set(agentId, request);
      ensureCacheLoaded(agentId);
      return;
    }
    const nextRequest = request ?? planTimelineResumeFetch(ports.readCursor(agentId));
    const current = catchUps.get(agentId);
    const decision = decideCatchUp({ current, request: nextRequest, supersede });
    if (decision === "keep-and-park") {
      pendingCatchUps.set(agentId, nextRequest);
      return;
    }
    if (decision === "keep") {
      return;
    }
    current?.cancelRetry?.();
    const generation = (catchUpGenerations.get(agentId) ?? 0) + 1;
    catchUpGenerations.set(agentId, generation);
    catchUps.set(agentId, { generation, status: "running", request: nextRequest });
    pendingCatchUps.delete(agentId);
    void fetchUntilCurrent(agentId, generation, nextRequest);
  };

  const startAcknowledgedCatchUps = () => {
    for (const agentId of acknowledged) {
      const pendingCatchUp = pendingCatchUps.get(agentId);
      startCatchUp(agentId, {
        request: pendingCatchUp,
        supersede: Boolean(pendingCatchUp),
      });
    }
  };

  const collectFreshnessCursors = (requested: string[]) => {
    const cursors: Record<string, { epoch: string; seq: number }> = {};
    for (const agentId of requested) {
      if (catchUps.has(agentId) || pendingCatchUps.has(agentId)) continue;
      const cursor = ports.readCursor(agentId);
      if (cursor) cursors[agentId] = { epoch: cursor.epoch, seq: cursor.endSeq };
    }
    return cursors;
  };

  const completeCurrentCatchUp = (agentId: string) => {
    const generation = (catchUpGenerations.get(agentId) ?? 0) + 1;
    catchUpGenerations.set(agentId, generation);
    catchUps.set(agentId, { generation, status: "complete" });
    ports.applyCurrentTimeline(agentId);
    setVisibilityCatchUpReady(agentId);
  };

  const applyFreshnessAnswer = (
    checked: string[],
    timelines: Record<string, TimelineFreshness> | undefined,
  ) => {
    for (const agentId of checked) {
      endFreshnessCheck(agentId);
      // A gap found during the check still needs its fetch; "current" only speaks for the cursor.
      if (timelines?.[agentId] === "current" && !pendingCatchUps.has(agentId)) {
        completeCurrentCatchUp(agentId);
      }
    }
    if (checked.length > 0) notifyListeners();
  };

  const askDaemonAboutFreshness = (checked: string[]) => {
    for (const agentId of checked) {
      startFreshnessCheck(agentId);
      startFreshnessCheckDelay(agentId);
    }
    for (const agentId of freshnessChecks.keys()) {
      if (!checked.includes(agentId)) endFreshnessCheck(agentId);
    }
  };

  const isReconcileSuperseded = (generation: number) =>
    disposed || !connected || generation !== membershipGeneration;
  const membershipIsSettled = (requested: string[]) =>
    !membershipNeedsRetry && !freshnessCheckOwed && sameAgentIds(requested, acknowledged);
  const canStartFreshnessCheck = () => connected && ports.canCheckFreshness();

  const reconcileLatestMembership = async (): Promise<void> => {
    if (disposed || !connected || deliveryMode !== "selective") return;
    const generation = membershipGeneration;
    const requested = desired;
    if (membershipIsSettled(requested)) return;
    const canCheck = ports.canCheckFreshness();
    if (canCheck) {
      await Promise.all(requested.map((agentId) => cacheLoads.get(agentId)));
      if (isReconcileSuperseded(generation)) return;
    }
    membershipNeedsRetry = false;
    freshnessCheckOwed = false;
    const cursors = canCheck ? collectFreshnessCursors(requested) : undefined;
    const checked = Object.keys(cursors ?? {});
    askDaemonAboutFreshness(checked);
    notifyListeners();
    let timelines: Record<string, TimelineFreshness> | undefined;
    try {
      const answer = await ports.setSubscription(requested, cursors);
      timelines = answer?.timelines;
    } catch (error) {
      if (isReconcileSuperseded(generation)) return;
      for (const agentId of checked) endFreshnessCheck(agentId);
      membershipNeedsRetry = true;
      setVisibilityCatchUpError(requested, error);
      cancelMembershipRetry?.();
      cancelMembershipRetry = ports.schedule(() => {
        cancelMembershipRetry = null;
        if (
          disposed ||
          !connected ||
          membershipGeneration !== generation ||
          !sameAgentIds(desired, requested)
        ) {
          return;
        }
        void reconcileMembership();
      }, RETRY_DELAY_MS);
      ports.reportError(error);
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    if (disposed || !connected || deliveryMode !== "selective") return;
    acknowledged = requested;
    if (generation !== membershipGeneration) {
      await reconcileLatestMembership();
      return;
    }
    applyFreshnessAnswer(checked, timelines);
    startAcknowledgedCatchUps();
    if (!sameAgentIds(desired, acknowledged)) await reconcileLatestMembership();
  };

  const reconcileMembership = async () => {
    if (reconciling) {
      reconcileRequested = true;
      return;
    }
    if (disposed || !connected) return;
    reconciling = true;
    try {
      await reconcileLatestMembership();
    } finally {
      reconciling = false;
      if (reconcileRequested && !disposed && connected && deliveryMode === "selective") {
        reconcileRequested = false;
        void reconcileMembership();
      } else if (
        !disposed &&
        connected &&
        deliveryMode === "selective" &&
        !membershipNeedsRetry &&
        !sameAgentIds(desired, acknowledged)
      ) {
        void reconcileMembership();
      }
    }
  };

  const retryFailedCatchUps = () => {
    for (const agentId of acknowledged) {
      if (catchUps.get(agentId)?.status === "error") startCatchUp(agentId);
    }
  };

  const commitDesiredMembership = (
    nextDesired: string[],
    options: { resetCatchUpStatus?: boolean } = {},
  ) => {
    let statusChanged = false;
    if (options.resetCatchUpStatus) {
      for (const agentId of nextDesired) {
        if (!visibilityCatchUpPending.has(agentId)) {
          visibilityCatchUpPending.add(agentId);
          ports.onCatchUpOwed(agentId);
          statusChanged = true;
        }
        if (visibilityCatchUpErrors.delete(agentId)) statusChanged = true;
      }
    }
    if (sameAgentIds(nextDesired, desired)) {
      if (statusChanged) notifyListeners();
      if (deliveryMode === "selective" && !membershipIsSettled(nextDesired))
        void reconcileMembership();
      retryFailedCatchUps();
      return;
    }

    for (const agentId of desired) {
      if (!nextDesired.includes(agentId)) {
        cancelCatchUp(agentId);
        endFreshnessCheck(agentId);
        visibilityCatchUpPending.delete(agentId);
        visibilityCatchUpErrors.delete(agentId);
      }
    }
    for (const agentId of nextDesired) {
      if (!desired.includes(agentId)) {
        visibilityCatchUpPending.add(agentId);
        ports.onCatchUpOwed(agentId);
        visibilityCatchUpErrors.delete(agentId);
        manualRetries.delete(agentId);
        if (canStartFreshnessCheck()) startFreshnessCheck(agentId);
        ensureCacheLoaded(agentId);
      }
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    desired = nextDesired;
    ports.replaceDemandedAgentIds(desired);
    membershipGeneration += 1;
    notifyListeners();
    if (deliveryMode === "legacy") {
      acknowledged = connected ? desired : [];
      if (connected) startAcknowledgedCatchUps();
      return;
    }
    void reconcileMembership();
  };

  const clearLingeringRemovals = () => {
    for (const cancel of lingeringRemovals.values()) cancel();
    lingeringRemovals.clear();
  };

  const publishVisibleMembership = (allowGrace: boolean) => {
    const visible = visibleAgentIds();
    for (const agentId of visible) {
      lingeringRemovals.get(agentId)?.();
      lingeringRemovals.delete(agentId);
    }

    if (allowGrace && connected && deliveryMode === "selective") {
      for (const agentId of desired) {
        if (visible.includes(agentId) || lingeringRemovals.has(agentId)) continue;
        const cancel = ports.schedule(() => {
          lingeringRemovals.delete(agentId);
          commitDesiredMembership(effectiveAgentIds());
        }, VIEWED_TIMELINE_UNSUBSCRIBE_GRACE_MS);
        lingeringRemovals.set(agentId, cancel);
      }
    } else {
      clearLingeringRemovals();
    }

    commitDesiredMembership(effectiveAgentIds());
  };

  const getUnconfirmedStatus = (agentId: string): ViewedTimelineStatus => {
    const check = freshnessChecks.get(agentId);
    if (check) {
      if (!check.quiet) return "pending";
      return check.reattaching ? "reattaching" : "checking";
    }
    if (!ports.canCheckFreshness()) return "pending";
    if (!connected) return "reattaching";
    return isDesired(agentId) ? "pending" : "checking";
  };

  const retryVisibleAgentTimeline = (agentId: string) => {
    if (!isDesired(agentId) || manualRetries.has(agentId)) return;
    const catchUp = catchUps.get(agentId);
    const membershipRetryable = deliveryMode === "selective" && membershipNeedsRetry && connected;
    if (catchUp?.status !== "error" && !membershipRetryable) return;
    manualRetries.add(agentId);
    notifyListeners();
    if (catchUp?.status === "error") {
      catchUp.cancelRetry?.();
      startCatchUp(agentId, { request: catchUp.request, supersede: true });
      return;
    }
    cancelMembershipRetry?.();
    cancelMembershipRetry = null;
    membershipNeedsRetry = false;
    void reconcileMembership();
  };
  return {
    retryVisibleAgentTimeline,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getAgentTimelineStatus(agentId) {
      if (manualRetries.has(agentId)) return "pending";
      if (visibilityCatchUpErrors.has(agentId)) return "error";
      if (isDesired(agentId) && !visibilityCatchUpPending.has(agentId)) return "ready";
      return getUnconfirmedStatus(agentId);
    },
    getAgentTimelineError(agentId) {
      return visibilityCatchUpErrors.get(agentId) ?? null;
    },
    replaceVisibleAgentIds(sourceId, agentIds) {
      const normalized = normalizeAgentIds(agentIds);
      if (normalized.length === 0) sources.delete(sourceId);
      else sources.set(sourceId, normalized);
      publishVisibleMembership(true);
    },
    setActive(nextActive) {
      if (active === nextActive) return;
      active = nextActive;
      if (active && connected && ports.canCheckFreshness()) {
        for (const agentId of visibleAgentIds()) {
          if (
            catchUps.get(agentId)?.status !== "complete" ||
            pendingCatchUps.has(agentId) ||
            !ports.readCursor(agentId)
          )
            continue;
          catchUps.delete(agentId);
          visibilityCatchUpPending.add(agentId);
          ports.onCatchUpOwed(agentId);
          startFreshnessCheck(agentId);
          freshnessCheckOwed = true;
        }
      }
      publishVisibleMembership(true);
    },
    setConnected(nextConnected) {
      if (connected === nextConnected) return;
      connected = nextConnected;
      if (!connected) {
        clearLingeringRemovals();
        commitDesiredMembership(visibleAgentIds(), { resetCatchUpStatus: true });
        cancelMembershipRetry?.();
        cancelMembershipRetry = null;
        acknowledged = [];
        membershipGeneration += 1;
        freshnessCheckOwed = false;
        endAllFreshnessChecks();
        for (const agentId of desired) cancelCatchUp(agentId);
        return;
      }
      if (ports.canCheckFreshness()) {
        for (const agentId of desired) {
          if (visibilityCatchUpPending.has(agentId)) startFreshnessCheck(agentId, true);
        }
      }
      membershipGeneration += 1;
      notifyListeners();
      if (deliveryMode === "legacy") {
        acknowledged = desired;
        startAcknowledgedCatchUps();
      } else {
        void reconcileMembership();
      }
    },
    setDeliveryMode(nextMode) {
      if (deliveryMode === nextMode) return;
      deliveryMode = nextMode;
      clearLingeringRemovals();
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      membershipNeedsRetry = false;
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      const visible = active ? visibleAgentIds() : [];
      desired = visible;
      ports.replaceDemandedAgentIds(desired);
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      for (const agentId of desired) {
        visibilityCatchUpPending.add(agentId);
        ports.onCatchUpOwed(agentId);
      }
      acknowledged = deliveryMode === "legacy" && connected ? desired : [];
      notifyListeners();
      if (deliveryMode === "selective" && connected) void reconcileMembership();
      else if (connected) startAcknowledgedCatchUps();
    },
    reconcileAgent(agentId) {
      if (!isDesired(agentId)) return;
      const request = planTimelineTailFetch();
      if (catchUps.get(agentId)?.status === "running") {
        pendingCatchUps.set(agentId, request);
        return;
      }
      startCatchUp(agentId, { request, supersede: true });
    },
    recoverGap(agentId, cursor) {
      if (!isDesired(agentId)) return;
      startCatchUp(agentId, {
        request: planTimelineCatchUpAfter({ epoch: cursor.epoch, seq: cursor.endSeq }),
        supersede: true,
      });
    },
    dispose() {
      disposed = true;
      clearLingeringRemovals();
      cancelMembershipRetry?.();
      cancelMembershipRetry = null;
      sources.clear();
      membershipGeneration += 1;
      for (const agentId of desired) cancelCatchUp(agentId);
      desired = [];
      ports.replaceDemandedAgentIds([]);
      acknowledged = [];
      loadedCache.clear();
      cacheLoads.clear();
      visibilityCatchUpPending.clear();
      visibilityCatchUpErrors.clear();
      endAllFreshnessChecks();
      notifyListeners();
      listeners.clear();
    },
  };
}
