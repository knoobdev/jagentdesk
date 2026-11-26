import { describe, expect, test } from "vitest";

import type { AgentBackgroundWorkItem } from "./index.js";
import { BackgroundWorkTimeline } from "./timeline.js";

// Spec 38 §4.4b: Codex and OpenCode background work gets the same "Started in background" /
// "Background task finished" rows Claude's timeline carries.

const T0 = Date.parse("2026-11-26T10:00:00.000Z");

function shell(id: string, command: string, startedAtMs = T0): AgentBackgroundWorkItem {
  return {
    id,
    kind: "shell",
    description: null,
    command,
    startedAt: new Date(startedAtMs).toISOString(),
  };
}

function labels(rows: ReturnType<BackgroundWorkTimeline["update"]>): string[] {
  return rows.map((row) =>
    row.type === "tool_call" && row.detail.type === "plain_text" ? (row.detail.label ?? "") : "",
  );
}

describe("BackgroundWorkTimeline", () => {
  test("announces a start once and a finish with its duration when the item leaves", () => {
    const timeline = new BackgroundWorkTimeline();
    const started = timeline.update({
      agentId: "a",
      provider: "codex",
      items: [shell("p1", "npm test")],
      nowMs: T0,
    });
    expect(labels(started)).toEqual(["Started in background · npm test"]);
    expect(started[0]).toMatchObject({
      type: "tool_call",
      status: "completed",
      metadata: { source: "background_work", phase: "started", label: "npm test" },
    });

    expect(
      timeline.update({
        agentId: "a",
        provider: "codex",
        items: [shell("p1", "npm test")],
        nowMs: T0 + 1_000,
      }),
    ).toEqual([]);

    const finished = timeline.update({
      agentId: "a",
      provider: "codex",
      items: [],
      nowMs: T0 + 95_000,
    });
    expect(labels(finished)).toEqual(["Background task finished · npm test"]);
    expect(finished[0]).toMatchObject({
      metadata: { source: "background_work", phase: "finished", durationMs: 95_000 },
    });
    expect(finished[0]?.type === "tool_call" && finished[0].callId).not.toBe(
      started[0]?.type === "tool_call" && started[0].callId,
    );
  });

  test("labels work without a command by its description, then its kind", () => {
    const timeline = new BackgroundWorkTimeline();
    const rows = timeline.update({
      agentId: "a",
      provider: "opencode",
      items: [
        {
          id: "m1",
          kind: "monitor",
          description: "Watch the build",
          startedAt: new Date(T0).toISOString(),
        },
        { id: "o1", kind: "other", description: null, startedAt: new Date(T0).toISOString() },
      ],
      nowMs: T0,
    });
    expect(labels(rows)).toEqual([
      "Started in background · Watch the build",
      "Started in background · other",
    ]);
  });

  test("adds nothing for Claude, whose own timeline links start and end", () => {
    const timeline = new BackgroundWorkTimeline();
    expect(
      timeline.update({
        agentId: "a",
        provider: "claude",
        items: [shell("t1", "sleep 120")],
        nowMs: T0,
      }),
    ).toEqual([]);
  });

  test("ignores daemon-owned work such as heartbeats", () => {
    const timeline = new BackgroundWorkTimeline();
    expect(
      timeline.update({
        agentId: "a",
        provider: "codex",
        items: [
          {
            id: "heartbeat:h1",
            kind: "heartbeat",
            description: "Every hour",
            startedAt: new Date(T0).toISOString(),
          },
        ],
        nowMs: T0,
      }),
    ).toEqual([]);
  });

  test("work listed again after a reconnect is not announced twice", () => {
    const timeline = new BackgroundWorkTimeline();
    timeline.update({
      agentId: "a",
      provider: "codex",
      items: [shell("p1", "npm run dev")],
      nowMs: T0,
    });
    // The inventory reset in between (items: null) never reaches update().
    const relisted = timeline.update({
      agentId: "a",
      provider: "codex",
      items: [shell("p1", "npm run dev", T0 + 30_000)],
      nowMs: T0 + 30_000,
    });
    expect(relisted).toEqual([]);
  });

  test("forget drops what an agent announced", () => {
    const timeline = new BackgroundWorkTimeline();
    timeline.update({
      agentId: "a",
      provider: "codex",
      items: [shell("p1", "npm test")],
      nowMs: T0,
    });
    timeline.forget("a");
    expect(timeline.update({ agentId: "a", provider: "codex", items: [], nowMs: T0 + 1 })).toEqual(
      [],
    );
  });
});
