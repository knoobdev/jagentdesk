// Spec mode seam for the Plan view (spec 31.1, story S-26 milestone 4).
//
// Spec mode (spec 28) is built separately. When it is on for an agent, the Plan view shows the
// phases and tasks of the agent's spec-kit `tasks.md` instead of the agent's todos. This file owns
// the contract the Plan builder needs and the deterministic tasks.md parser; the Spec mode service
// provides a SpecPlanSource that knows where the agent's tasks.md lives and when it changes.
//
// Until that service exists the daemon wires NO_SPEC_PLAN_SOURCE, and the Plan view falls back to
// todos. Wiring: pass a SpecPlanSource to ActivityGraphService (option `specPlanSource`); call the
// `onChange` callback it was subscribed with whenever tasks.md or the phase state changes, so the
// service re-renders the Plan view (subject to the same 1 500 ms throttle).

export type SpecPlanStatus = "done" | "running" | "pending";

export interface SpecPlanTask {
  // Task id from tasks.md (T001) or a line-derived id when the line has none.
  id: string;
  text: string;
  done: boolean;
  // `[P]`: may run in parallel with the other [P] tasks of its phase.
  parallel: boolean;
  // `[US1]`-style story label, when present.
  story?: string;
}

export interface SpecPlanPhase {
  id: string;
  title: string;
  status: SpecPlanStatus;
  tasks: SpecPlanTask[];
}

export interface SpecPlan {
  title: string;
  phases: SpecPlanPhase[];
}

export interface SpecPlanSource {
  // The agent's Spec mode plan, or null when Spec mode is off for it.
  getPlan(agentId: string): Promise<SpecPlan | null>;
  // Notify when the plan of `agentId` may have changed. Returns an unsubscribe function.
  subscribe(agentId: string, onChange: () => void): () => void;
}

export const NO_SPEC_PLAN_SOURCE: SpecPlanSource = {
  getPlan: async () => null,
  subscribe: () => () => undefined,
};

const PHASE_HEADING = /^##\s+(Phase\s+\d+[^\n]*)$/i;
const TASK_LINE = /^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/;
const TASK_ID = /^(T\d+)\b\s*/;
const PARALLEL_MARK = /\[P\]\s*/;
const STORY_MARK = /\[(US\d+)\]\s*/;

function phaseStatus(tasks: readonly SpecPlanTask[]): SpecPlanStatus {
  if (tasks.length > 0 && tasks.every((task) => task.done)) return "done";
  if (tasks.some((task) => task.done)) return "running";
  return "pending";
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

// spec-kit tasks.md: `## Phase N: Title` headings group `- [ ] T001 [P] [US1] Description` lines.
// Task lines before the first phase heading go into an implicit "Tasks" phase.
export function parseSpecKitTasks(markdown: string, title = "Tasks"): SpecPlan {
  const phases: SpecPlanPhase[] = [];
  let current: SpecPlanPhase | null = null;
  let lineNumber = 0;
  for (const rawLine of markdown.split(/\r?\n/)) {
    lineNumber += 1;
    const heading = PHASE_HEADING.exec(rawLine.trim());
    if (heading) {
      const phaseTitle = heading[1]!.trim();
      const number = /Phase\s+(\d+)/i.exec(phaseTitle)?.[1];
      current = {
        id: number ? `phase-${number}` : `phase-${slug(phaseTitle)}`,
        title: phaseTitle,
        status: "pending",
        tasks: [],
      };
      phases.push(current);
      continue;
    }
    const task = TASK_LINE.exec(rawLine);
    if (!task) continue;
    if (!current) {
      current = { id: "phase-tasks", title: "Tasks", status: "pending", tasks: [] };
      phases.push(current);
    }
    let text = task[2]!.trim();
    const idMatch = TASK_ID.exec(text);
    const id = idMatch ? idMatch[1]! : `line-${lineNumber}`;
    if (idMatch) text = text.slice(idMatch[0].length);
    const parallel = PARALLEL_MARK.test(text);
    text = text.replace(PARALLEL_MARK, "");
    const story = STORY_MARK.exec(text)?.[1];
    text = text.replace(STORY_MARK, "").trim();
    current.tasks.push({
      id,
      text,
      done: task[1] !== " ",
      parallel,
      ...(story ? { story } : {}),
    });
  }
  for (const phase of phases) phase.status = phaseStatus(phase.tasks);
  return { title, phases };
}
