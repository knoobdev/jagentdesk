import { describe, expect, test } from "vitest";

import {
  ServerInfoStatusPayloadSchema,
  SessionEventSubscriptionSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

const ITEM = {
  id: "bash-1",
  kind: "shell",
  description: "sleep 20",
  startedAt: "2026-10-06T10:00:00.000Z",
};

describe("agent background work protocol", () => {
  test("accepts a list request and its response", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.background_work.list.request",
        agentId: "agent-1",
        requestId: "request-1",
      }),
    ).toMatchObject({ agentId: "agent-1", requestId: "request-1" });

    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_work.list.response",
        payload: { requestId: "request-1", agentId: "agent-1", items: [ITEM], error: null },
      }),
    ).toMatchObject({ payload: { items: [ITEM] } });
  });

  test("accepts an update with or without a subscription id", () => {
    for (const payload of [
      { agentId: "agent-1", items: [] },
      { subscriptionId: "events-1", agentId: "agent-1", items: [ITEM] },
    ]) {
      expect(
        SessionOutboundMessageSchema.parse({ type: "agent.background_work.update", payload }),
      ).toMatchObject({ payload });
    }
  });

  test("keeps kind an open string so new kinds parse on old clients", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_work.update",
        payload: { agentId: "agent-1", items: [{ ...ITEM, kind: "future-kind" }] },
      }),
    ).toMatchObject({ payload: { items: [{ kind: "future-kind" }] } });
  });

  test("preserves an optional command while accepting older items", () => {
    const withCommand = { ...ITEM, description: "Watch build", command: "tail -f build.log" };
    const parsed = SessionOutboundMessageSchema.parse({
      type: "agent.background_work.update",
      payload: { agentId: "agent-1", items: [ITEM, withCommand] },
    });
    expect(parsed).toMatchObject({ payload: { items: [ITEM, withCommand] } });
  });

  test("is a subscribable event", () => {
    expect(SessionEventSubscriptionSchema.parse("agent.background_work.update")).toBe(
      "agent.background_work.update",
    );
  });

  test("keeps the feature optional for older server info payloads", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: {},
      }).features?.agentBackgroundWork,
    ).toBeUndefined();
  });
});

test("stop requests carry an inventory token and preserve legacy item parsing", () => {
  expect(
    SessionInboundMessageSchema.parse({
      type: "agent.background_work.stop.request",
      agentId: "a",
      itemId: "x",
      stopToken: "token",
      requestId: "r",
    }),
  ).toMatchObject({ stopToken: "token" });
  expect(
    SessionOutboundMessageSchema.parse({
      type: "agent.background_work.stop.response",
      payload: { requestId: "r", agentId: "a", itemId: "x", error: null },
    }),
  ).toMatchObject({ payload: { error: null } });
  expect(
    SessionOutboundMessageSchema.parse({
      type: "agent.background_work.update",
      payload: { agentId: "a", items: [ITEM] },
    }),
  ).toMatchObject({ payload: { items: [ITEM] } });
});

// ADR-0062: detail and output of one background item.
describe("background work detail and output protocol", () => {
  test("accepts the detail request and a detail without optional fields", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.background_work.get_detail.request",
        agentId: "agent-1",
        itemId: "bash-1",
        requestId: "request-1",
      }),
    ).toMatchObject({ itemId: "bash-1" });
    const detail = {
      ...ITEM,
      status: "running",
      endedAt: null,
      exitCode: null,
      cwd: null,
      provider: "claude",
      outputAvailable: true,
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_work.get_detail.response",
        payload: { requestId: "r", agentId: "a", itemId: "bash-1", detail, error: null },
      }),
    ).toMatchObject({ payload: { detail } });
  });

  test("the output subscribe request carries no path; extra fields are dropped", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "agent.background_work.output.subscribe.request",
      agentId: "agent-1",
      itemId: "bash-1",
      subscriptionId: "sub-1",
      requestId: "request-1",
      path: "/etc/passwd",
    });
    expect(parsed).not.toHaveProperty("path");
  });

  test("accepts output pushes with and without the optional fields", () => {
    for (const payload of [
      { subscriptionId: "s", agentId: "a", itemId: "i", chunk: "x", offset: 0 },
      {
        subscriptionId: "s",
        agentId: "a",
        itemId: "i",
        chunk: "x",
        offset: 4,
        nextOffset: 5,
        reset: true,
      },
    ])
      expect(
        SessionOutboundMessageSchema.parse({ type: "agent.background_work.output", payload }),
      ).toMatchObject({ payload });
  });

  test("server info advertises the feature as optional", () => {
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: { backgroundWorkOutput: true },
      }).features,
    ).toMatchObject({ backgroundWorkOutput: true });
  });
});

// ADR-0064: redirect files, the script and the agent's latest read as detail sources.
describe("background work sources protocol", () => {
  const detail = {
    ...ITEM,
    status: "running",
    endedAt: null,
    exitCode: null,
    cwd: "/repo",
    provider: "codex",
    outputAvailable: false,
  };

  test("a detail carries its sources; unknown kinds still parse", () => {
    const sources = [
      { id: "provider", kind: "provider", label: "", available: false },
      {
        id: "redirect:0",
        kind: "redirect",
        label: "t.log",
        path: "/tmp/t.log",
        available: true,
        size: 12,
        modifiedAt: "2026-11-28T10:00:00.000Z",
        lastRead: { at: "2026-11-28T10:01:00.000Z", content: "PASS", truncated: false },
      },
      {
        id: "script",
        kind: "script",
        label: "wait.sh",
        script: { content: "sleep 1\n", truncated: false, lineCount: 1 },
      },
      { id: "x", kind: "future-kind", label: "x" },
    ];
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_work.get_detail.response",
        payload: {
          requestId: "r",
          agentId: "a",
          itemId: "bash-1",
          detail: { ...detail, sources },
          error: null,
        },
      }),
    ).toMatchObject({ payload: { detail: { sources } } });
  });

  test("subscribe names a source by id and pushes echo it; both stay optional", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.background_work.output.subscribe.request",
        agentId: "a",
        itemId: "i",
        subscriptionId: "s",
        sourceId: "redirect:0",
        requestId: "r",
      }),
    ).toMatchObject({ sourceId: "redirect:0" });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.background_work.output",
        payload: {
          subscriptionId: "s",
          agentId: "a",
          itemId: "i",
          sourceId: "redirect:0",
          chunk: "x",
          offset: 0,
        },
      }),
    ).toMatchObject({ payload: { sourceId: "redirect:0" } });
    expect(
      ServerInfoStatusPayloadSchema.parse({
        status: "server_info",
        serverId: "server-1",
        features: { backgroundWorkSources: true },
      }).features,
    ).toMatchObject({ backgroundWorkSources: true });
  });
});
