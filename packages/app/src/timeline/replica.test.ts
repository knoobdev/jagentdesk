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
      fetchLatestTail: async () => {
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
      fetchLatestTail: async () => ({ hasNewer: false, endCursor: null }),
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

function toolRows(fromSeq: number, toSeq: number) {
  return Array.from({ length: toSeq - fromSeq + 1 }, (_unused, index) => {
    const seq = fromSeq + index;
    return {
      provider: "codex" as const,
      item: {
        type: "tool_call" as const,
        callId: `call-${seq}`,
        name: "Bash",
        status: "completed" as const,
        error: null,
        detail: { type: "shell" as const, command: `echo ${seq}`, output: `${seq}` },
      },
      timestamp: new Date(STARTED_AT.getTime() + seq * 1000).toISOString(),
      seqStart: seq,
      seqEnd: seq,
      sourceSeqRanges: [{ startSeq: seq, endSeq: seq }],
      collapsed: [],
    };
  });
}

function timelinePage(input: {
  direction: "tail" | "after";
  fromSeq: number;
  toSeq: number;
  maxSeq: number;
  reset?: boolean;
}) {
  return {
    requestId: `${input.direction}-${input.fromSeq}`,
    agentId: AGENT_ID,
    agent: null,
    direction: input.direction,
    projection: "projected" as const,
    epoch: "epoch-1",
    reset: input.reset ?? false,
    staleCursor: false,
    gap: false,
    window: { minSeq: 1, maxSeq: input.maxSeq, nextSeq: input.maxSeq + 1 },
    startCursor: { epoch: "epoch-1", seq: input.fromSeq },
    endCursor: { epoch: "epoch-1", seq: input.toSeq },
    entries: toolRows(input.fromSeq, input.toSeq),
    hasOlder: input.fromSeq > 1,
    hasNewer: input.toSeq < input.maxSeq,
    error: null,
  };
}

test("a chat that resumes far behind lands on the daemon's newest row and keeps taking live rows", async () => {
  useSessionStore.getState().initializeSession(SERVER_ID, null);
  const replica = createTimelineReplica({
    serverId: SERVER_ID,
    storage: { readTimeline: async () => undefined, commitTimeline: () => undefined },
    prepareAgent: async () => undefined,
  });
  const readTimeline = () =>
    selectAgentTimelineState(useSessionStore.getState().sessions[SERVER_ID], AGENT_ID);
  const fetches: Array<{ direction: string; cursor?: { seq: number } }> = [];
  let latestTails = 0;
  // The desktop kept the agent busy while this chat was away: the daemon is now at 900.
  let daemonHead = 4;
  const owner = createViewedTimelineOwner({
    serverId: SERVER_ID,
    replica,
    replaceDemandedAgentIds: () => undefined,
    drainQueuedAgentMessage: () => undefined,
    ports: {
      canCheckFreshness: () => false,
      initialDeliveryMode: "selective",
      setSubscription: async () => undefined,
      readCursor: (agentId) => {
        const timeline = selectAgentTimelineState(
          useSessionStore.getState().sessions[SERVER_ID],
          agentId,
        );
        return timeline.status === "synced" ? (timeline.range ?? undefined) : undefined;
      },
      fetchPage: async (_agentId, request) => {
        fetches.push(request);
        const fromSeq = request.direction === "after" ? request.cursor.seq + 1 : 1;
        const toSeq = Math.min(daemonHead, fromSeq + 39);
        owner.applyTimelineResponse(
          timelinePage({ direction: request.direction, fromSeq, toSeq, maxSeq: daemonHead }),
        );
        return { hasNewer: toSeq < daemonHead, endCursor: { epoch: "epoch-1", seq: toSeq } };
      },
      fetchLatestTail: async () => {
        latestTails += 1;
        // session-context marks the latest tail as a replacement (`reset`).
        owner.applyTimelineResponse(
          timelinePage({
            direction: "tail",
            fromSeq: daemonHead - 39,
            toSeq: daemonHead,
            maxSeq: daemonHead,
            reset: true,
          }),
        );
        return { hasNewer: false, endCursor: { epoch: "epoch-1", seq: daemonHead } };
      },
      reportError: (error) => {
        throw error;
      },
      schedule: () => () => undefined,
    },
  });
  try {
    owner.setConnected(true);
    owner.replaceVisibleAgentIds("pane", [AGENT_ID]);
    await expect.poll(() => owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready");
    expect(readTimeline()).toMatchObject({ status: "synced", range: { endSeq: 4 } });

    owner.setConnected(false);
    daemonHead = 900;
    owner.setConnected(true);

    await expect.poll(() => owner.getAgentTimelineStatus(AGENT_ID)).toBe("ready");
    expect(fetches.map((fetch) => fetch.direction)).toEqual(["tail", "after"]);
    expect(latestTails).toBe(1);
    expect(readTimeline()).toMatchObject({
      status: "synced",
      range: { endSeq: 900 },
      older: "available",
      newer: "none",
    });

    owner.enqueueStreamEvent(AGENT_ID, {
      event: { type: "timeline", provider: "codex", item: toolRows(901, 901)[0].item },
      seq: 901,
      epoch: "epoch-1",
      timestamp: new Date(STARTED_AT.getTime() + 901_000),
    });
    owner.flushStreamAgent(AGENT_ID);
    expect(readTimeline()).toMatchObject({ range: { endSeq: 901 } });
  } finally {
    owner.dispose();
  }
});
