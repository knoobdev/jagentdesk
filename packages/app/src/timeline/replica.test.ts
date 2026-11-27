import { afterEach, expect, test } from "vitest";
import type { AgentStreamEventPayload } from "@jagentdesk/protocol/messages";
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

test("replaces pre-rewind history when a live row arrives in a new epoch", async () => {
  useSessionStore.getState().initializeSession(SERVER_ID, null);
  useSessionStore.getState().applyAgentTimelineResponseState(SERVER_ID, AGENT_ID, {
    items: [
      {
        kind: "assistant_message",
        id: "network-reply",
        text: "before rewind",
        timestamp: STARTED_AT,
        timelineCursor: { epoch: "epoch-1", seq: 5 },
      },
    ],
    head: [],
    range: { epoch: "epoch-1", startSeq: 1, endSeq: 5 },
    older: "available",
    newer: false,
    synchronized: true,
    acknowledgedClientMessageIds: [],
  });
  const readTimelineState = () => {
    const timeline = selectAgentTimelineState(
      useSessionStore.getState().sessions[SERVER_ID],
      AGENT_ID,
    );
    return {
      status: timeline.status,
      texts:
        timeline.status === "cold"
          ? []
          : timeline.items.flatMap((entry) =>
              entry.kind === "assistant_message" ? [entry.text] : [],
            ),
    };
  };
  const fetches: Array<{ direction: string; cursor?: { epoch: string; seq: number } }> = [];
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage: { readTimeline: async () => undefined, commitTimeline: () => undefined },
    prepareAgent: async () => undefined,
  });
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
      fetchPage: async (_agentId, request) => {
        fetches.push(request);
        if (request.direction !== "after") return { hasNewer: false, endCursor: null };
        // A cursor from the pre-rewind epoch makes the daemon reset to its current tail.
        owner.applyTimelineResponse({
          requestId: "rewind-reset",
          agentId: AGENT_ID,
          agent: null,
          direction: "tail",
          projection: "projected",
          epoch: "epoch-2",
          reset: true,
          staleCursor: true,
          gap: false,
          window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
          startCursor: { epoch: "epoch-2", seq: 1 },
          endCursor: { epoch: "epoch-2", seq: 2 },
          entries: [
            {
              provider: "codex",
              item: { type: "assistant_message", text: "after rewind" },
              timestamp: "2026-08-26T10:05:00.000Z",
              seqStart: 1,
              seqEnd: 2,
              sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
              collapsed: [],
            },
          ],
          hasOlder: false,
          hasNewer: false,
          error: null,
        });
        return { hasNewer: false, endCursor: { epoch: "epoch-2", seq: 2 } };
      },
      reportError: () => undefined,
      schedule: () => () => undefined,
    },
  });
  try {
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("test", [AGENT_ID]);
    const opened = fetches.length;

    owner.enqueueStreamEvent(AGENT_ID, {
      event: {
        type: "timeline",
        provider: "codex",
        item: { type: "assistant_message", text: "new prompt reply" },
      } as AgentStreamEventPayload,
      seq: 6,
      epoch: "epoch-2",
      timestamp: new Date("2026-08-26T10:06:00.000Z"),
    });
    owner.flushStreamAgent(AGENT_ID);

    await expect.poll(() => fetches.length).toBe(opened + 1);
    expect(fetches.at(-1)).toMatchObject({
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 5 },
    });
    await expect.poll(readTimelineState).toEqual({
      status: "synced",
      texts: ["after rewind"],
    });
  } finally {
    owner.dispose();
  }
});
