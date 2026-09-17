import { describe, test, expect, afterEach } from "vitest";
import type { StoredForumTopic } from "@jagentdesk/protocol/messages";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

// Stage-2 backend contract for the Agent Forum / Team mode (docs/plans/active/agent-forum.md):
// create → list → get → archive over the real daemon RPCs, plus the forum.stream push. The
// orchestration bootstrap is disabled here so this exercises only the data + transport layer.

describe("agent forum — data + RPC layer", () => {
  let ctx: DaemonTestContext;

  afterEach(async () => {
    await ctx?.cleanup();
  }, 30000);

  test("create → list → get → archive, with a live forum.stream", async () => {
    ctx = await createDaemonTestContext({});

    const streamed: StoredForumTopic[] = [];
    const unsub = ctx.client.subscribeForumStream((topic) => streamed.push(topic));

    // Create a topic (no orchestration bootstrap in the test daemon).
    const created = await ctx.client.forumCreate({
      prompt: "Build a landing page like example.com",
      bootstrapLead: false,
    });
    expect(created).toBeTruthy();
    expect(created?.status).toBe("planning");
    // The originating prompt is seeded as the first (user) message.
    expect(created?.messages.at(0)?.role).toBe("user");
    expect(created?.messages.at(0)?.text).toContain("landing page");
    const topicId = created!.id;

    // list reflects it as a summary.
    const list = await ctx.client.forumList();
    const summary = list.find((t) => t.id === topicId);
    expect(summary, "topic appears in the list").toBeTruthy();
    expect(summary?.messageCount).toBe(1);
    expect(summary?.taskCount).toBe(0);

    // get returns the full topic.
    const fetched = await ctx.client.forumGet(topicId);
    expect(fetched?.id).toBe(topicId);
    expect(fetched?.title).toContain("landing page");

    // archive flips status and streams the change.
    const archived = await ctx.client.forumArchive(topicId);
    expect(archived?.status).toBe("archived");

    // The stream fired at least for create + archive.
    expect(streamed.some((t) => t.id === topicId && t.status === "planning")).toBe(true);
    expect(streamed.some((t) => t.id === topicId && t.status === "archived")).toBe(true);

    // get on a missing topic is a clean null (not a hang).
    const missing = await ctx.client.forumGet("topic_does_not_exist");
    expect(missing).toBeNull();

    unsub();
  }, 60000);
});
