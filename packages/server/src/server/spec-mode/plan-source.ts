import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import {
  SPEC_MODE_PHASES,
  specModePhaseLabel,
  type SpecModePhaseStatus,
  type SpecModeState,
} from "@jagentdesk/protocol/spec-mode";
import {
  parseSpecKitTasks,
  type SpecPlan,
  type SpecPlanSource,
  type SpecPlanStatus,
} from "../agent/activity-graph/spec-plan-source.js";

/** What the plan source reads from the daemon (kept narrow for tests). */
export interface SpecModePlanSourceOptions {
  /** The Spec mode service once it has started; null before that or on hosts without it. */
  getState: (agentId: string) => Promise<SpecModeState | null>;
  /** The agent's working directory (where `specs/<feature>/tasks.md` lives). */
  agentCwd: (agentId: string) => string | null;
  logger: Logger;
  /** Coalesces bursts of file events into one change (ms). */
  debounceMs?: number;
}

const PHASE_STATUS: Record<SpecModePhaseStatus, SpecPlanStatus | null> = {
  pending: "pending",
  running: "running",
  awaiting_review: "running",
  done: "done",
  skipped: null,
};

function featureTitle(featureDirectory: string): string {
  return path.basename(featureDirectory);
}

/**
 * Before tasks.md exists, the plan is the Spec mode workflow itself: one node per enabled phase
 * with its status (spec 31.2 "các pha Spec mode chưa xong").
 */
export function planFromPhases(state: SpecModeState): SpecPlan {
  const phases = SPEC_MODE_PHASES.flatMap((phase) => {
    const status = PHASE_STATUS[state.phaseStatus[phase]];
    return status
      ? [{ id: `spec-${phase}`, title: specModePhaseLabel(phase), status, tasks: [] }]
      : [];
  });
  return {
    title: state.featureDirectory ? featureTitle(state.featureDirectory) : "Spec mode",
    phases,
  };
}

interface Watch {
  listeners: Set<() => void>;
  watcher: FSWatcher | null;
  watchedDir: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Spec 31.1 Plan view with Spec mode on: phases and tasks of the agent's spec-kit tasks.md
 * (`## Phase N` groups, `[P]` parallel). Reads files only — no model call (spec 31.2).
 * Changes come from two places: Spec mode state (phase finished, feature directory created) via
 * notifyState(), and edits to tasks.md seen by a directory watch held only while someone views
 * the Plan of that agent.
 */
export class SpecModePlanSource implements SpecPlanSource {
  private readonly options: SpecModePlanSourceOptions;
  private readonly watches = new Map<string, Watch>();

  constructor(options: SpecModePlanSourceOptions) {
    this.options = options;
  }

  async getPlan(agentId: string): Promise<SpecPlan | null> {
    const state = await this.options.getState(agentId);
    if (!state?.enabled) return null;
    const tasksPath = this.tasksPath(agentId, state);
    if (tasksPath) {
      const markdown = await readFile(tasksPath, "utf8").catch(() => null);
      if (markdown !== null) {
        const plan = parseSpecKitTasks(markdown, featureTitle(state.featureDirectory!));
        if (plan.phases.length > 0) return plan;
      }
    }
    return planFromPhases(state);
  }

  subscribe(agentId: string, onChange: () => void): () => void {
    let entry = this.watches.get(agentId);
    if (!entry) {
      entry = { listeners: new Set(), watcher: null, watchedDir: null, timer: null };
      this.watches.set(agentId, entry);
      void this.refreshWatch(agentId);
    }
    entry.listeners.add(onChange);
    return () => {
      const current = this.watches.get(agentId);
      if (!current) return;
      current.listeners.delete(onChange);
      if (current.listeners.size > 0) return;
      this.closeWatch(current);
      this.watches.delete(agentId);
    };
  }

  /** Called with every Spec mode state change (the same moment clients get agent.spec_mode.state). */
  notifyState(state: SpecModeState): void {
    const entry = this.watches.get(state.agentId);
    if (!entry) return;
    void this.refreshWatch(state.agentId, state);
    this.fire(entry);
  }

  dispose(): void {
    for (const entry of this.watches.values()) this.closeWatch(entry);
    this.watches.clear();
  }

  private tasksPath(agentId: string, state: SpecModeState): string | null {
    const cwd = this.options.agentCwd(agentId);
    if (!cwd || !state.featureDirectory) return null;
    return path.join(cwd, ...state.featureDirectory.split("/"), "tasks.md");
  }

  private async refreshWatch(agentId: string, known?: SpecModeState): Promise<void> {
    const state = known ?? (await this.options.getState(agentId).catch(() => null));
    const entry = this.watches.get(agentId);
    if (!entry) return;
    const tasksPath = state?.enabled ? this.tasksPath(agentId, state) : null;
    const dir = tasksPath ? path.dirname(tasksPath) : null;
    if (dir === entry.watchedDir) return;
    entry.watcher?.close();
    entry.watcher = null;
    entry.watchedDir = dir;
    if (!dir) return;
    try {
      entry.watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === null || String(filename) === "tasks.md") this.fire(entry);
      });
      entry.watcher.on("error", () => {
        entry.watcher?.close();
        entry.watcher = null;
        entry.watchedDir = null;
      });
    } catch (error) {
      // The feature directory may not exist yet; the next state change retries.
      entry.watchedDir = null;
      this.options.logger.debug({ err: error, agentId }, "spec plan watch unavailable");
    }
  }

  private fire(entry: Watch): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      for (const listener of entry.listeners) listener();
    }, this.options.debounceMs ?? 250);
  }

  private closeWatch(entry: Watch): void {
    entry.watcher?.close();
    entry.watcher = null;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }
}
