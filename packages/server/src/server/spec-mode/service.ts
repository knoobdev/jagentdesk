import path from "node:path";
import type { Logger } from "pino";
import {
  SPEC_MODE_PHASES,
  SpecModePhaseStatusMapSchema,
  type SpecModeErrorCode,
  type SpecModeOptionalPhase,
  type SpecModePhase,
  type SpecModePhaseStatusMap,
  type SpecModeSetupPreview,
  type SpecModeState,
} from "@jagentdesk/protocol/spec-mode";
import type { HostCapability, HostCapabilities } from "@jagentdesk/protocol/host-capabilities";
import type { AgentManagerEvent } from "../agent/agent-manager.js";
import { nextFeatureDirectory } from "./feature-name.js";
import {
  changedFiles,
  checkPhase,
  currentPhase,
  isConstitutionDone,
  isPhaseEnabled,
  snapshotArtefacts,
} from "./phases.js";
import {
  SpecModeSetupConflictError,
  planWorkspaceSetup,
  writeWorkspaceSetup,
  type WorkspaceSetupPlan,
} from "./setup.js";
import { commandInvocation } from "./speckit/layout.js";
import { renderPromptCommand } from "./speckit/render.js";
import { loadSpecKitSources } from "./speckit/vendor.js";
import { SpecModeStore, type SpecModeRecord } from "./store.js";

/**
 * Spec mode orchestration (spec 28, ADR-0030 decision 4). The daemon turns the user's first
 * message into the first unfinished phase's spec-kit command, judges "phase done" from files
 * after every `turn_completed`, and sends the next phase's command only when the user presses
 * Approve (or the current one again on Revise). It never starts a model turn by itself: every
 * call to `sendPrompt` comes from an Approve/Revise request.
 */

export class SpecModeRequestError extends Error {
  constructor(
    readonly code: SpecModeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SpecModeRequestError";
  }
}

/** The slice of AgentManager Spec mode uses. */
export interface SpecModeAgentManager {
  getAgent(agentId: string): { cwd: string; provider: string } | null;
  getBaseProviderId(provider: string): string;
  subscribe(
    callback: (event: AgentManagerEvent) => void,
    options?: { replayState?: boolean },
  ): () => void;
  hasInFlightRun(agentId: string): boolean;
  getLastAssistantMessage(agentId: string): Promise<string | null>;
  reloadAgentSession(agentId: string): Promise<unknown>;
}

export interface SpecModeHostCapabilities {
  snapshot(): HostCapabilities;
  refresh(): Promise<HostCapabilities>;
}

export interface SpecModeServiceOptions {
  jagentdeskHome: string;
  logger: Logger;
  agentManager: SpecModeAgentManager;
  hostCapabilities: SpecModeHostCapabilities;
  /** True while autonomous mode drives this agent (spec 28.4 step 6). */
  isAutorunActive: (agentId: string) => Promise<boolean>;
  /** Send a phase command as the user's next turn (Approve / Revise). */
  sendPrompt: (agentId: string, text: string) => Promise<void>;
  onState: (state: SpecModeState) => void;
  platform?: NodeJS.Platform;
  homeDir?: string;
  now?: () => number;
}

export interface UserMessagePhase {
  phase: SpecModePhase;
  text: string;
}

const SHARED_CHECKOUT_ENV = "SPECIFY_FEATURE_NO_PERSIST";

function freshStatus(
  optionalPhases: readonly SpecModeOptionalPhase[],
  constitutionDone: boolean,
): SpecModePhaseStatusMap {
  const entries = SPEC_MODE_PHASES.map((phase) => {
    if (phase === "constitution" && constitutionDone) return [phase, "skipped"] as const;
    return [phase, isPhaseEnabled(phase, optionalPhases) ? "pending" : "skipped"] as const;
  });
  return SpecModePhaseStatusMapSchema.parse(Object.fromEntries(entries));
}

/** Optional phases toggled mid-feature only change phases that have not started. */
function applyOptionalPhases(
  status: SpecModePhaseStatusMap,
  optionalPhases: readonly SpecModeOptionalPhase[],
): SpecModePhaseStatusMap {
  const next = { ...status };
  for (const phase of ["clarify", "checklist", "analyze"] as const) {
    const current = next[phase];
    if (current !== "pending" && current !== "skipped") continue;
    next[phase] = isPhaseEnabled(phase, optionalPhases) ? "pending" : "skipped";
  }
  return next;
}

