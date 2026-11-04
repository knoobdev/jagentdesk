import { describe, expect, it } from "vitest";
import { toPlanTreeJson } from "./archify-json.js";
import type { ActivityRow } from "./flow-builder.js";
import { buildPlanGraph } from "./plan-builder.js";
import { parseSpecKitTasks } from "./spec-plan-source.js";

// Spec 31.1 Plan view: root = request, children = todos; with Spec mode, tasks.md phases → tasks.

const TASKS_MD = `# Tasks: Session refresh

## Phase 1: Setup
- [x] T001 Create the session fixtures
- [x] T002 [P] Add the clock helper

## Phase 2: Core
- [ ] T003 [US1] Patch expiry handling in src/auth/session.ts
- [ ] T004 [P] [US1] Add the refresh regression test
- [ ] T005 Wire the retry policy

## Phase 3: Polish
- [ ] T006 Update the changelog
`;

const rows: ActivityRow[] = [
  { seq: 1, item: { type: "user_message", text: "Fix the refresh race" } },
  {
    seq: 2,
    item: {
      type: "todo",
      items: [
        { id: "1", text: "Inspect the session module", status: "completed", completed: true },
        { id: "2", text: "Find the refresh race", status: "in_progress", completed: false },
        { text: "Add a regression test", completed: false },
      ],
    },
  },
];

describe("parseSpecKitTasks", () => {
  it("groups tasks by phase and keeps ids, [P] and story marks", () => {
    const plan = parseSpecKitTasks(TASKS_MD);
    expect(plan.phases.map((phase) => [phase.id, phase.title, phase.status])).toEqual([
      ["phase-1", "Phase 1: Setup", "done"],
      ["phase-2", "Phase 2: Core", "pending"],
      ["phase-3", "Phase 3: Polish", "pending"],
    ]);
    const tasks = plan.phases.flatMap((phase) => phase.tasks);
    expect(tasks).toHaveLength(6);
    expect(tasks.filter((task) => task.parallel).map((task) => task.id)).toEqual(["T002", "T004"]);
    expect(tasks[3]).toEqual({
      id: "T004",
      text: "Add the refresh regression test",
      done: false,
      parallel: true,
      story: "US1",
    });
  });
});

describe("buildPlanGraph", () => {
  it("draws todos under the request with their statuses (generic ACP status derived)", () => {
    const result = buildPlanGraph({ rows, running: true })!;
    const json = toPlanTreeJson(result.model);
    expect(json.layout).toEqual({ direction: "right" });
    expect(json.nodes).toEqual([
      { id: "root", label: "Fix the refresh race" },
      { id: "todo-1", label: "Inspect the session module", parent: "root" },
      { id: "todo-2", label: "Find the refresh race", parent: "root" },
      {
        id: expect.stringMatching(/^todo-h[0-9a-f]{8}$/),
        label: "Add a regression test",
        parent: "root",
      },
    ]);
    expect(result.model.nodes.map((node) => node.status)).toEqual([
      "running",
      "done",
      "running",
      "pending",
    ]);
  });

  it("with Spec mode on, shows phases and the six tasks with two marked parallel (31.7 #5)", () => {
    const result = buildPlanGraph({ rows, running: true }, parseSpecKitTasks(TASKS_MD))!;
    const phases = result.model.nodes.filter((node) => node.kind === "phase");
    const tasks = result.model.nodes.filter((node) => node.kind === "task");
    expect(phases.map((node) => node.label)).toEqual([
      "Phase 1: Setup",
      "Phase 2: Core",
      "Phase 3: Polish",
    ]);
    expect(tasks).toHaveLength(6);
    expect(tasks.filter((node) => node.sublabel?.startsWith("[P] parallel"))).toHaveLength(2);
    const json = toPlanTreeJson(result.model);
    // A finished phase starts folded.
    expect(
      (json.nodes as Array<Record<string, unknown>>).find((node) => node.id === "phase-1"),
    ).toMatchObject({ collapsed: true });
  });
});
