import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SpecModeState } from "@jagentdesk/protocol/spec-mode";
import { SpecModePlanSource } from "./plan-source.js";

const TASKS = `# Tasks: todo-cli

## Phase 1: Setup
- [x] T001 Create project structure
- [ ] T002 [P] Configure linting
- [ ] T003 [P] Configure formatting

## Phase 2: Core
- [ ] T004 [US1] Add todo command
- [ ] T005 [US1] List todos
- [ ] T006 Persist todos to disk
`;

function state(overrides: Partial<SpecModeState> = {}): SpecModeState {
  return {
    agentId: "agt_a1b2c3",
    enabled: true,
    optionalPhases: [],
    featureDirectory: "specs/001-todo-cli",
    phase: "implement",
    phaseStatus: {
      constitution: "skipped",
      specify: "done",
      clarify: "skipped",
      plan: "done",
      checklist: "skipped",
      tasks: "done",
      analyze: "skipped",
      implement: "running",
      converge: "pending",
    },
    converged: false,
    reviewFiles: [],
    sharedCheckout: false,
    updatedAt_ms: 0,
    ...overrides,
  };
}

describe("SpecModePlanSource", () => {
  let cwd: string;
  let current: SpecModeState | null;
  let source: SpecModePlanSource;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "jad-spec-plan-"));
    current = state();
    source = new SpecModePlanSource({
      getState: async () => current,
      agentCwd: () => cwd,
      logger: pino({ level: "silent" }),
      debounceMs: 10,
    });
  });

  afterEach(async () => {
    source.dispose();
    await rm(cwd, { recursive: true, force: true });
  });

  it("returns null when Spec mode is off", async () => {
    current = state({ enabled: false });
    expect(await source.getPlan("agt_a1b2c3")).toBeNull();
  });

  it("shows the enabled Spec mode phases before tasks.md exists", async () => {
    current = state({
      featureDirectory: null,
      phase: "specify",
      phaseStatus: {
        ...state().phaseStatus,
        specify: "running",
        plan: "pending",
        tasks: "pending",
        implement: "pending",
      },
    });
    const plan = await source.getPlan("agt_a1b2c3");
    expect(plan?.title).toBe("Spec mode");
    expect(plan?.phases.map((phase) => [phase.title, phase.status])).toEqual([
      ["Specify", "running"],
      ["Plan", "pending"],
      ["Tasks", "pending"],
      ["Implement", "pending"],
      ["Converge", "pending"],
    ]);
  });

  it("reads phases and tasks from tasks.md, marking [P] tasks parallel", async () => {
    await mkdir(path.join(cwd, "specs/001-todo-cli"), { recursive: true });
    await writeFile(path.join(cwd, "specs/001-todo-cli/tasks.md"), TASKS);
    const plan = await source.getPlan("agt_a1b2c3");
    expect(plan?.title).toBe("001-todo-cli");
    expect(plan?.phases.map((phase) => phase.title)).toEqual(["Phase 1: Setup", "Phase 2: Core"]);
    const tasks = plan!.phases.flatMap((phase) => phase.tasks);
    expect(tasks).toHaveLength(6);
    expect(tasks.filter((task) => task.parallel).map((task) => task.id)).toEqual(["T002", "T003"]);
    expect(plan?.phases[0]?.status).toBe("running");
  });

  it("notifies subscribers when tasks.md changes and when Spec mode state changes", async () => {
    const dir = path.join(cwd, "specs/001-todo-cli");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "tasks.md"), TASKS);
    let calls = 0;
    const unsubscribe = source.subscribe("agt_a1b2c3", () => {
      calls += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeFile(path.join(dir, "tasks.md"), TASKS.replace("- [ ] T002", "- [x] T002"));
    await expect.poll(() => calls, { timeout: 2000 }).toBeGreaterThan(0);
    const afterFile = calls;
    source.notifyState(state({ phase: "converge" }));
    await expect.poll(() => calls, { timeout: 2000 }).toBeGreaterThan(afterFile);
    unsubscribe();
    const afterUnsubscribe = calls;
    source.notifyState(state());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(afterUnsubscribe);
  });
});