function withPhase(
  state: SpecModeState,
  status: SpecModePhaseStatusMap,
  now: number,
): SpecModeState {
  return { ...state, phaseStatus: status, phase: currentPhase(status), updatedAt_ms: now };
}

function missingToolsOf(capability: HostCapability | undefined): string[] {
  if (!capability) return ["Could not check the host for spec-kit's script requirements"];
  return capability.state === "available" ? [] : [capability.reason];
}

export class SpecModeService {
  private readonly store: SpecModeStore;
  private readonly logger: Logger;
  private readonly agentManager: SpecModeAgentManager;
  private readonly options: SpecModeServiceOptions;
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly now: () => number;
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Per-agent spec-kit environment for agents that share a checkout. */
  private readonly sharedEnv = new Map<string, Record<string, string>>();
  private unsubscribe: (() => void) | null = null;

  constructor(options: SpecModeServiceOptions) {
    this.options = options;
    this.store = new SpecModeStore(path.join(options.jagentdeskHome, "spec-mode"));
    this.logger = options.logger.child({ module: "spec-mode" });
    this.agentManager = options.agentManager;
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? (process.env.HOME || process.env.USERPROFILE || "");
    this.now = options.now ?? (() => Date.now());
  }

  async initialize(): Promise<void> {
    for (const record of await this.store.list()) this.rememberEnv(record);
    this.unsubscribe = this.agentManager.subscribe((event) => this.handleAgentEvent(event), {
      replayState: false,
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Launch environment for the agent's provider process (AgentManager launch env provider). */
  launchEnv(agentId: string): Record<string, string> | null {
    return this.sharedEnv.get(agentId) ?? null;
  }

  async isEnabled(agentId: string): Promise<boolean> {
    return (await this.store.get(agentId))?.state.enabled ?? false;
  }

  async get(agentId: string): Promise<SpecModeState> {
    const record = await this.withLock(agentId, () => this.store.get(agentId));
    return record ? record.state : this.defaultState(agentId);
  }

  private defaultState(agentId: string): SpecModeState {
    return {
      agentId,
      enabled: false,
      optionalPhases: [],
      featureDirectory: null,
      phase: "constitution",
      phaseStatus: freshStatus([], false),
      converged: false,
      reviewFiles: [],
      sharedCheckout: false,
      updatedAt_ms: this.now(),
    };
  }

  async preview(agentId: string): Promise<Omit<SpecModeSetupPreview, "requestId" | "error">> {
    const plan = await this.planSetup(agentId);
    return { files: plan.files.map((file) => file.path), missingTools: await this.missingTools() };
  }

  async set(params: {
    agentId: string;
    enabled: boolean;
    optionalPhases?: SpecModeOptionalPhase[];
    confirmSetup?: boolean;
  }): Promise<SpecModeState> {
    return this.withLock(params.agentId, async () => {
      const agent = this.requireAgent(params.agentId);
      const existing = await this.store.get(params.agentId);
      if (!params.enabled) {
        if (!existing) return this.defaultState(params.agentId);
        return this.save({
          ...existing,
          state: { ...existing.state, enabled: false, updatedAt_ms: this.now() },
        });
      }
      if (await this.options.isAutorunActive(params.agentId)) {
        throw new SpecModeRequestError(
          "autorun_active",
          "Turn off autonomous mode to use Spec mode",
        );
      }
      const missing = await this.missingTools();
      if (missing.length > 0) throw new SpecModeRequestError("missing_tools", missing.join("; "));
      await this.ensureSetUp(params.agentId, params.confirmSetup === true);

      const optionalPhases =
        params.optionalPhases ??
        existing?.state.optionalPhases ??
        (await this.store.getWorkspaceOptionalPhases(agent.cwd)) ??
        [];
      if (params.optionalPhases) {
        await this.store.setWorkspaceOptionalPhases(agent.cwd, params.optionalPhases);
      }
      if (!existing || existing.state.converged) {
        return this.save(await this.newFeatureRecord(params.agentId, agent.cwd, optionalPhases));
      }
      const resumed = await this.resumeRunningPhase(existing);
      const status = applyOptionalPhases(resumed.state.phaseStatus, optionalPhases);
      if (status.constitution === "pending" && (await isConstitutionDone(agent.cwd))) {
        status.constitution = "skipped";
      }
      return this.save({
        ...resumed,
        state: withPhase({ ...resumed.state, enabled: true, optionalPhases }, status, this.now()),
      });
    });
  }

  /**
   * The phase command that replaces the user's message, or null to send it unchanged
   * (Spec mode off, or a phase is already running / awaiting review so the user is replying).
   */
  async prepareUserMessage(agentId: string, text: string): Promise<UserMessagePhase | null> {
    return this.withLock(agentId, async () => {
      let record = await this.store.get(agentId);
      if (!record?.state.enabled) return null;
      if (record.state.converged) {
        record = await this.newFeatureRecord(agentId, record.cwd, record.state.optionalPhases);
      }
      const phase = currentPhase(record.state.phaseStatus);
      if (!phase || record.state.phaseStatus[phase] !== "pending") return null;
      const started = await this.startPhase(record, phase, text);
      return { phase, text: started };
    });
  }

  /** The send that carried a phase command failed: the phase did not start. */
  async revertPhaseStart(agentId: string, phase: SpecModePhase): Promise<void> {
    await this.withLock(agentId, async () => {
      const record = await this.store.get(agentId);
      if (!record || record.state.phaseStatus[phase] !== "running") return;
      const status = { ...record.state.phaseStatus, [phase]: "pending" as const };
      await this.save({ ...record, state: withPhase(record.state, status, this.now()) });
    });
  }

  async review(params: {
    agentId: string;
    decision: "approve" | "revise";
    note?: string;
  }): Promise<SpecModeState> {
    const { record, phase, text } = await this.withLock(params.agentId, async () => {
      const current = await this.store.get(params.agentId);
      const reviewed = current ? currentPhase(current.state.phaseStatus) : null;
      if (
        !current?.state.enabled ||
        !reviewed ||
        current.state.phaseStatus[reviewed] !== "awaiting_review"
      ) {
        throw new SpecModeRequestError("not_awaiting_review", "No phase is waiting for review");
      }
      if (this.agentManager.hasInFlightRun(params.agentId)) {
        throw new SpecModeRequestError("agent_busy", "Wait for the agent to finish its turn");
      }
      if (params.decision === "revise") {
        const revised = await this.startPhase(current, reviewed, params.note?.trim() ?? "");
        return { record: current, phase: reviewed, text: revised };
      }
      const status = { ...current.state.phaseStatus };
      if (reviewed === "converge") {
        // Converge appended tasks: implement them, then converge again (spec 28.2).
        status.implement = "pending";
        status.converge = "pending";
      } else {
        status[reviewed] = "done";
      }
      const approved: SpecModeRecord = {
        ...current,
        state: withPhase({ ...current.state, reviewFiles: [] }, status, this.now()),
      };
      const next = currentPhase(status);
      if (!next) {
        await this.save(approved);
        return { record: current, phase: null, text: null };
      }
      const args = next === "specify" ? (approved.request ?? "") : "";
      return { record: current, phase: next, text: await this.startPhase(approved, next, args) };
    });
    if (phase && text) {
      try {
        await this.options.sendPrompt(params.agentId, text);
      } catch (error) {
        await this.restore(record);
        throw error;
      }
    }
    return (await this.store.get(params.agentId))?.state ?? record.state;
  }

  private async restore(record: SpecModeRecord): Promise<void> {
    await this.withLock(record.state.agentId, () =>
      this.save({ ...record, state: { ...record.state, updatedAt_ms: this.now() } }),
    );
  }

  private handleAgentEvent(event: AgentManagerEvent): void {
    if (event.type !== "agent_stream" || event.event.type !== "turn_completed") return;
    const agentId = event.agentId;
    void this.withLock(agentId, () => this.evaluateTurn(agentId)).catch((error) => {
      this.logger.error({ err: error, agentId }, "Spec mode phase check failed");
    });
  }

  private async evaluateTurn(agentId: string): Promise<void> {
    const record = await this.store.get(agentId);
    if (!record?.state.enabled) return;
    const phase = currentPhase(record.state.phaseStatus);
    if (!phase || record.state.phaseStatus[phase] !== "running") return;
    const next = await this.judgePhase(record, phase);
    if (next !== record) await this.save(next);
  }

  /** Apply the done check to a running phase; returns the same record when it is not done. */
  private async judgePhase(record: SpecModeRecord, phase: SpecModePhase): Promise<SpecModeRecord> {
    const outcome = await checkPhase({
      phase,
      cwd: record.cwd,
      featureDirectory: record.state.featureDirectory,
      sharedCheckout: record.state.sharedCheckout,
      before: record.before,
      lastAssistantMessage: await this.agentManager.getLastAssistantMessage(record.state.agentId),
    });
    const now = this.now();
    if (outcome.kind === "not_done") return record;
    if (outcome.kind === "converged") {
      const status = { ...record.state.phaseStatus };
      for (const name of SPEC_MODE_PHASES) {
        if (status[name] !== "skipped") status[name] = "done";
      }
      return {
        ...record,
        state: withPhase({ ...record.state, converged: true, reviewFiles: [] }, status, now),
      };
    }
    const featureDirectory =
      outcome.kind === "done"
        ? (outcome.featureDirectory ?? record.state.featureDirectory)
        : record.state.featureDirectory;
    const after = await snapshotArtefacts(record.cwd, record.beforeScope);
    const status = { ...record.state.phaseStatus, [phase]: "awaiting_review" as const };
    return {
      ...record,
      state: withPhase(
        { ...record.state, featureDirectory, reviewFiles: changedFiles(record.before, after) },
        status,
        now,
      ),
    };
  }

  /** Re-enabling continues from the first unfinished phase (spec 28.4 step 5). */
  private async resumeRunningPhase(record: SpecModeRecord): Promise<SpecModeRecord> {
    const phase = currentPhase(record.state.phaseStatus);
    if (!phase || record.state.phaseStatus[phase] !== "running") return record;
    if (this.agentManager.hasInFlightRun(record.state.agentId)) return record;
    const judged = await this.judgePhase(record, phase);
    if (judged !== record) return judged;
    const status = { ...record.state.phaseStatus, [phase]: "pending" as const };
    return { ...record, state: withPhase(record.state, status, this.now()) };
  }

  private async newFeatureRecord(
    agentId: string,
    cwd: string,
    optionalPhases: SpecModeOptionalPhase[],
  ): Promise<SpecModeRecord> {
    const status = freshStatus(optionalPhases, await isConstitutionDone(cwd));
    this.sharedEnv.delete(agentId);
    return {
      state: {
        agentId,
        enabled: true,
        optionalPhases,
        featureDirectory: null,
        phase: currentPhase(status),
        phaseStatus: status,
        converged: false,
        reviewFiles: [],
        sharedCheckout: false,
        updatedAt_ms: this.now(),
      },
      cwd,
      request: null,
      before: {},
      beforeScope: null,
    };
  }

  /** Mark `phase` running, snapshot its artefacts and build the command to send. */
  private async startPhase(
    record: SpecModeRecord,
    phase: SpecModePhase,
    args: string,
  ): Promise<string> {
    const agentId = record.state.agentId;
    let next: SpecModeRecord = {
      ...record,
      request: record.request ?? (phase === "specify" || phase === "constitution" ? args : null),
    };
    if (phase === "specify" && !next.state.featureDirectory) {
      next = await this.prepareFeatureDirectory(next, args);
    }
    const scope = next.state.featureDirectory;
    const status = { ...next.state.phaseStatus, [phase]: "running" as const };
    next = {
      ...next,
      before: await snapshotArtefacts(next.cwd, scope),
      beforeScope: scope,
      state: withPhase({ ...next.state, reviewFiles: [] }, status, this.now()),
    };
    await this.save(next);
    return this.buildCommand(agentId, next, phase, args);
  }

  /**
   * Another Spec mode agent works in the same checkout: give this one its own feature
   * directory and run its scripts with SPECIFY_FEATURE_NO_PERSIST, so neither writes
   * `.specify/feature.json` (spec 28.3 step 5). The provider process is reloaded to pick up
   * the environment.
   */
  private async prepareFeatureDirectory(
    record: SpecModeRecord,
    description: string,
  ): Promise<SpecModeRecord> {
    const others = (await this.store.list()).filter(
      (other) =>
        other.state.agentId !== record.state.agentId &&
        other.state.enabled &&
        this.agentManager.getAgent(other.state.agentId) !== null &&
        path.resolve(other.cwd) === path.resolve(record.cwd),
    );
    if (others.length === 0) return record;
    const featureDirectory = await nextFeatureDirectory({
      cwd: record.cwd,
      description,
      reserved: others.flatMap((other) =>
        other.state.featureDirectory ? [other.state.featureDirectory] : [],
      ),
    });
    const next: SpecModeRecord = {
      ...record,
      state: { ...record.state, featureDirectory, sharedCheckout: true },
    };
    this.rememberEnv(next);
    await this.agentManager.reloadAgentSession(record.state.agentId);
    return next;
  }

  private rememberEnv(record: SpecModeRecord): void {
    const { agentId, sharedCheckout, featureDirectory } = record.state;
    if (sharedCheckout && featureDirectory) {
      this.sharedEnv.set(agentId, {
        [SHARED_CHECKOUT_ENV]: "1",
        SPECIFY_FEATURE_DIRECTORY: featureDirectory,
      });
    } else {
      this.sharedEnv.delete(agentId);
    }
  }

  private async buildCommand(
    agentId: string,
    record: SpecModeRecord,
    phase: SpecModePhase,
    args: string,
  ): Promise<string> {
    const plan = await this.planSetup(agentId);
    const sharedNote =
      record.state.sharedCheckout && record.state.featureDirectory
        ? `Spec mode: another agent works in this checkout. Use the feature directory \`${record.state.featureDirectory}\` (SPECIFY_FEATURE_DIRECTORY is set for you) and do not write .specify/feature.json.`
        : null;
    const argument = [args.trim(), sharedNote]
      .filter((part): part is string => Boolean(part))
      .join("\n\n");
    if (plan.integration.kind === "prompt") {
      const sources = await loadSpecKitSources();
      return renderPromptCommand({
        command: phase,
        raw: sources.commands[phase],
        script: plan.script,
        args: argument,
      });
    }
    const invocation = commandInvocation(plan.integration, phase);
    return argument ? `${invocation} ${argument}` : invocation;
  }

  private requireAgent(agentId: string): { cwd: string; provider: string } {
    const agent = this.agentManager.getAgent(agentId);
    if (!agent) throw new SpecModeRequestError("agent_not_found", `Agent ${agentId} is not active`);
    return { cwd: agent.cwd, provider: this.agentManager.getBaseProviderId(agent.provider) };
  }

  private async planSetup(agentId: string): Promise<WorkspaceSetupPlan> {
    const agent = this.requireAgent(agentId);
    return planWorkspaceSetup({
      cwd: agent.cwd,
      baseProvider: agent.provider,
      platform: this.platform,
      homeDir: this.homeDir,
      now: this.now(),
    });
  }

  private async ensureSetUp(agentId: string, confirmed: boolean): Promise<void> {
    const plan = await this.planSetup(agentId);
    if (plan.files.length === 0) return;
    if (!confirmed) {
      throw new SpecModeRequestError(
        "setup_required",
        `Spec mode needs to create ${plan.files.length} files in this workspace`,
      );
    }
    try {
      await writeWorkspaceSetup(this.requireAgent(agentId).cwd, plan);
    } catch (error) {
      if (error instanceof SpecModeSetupConflictError) {
        throw new SpecModeRequestError("setup_conflict", error.message);
      }
      throw error;
    }
  }

  private async missingTools(): Promise<string[]> {
    const snapshot = this.options.hostCapabilities.snapshot();
    const capability = snapshot.specKit ?? (await this.options.hostCapabilities.refresh()).specKit;
    return missingToolsOf(capability);
  }

  private async save(record: SpecModeRecord): Promise<SpecModeState> {
    const saved = await this.store.put(record);
    this.rememberEnv(saved);
    this.options.onState(saved.state);
    return saved.state;
  }

  /** Serialize every read-modify-write of one agent's state. */
  private withLock<T>(agentId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(agentId) ?? Promise.resolve();
    const run = prior.then(task, task);
    this.locks.set(
      agentId,
      run.catch(() => undefined),
    );
    return run;
  }
}
