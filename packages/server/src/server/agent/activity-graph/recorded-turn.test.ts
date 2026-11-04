import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import { toLifecycleJson } from "./archify-json.js";
import { buildFlowGraph, type ActivityRow } from "./flow-builder.js";

// Projected timeline recorded from the built daemon (fetch_agent_timeline, projection "projected")
// after the mock provider's scripted "emit synthetic activity graph" turn completed.
const here = path.dirname(fileURLToPath(import.meta.url));
const recorded = JSON.parse(
  readFileSync(path.join(here, "__fixtures__", "mock-activity-turn.timeline.json"), "utf8"),
) as Array<{ item: AgentTimelineItem; seqStart: number; seqEnd: number }>;
const rows: ActivityRow[] = recorded.map((entry) => ({
  seq: entry.seqEnd,
  seqStart: entry.seqStart,
  item: entry.item,
}));
const TURN = "f03d7440-5465-494e-901c-5cad7f9c5bcf";

describe("recorded mock turn → Flow lifecycle JSON", () => {
  it("draws start, the two tool runs, the returning subagent branch and the answer", () => {
    const result = buildFlowGraph({
      rows,
      running: false,
      latestTurnOutcome: "completed",
      subagents: [
        {
          id: `${TURN}:explore`,
          title: "Explore",
          description: "Map session refresh callers",
          status: "completed",
          toolCallId: `${TURN}:task`,
        },
      ],
    })!;
    const json = toLifecycleJson(result.model);
    const read = `tools-${TURN}_read-30ed0423`;
    const task = `tools-${TURN}_task-5424bd5f`;
    const sub = `sa-${TURN}_task-5424bd5f`;
    expect(json.mainPath).toEqual(["start", read, task, "end"]);
    expect(json.states).toEqual([
      {
        id: "start",
        type: "start",
        label: "emit synthetic activity graph",
        sublabel: "hold=5000 pace=900",
      },
      {
        id: read,
        type: "active",
        label: "2 tool calls",
        sublabel: "Read · Search",
        tag: "tools",
        step: "01",
        icon: "none",
      },
      {
        id: task,
        type: "active",
        label: "2 tool calls",
        sublabel: "Explore · Edit",
        tag: "tools",
        step: "02",
        icon: "none",
      },
      {
        id: "end",
        type: "success",
        label: "Answer",
        sublabel: "Fixed the refresh race in src/auth/sessio…",
        tag: "end",
        step: "03",
        icon: "none",
      },
      {
        id: sub,
        type: "external",
        label: "Explore",
        sublabel: "Map session refresh callers",
        tag: "subagent",
        icon: "none",
      },
    ]);
    expect(Object.fromEntries(result.model.nodes.map((node) => [node.id, node.status]))).toEqual({
      start: "done",
      [read]: "done",
      [task]: "done",
      end: "done",
      [sub]: "done",
    });
    // Same ids the live daemon pushed during the turn (rpc proof, graph-live.json).
    expect(result.model.nodes.find((node) => node.id === sub)?.ref).toMatchObject({
      subagentId: `${TURN}:explore`,
    });
  });
});
