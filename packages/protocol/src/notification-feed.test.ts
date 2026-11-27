import { describe, expect, test } from "vitest";
import {
  SessionEventSubscriptionSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";
import { NotificationFeedChangedMessageSchema } from "./notification-feed.js";

const item = {
  id: "nf_1",
  kind: "agent_finished",
  title: "Agent finished",
  body: "Finished working.",
  target: { type: "agent", agentId: "agent-1", workspaceId: "wks_1" },
  createdAtMs: 1_800_000_000_000,
  readAtMs: null,
};

describe("notification feed protocol", () => {
  test("requests parse in the session inbound union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "notifications.feed.list.request",
        requestId: "r1",
        before: "nf_9",
        limit: 50,
      }),
    ).toMatchObject({ type: "notifications.feed.list.request", before: "nf_9" });
    expect(
      SessionInboundMessageSchema.parse({
        type: "notifications.feed.mark_read.request",
        requestId: "r2",
        all: true,
      }),
    ).toMatchObject({ all: true });
  });

  test("responses and the changed event parse in the session outbound union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "notifications.feed.list.response",
        payload: { requestId: "r1", items: [item], unreadCount: 1, hasMore: false },
      }),
    ).toMatchObject({ payload: { items: [item] } });
    expect(
      SessionOutboundMessageSchema.parse({
        type: "notifications.feed.changed",
        payload: { readIds: ["nf_1"], unreadCount: 0, unreadPlugins: {} },
      }),
    ).toMatchObject({ payload: { readIds: ["nf_1"] } });
  });

  test("a kind or target type this client does not know still parses", () => {
    const parsed = NotificationFeedChangedMessageSchema.parse({
      type: "notifications.feed.changed",
      payload: {
        appended: [{ ...item, kind: "terminal_finished", target: { type: "terminal", extra: 1 } }],
        unreadCount: 1,
      },
    });
    expect(parsed.payload.appended?.[0]?.kind).toBe("terminal_finished");
  });

  test("clients subscribe to the event by name and the host advertises the feature", () => {
    expect(SessionEventSubscriptionSchema.parse("notifications.feed.changed")).toBe(
      "notifications.feed.changed",
    );
    const info = ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "srv_1",
      features: { notificationFeed: true },
    });
    expect(info.features).toMatchObject({ notificationFeed: true });
  });
});
