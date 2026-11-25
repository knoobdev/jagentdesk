import type {
  SshSnippetRun,
  SshSnippetRunTarget,
  SshSnippetTargetState,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import type { SnippetRunEvent } from "./api";

/** Folds a live output/state event into a run snapshot; other runs pass through. */
export function applyRunEvent(run: SshSnippetRun, event: SnippetRunEvent): SshSnippetRun {
  if (event.runId !== run.runId) return run;
  if (event.type === "ssh.snippet.state") {
    const exists = run.targets.some((t) => t.serverId === event.target.serverId);
    const targets = exists
      ? run.targets.map((t) =>
          t.serverId === event.target.serverId ? { ...event.target, output: t.output } : t,
        )
      : [...run.targets, { ...event.target, output: [] }];
    return { ...run, targets, finishedAtMs: runFinishedAt(targets) };
  }
  return {
    ...run,
    targets: run.targets.map((target) => appendOutput(target, event)),
  };
}

function appendOutput(
  target: SshSnippetRunTarget,
  event: Extract<SnippetRunEvent, { type: "ssh.snippet.output" }>,
): SshSnippetRunTarget {
  if (target.serverId !== event.serverId) return target;
  const last = target.output.at(-1);
  if (last && last.stream === event.stream) {
    return {
      ...target,
      output: [
        ...target.output.slice(0, -1),
        { stream: last.stream, text: last.text + event.text },
      ],
    };
  }
  return { ...target, output: [...target.output, { stream: event.stream, text: event.text }] };
}

const FINISHED_STATES: ReadonlySet<SshSnippetTargetState> = new Set([
  "exited",
  "failed",
  "cancelled",
]);

export function isTargetFinished(target: { state: SshSnippetTargetState }): boolean {
  return FINISHED_STATES.has(target.state);
}

/** The latest target finish time once every target finished, else null. */
function runFinishedAt(targets: readonly SshSnippetRunTarget[]): number | null {
  if (!targets.every(isTargetFinished)) return null;
  const finishTimes = targets.map((t) => t.finishedAtMs ?? 0);
  return Math.max(...finishTimes);
}

export type TargetOutcome = "pending" | "success" | "failure" | "cancelled";

/** What a results pane shows as its status: exit 0 is success, anything else failure. */
export function targetOutcome(target: SshSnippetRunTarget): TargetOutcome {
  switch (target.state) {
    case "connecting":
    case "running":
      return "pending";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failure";
    case "exited":
      return target.exitCode === 0 ? "success" : "failure";
  }
}

export interface RunTally {
  success: number;
  failure: number;
  pending: number;
  cancelled: number;
}

export function tallyRun(run: SshSnippetRun): RunTally {
  const tally: RunTally = { success: 0, failure: 0, pending: 0, cancelled: 0 };
  for (const target of run.targets) tally[targetOutcome(target)] += 1;
  return tally;
}
