import { describe, test, expect, afterEach } from "vitest";
import pino from "pino";
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

  test("chat trigger: bootstrapLead hands the origin agent the team-lead brief", async () => {
    const logs: string[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => logs.push(line) });
    ctx = await createDaemonTestContext({ logger });
    const agent = await ctx.client.createAgent({
      provider: "codex",
      model: "gpt-5.4-mini",
      cwd: "/tmp",
      title: "Team Lead Agent",
    });

    // This is what the composer's Team-mode send does: create the topic AND bootstrap the lead.
    const topic = await ctx.client.forumCreate({
      prompt: "Build a landing page like example.com",
      originAgentId: agent.id,
      bootstrapLead: true,
    });
    expect(topic?.leadAgentId).toBe(agent.id);

    // The bootstrap dispatches the team-lead brief to the origin agent, so its timeline receives a
    // turn containing the lead instructions + the user's request.
    // The bootstrap dispatches the team-lead brief to the origin agent, which runs a turn. The fresh
    // agent had no turns before; after the brief it has recorded one (assistant reply present + a
    // completed turn). That proves the chat trigger actually started the agent as the lead.
    let ranTurn = false;
    for (let i = 0; i < 60 && !ranTurn; i++) {
      const tl = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 30 });
      const turns = (tl as { agent?: { usageTotals?: { turns?: number } } })?.agent?.usageTotals
        ?.turns;
      ranTurn = typeof turns === "number" && turns >= 1;
      if (!ranTurn) await new Promise((r) => setTimeout(r, 300));
    }
    const bootstrapLog = logs.some((l) => /Forum bootstrap dispatched/.test(l));
    expect(ranTurn, "origin agent ran a turn from the team-lead brief").toBe(true);
    expect(bootstrapLog, "the bootstrap dispatched the brief").toBe(true);
  }, 90000);
});
