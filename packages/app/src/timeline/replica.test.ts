import { afterEach, expect, test } from "vitest";
import type { CachedTimeline } from "@/runtime/replica-cache";
import {
  selectAgentTimelineState,
  selectAgentTimelineTurnPresentation,
  selectAgentTurnPresentation,
  useSessionStore,
} from "@/stores/session-store";
import { createTimelineReplica, createViewedTimelineOwner } from "./viewed-timeline-sync";

const SERVER_ID = "timeline-replica-host";
const AGENT_ID = "agent-1";
const STARTED_AT = new Date("2026-08-26T10:00:00.000Z");

function cachedTimeline(): CachedTimeline {
  return {
    agentId: AGENT_ID,
    items: [
      {
        kind: "assistant_message",
        id: "cached-reply",
        text: "Cached reply",
        timestamp: STARTED_AT,
        timelineCursor: { epoch: "epoch-1", seq: 4 },
      },
    ],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 4 },
    hasOlder: true,
    unsettledTurn: { turnId: "turn-1", startedAt: STARTED_AT },
  };
}

afterEach(() => useSessionStore.getState().clearSession(SERVER_ID));

test("keeps the cached running footer until the messages become current", async () => {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, null);
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage: { readTimeline: async () => cachedTimeline(), commitTimeline: () => undefined },
    prepareAgent: async () => undefined,
  });
  await replica.prepare(AGENT_ID);
  const session = useSessionStore.getState().sessions[SERVER_ID];
  expect(selectAgentTurnPresentation(session, AGENT_ID).isActive).toBe(false);
  expect(selectAgentTimelineTurnPresentation(session, AGENT_ID)).toEqual({
    isActive: true,
    isCancelling: false,
    startedAt: STARTED_AT,
    turnId: "turn-1",
  });
  replica.catchUpSettled(AGENT_ID);
  expect(
    selectAgentTimelineTurnPresentation(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID)
      .isActive,
  ).toBe(false);
});

test("an empty current page retains the cached range and settles the held footer", async () => {
  useSessionStore.getState().initializeSession(SERVER_ID, null);
  const saved: CachedTimeline[] = [];
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage: {
      readTimeline: async () => cachedTimeline(),
      commitTimeline: (_serverId, _agentId, timeline) => {
        saved.push(timeline);
      },
    },
    prepareAgent: async () => undefined,
  });
  await replica.prepare(AGENT_ID);
  const owner = createViewedTimelineOwner({
    serverId: SERVER_ID,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      canCheckFreshness: () => false,
      initialDeliveryMode: "selective",
      setSubscription: async () => undefined,
      readCursor: () => undefined,
      fetchPage: async () => {
        throw new Error("An unchanged chat must not fetch");
      },
      reportError: (error) => {
        throw error;
      },
      schedule: () => () => undefined,
    },
  });
  owner.applyTimelineResponse({
    requestId: "current",
    agentId: AGENT_ID,
    agent: null,
    direction: "after",
    projection: "projected",
    epoch: "epoch-1",
    reset: false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 0, maxSeq: 4, nextSeq: 5 },
    startCursor: null,
    endCursor: null,
    hasOlder: false,
    hasNewer: false,
    entries: [],
    error: null,
  });
  expect(
    selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID),
  ).toMatchObject({ status: "synced", range: cachedTimeline().range });
  expect(saved.at(-1)?.range).toEqual(cachedTimeline().range);
  expect(saved.at(-1)?.unsettledTurn).toBeUndefined();
  owner.dispose();
});

test("a late cache read cannot restore a held footer after its catch-up has settled", async () => {
  useSessionStore.getState().initializeSession(SERVER_ID, null);
  let resolve!: (timeline: CachedTimeline) => void;
  const read = new Promise<CachedTimeline>((accept) => {
    resolve = accept;
  });
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage: { readTimeline: () => read, commitTimeline: () => undefined },
    prepareAgent: async () => undefined,
  });
  const preparing = replica.prepare(AGENT_ID);
  replica.catchUpSettled(AGENT_ID);
  resolve(cachedTimeline());
  await preparing;
  expect(
    selectAgentTimelineTurnPresentation(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID)
      .isActive,
  ).toBe(false);
});
