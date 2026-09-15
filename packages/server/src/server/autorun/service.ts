import { join } from "node:path";
import type { Logger } from "pino";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentUsage } from "../agent/agent-sdk-types.js";
import { AutorunStore } from "./store.js";
import {
  AutorunStateSchema,
  type AutorunState,
  type AutorunStopReason,
} from "@jagentdesk/protocol/messages";

// Autonomous mode driver (spec §20 / ADR-0017). Autonomous mode is a switch on an EXISTING
// agent's chat. While on, the daemon re-invokes the SAME agent/session turn-after-turn —
// keeping its open browser tab + conversation context — so it keeps working toward what the
// user asked, until it reports done / nothing new, or the user turns it off.
//
// The hard part is NOT the loop; it is NOT repeating work. Two things prevent that, exactly
// like the Grok-outreach story:
//   1. The agent acts on the CURRENT real state of the world (the open page / the repo), so
//      each turn it does the next NEW thing — it skips accounts it already messaged, answers
//      threads that got a reply, finds genuinely new targets.
//   2. A compact `doneItems` record — kept on disk, fed back every turn — so that even when
//      the agent's own context is compacted over hours, it never forgets what it already did.
// Neither is cron/schedule: it is one agent, one session, re-invoked back-to-back.

// Hidden safety caps so a run can never spin forever burning tokens. NOT exposed as a
// user-facing budget — the user only sees an on/off switch.
const MAX_ITERATIONS = 2000;
const MAX_WALL_CLOCK_MS = 12 * 60 * 60 * 1000;
const MAX_COST_USD = 50;
const MAX_NO_PROGRESS = 5; // turns that tried to work but produced no new done-items (stuck)
const MAX_CONSECUTIVE_FAILURES = 3;
const DONE_ITEMS_KEEP = 50; // cap the fed-back record so the prompt stays bounded
const BUSY_RECHECK_MS = 400; // while the user is mid-turn, wait rather than fight for the turn
// When the agent reports "nothing new to do RIGHT NOW" (e.g. it sent its messages and is
// waiting for replies, like the Grok outreach run), autonomous mode does NOT stop — it
// stays alive and re-checks for new work on a growing backoff, reacting when something new
// appears. This is what makes it run for hours instead of finishing in one batch. The idle
// watching is bounded by the wall-clock + cost safety caps above.
const IDLE_BACKOFF_BASE_MS = 30 * 1000;
const IDLE_BACKOFF_MAX_MS = 5 * 60 * 1000;

const AUTORUN_RESULT_MARKER = "AUTORUN_RESULT";

interface TurnResult {
  done: boolean;
  nothingNew: boolean;
  note: string | null;
  doneItems: string[];
}

type AutorunAgentManager = Pick<
  AgentManager,
  "cancelAgentRun" | "getAgent" | "hasInFlightRun" | "runAgent"
>;

export interface AutorunServiceOptions {
  jagentdeskHome: string;
  logger: Logger;
  agentManager: AutorunAgentManager;
  // Broadcast an `autorun.stream` event on every state change.
  onUpdate?: (state: AutorunState) => void;
  // Fired once when autonomous mode reaches a terminal (stopped) state (push, §14).
  onStopped?: (state: AutorunState) => void;
  now?: () => number;
  // Idle re-check backoff (overridable for tests). Defaults to 30s → 5m.
  idleBackoffBaseMs?: number;
  idleBackoffMaxMs?: number;
}

export class AutorunService {
  private readonly store: AutorunStore;
  private readonly logger: Logger;
  private readonly agentManager: AutorunAgentManager;
  private readonly onUpdate?: (state: AutorunState) => void;
  private readonly onStopped?: (state: AutorunState) => void;
  private readonly now: () => number;
  private readonly idleBackoffBaseMs: number;
  private readonly idleBackoffMaxMs: number;
  private readonly driving = new Set<string>();
  private readonly interrupts = new Set<string>();

  constructor(options: AutorunServiceOptions) {
    this.store = new AutorunStore(join(options.jagentdeskHome, "autoruns"));
    this.logger = options.logger.child({ module: "autorun-service" });
    this.agentManager = options.agentManager;
    this.onUpdate = options.onUpdate;
    this.onStopped = options.onStopped;
    this.now = options.now ?? (() => Date.now());
    this.idleBackoffBaseMs = options.idleBackoffBaseMs ?? IDLE_BACKOFF_BASE_MS;
    this.idleBackoffMaxMs = options.idleBackoffMaxMs ?? IDLE_BACKOFF_MAX_MS;
  }

  // On restart the driver loops are gone; mark any still-"running" agent stopped so the chat
  // toggle shows off. The doneItems record is intact, so re-toggling continues from there.
  async initialize(): Promise<void> {
    for (const state of await this.store.list()) {
      if (state.status === "running") {
        const stopped = await this.store.update(state.agentId, (s) => ({
          ...s,
          status: "stopped" as const,
          stopReason: null,
          stopDetail: "Daemon restarted — turn autonomous mode on again to continue.",
          updatedAt_ms: this.now(),
        }));
        if (stopped) this.emit(stopped);
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.driving].map(async (agentId) => {
        this.interrupts.add(agentId);
        await this.cancelIfInFlight(agentId);
      }),
    );
  }

  async list(): Promise<AutorunState[]> {
    return this.store.list();
  }

  async get(agentId: string): Promise<AutorunState | null> {
    return this.store.get(agentId);
  }

  // Turn autonomous mode ON for an agent the user is already chatting with.
  async start(agentId: string): Promise<AutorunState> {
    // The agent already exists with the model + mode the USER chose in the composer.
    // Autonomous only keeps it going — it never picks or changes the model or the mode.
    if (!this.agentManager.getAgent(agentId)) {
      throw new Error(`Agent ${agentId} is not active`);
    }
    const now = this.now();
    const existing = await this.store.get(agentId);
    const next: AutorunState = existing
      ? {
          ...existing,
          status: "running",
          startedAt_ms: now,
          updatedAt_ms: now,
          stopReason: null,
          stopDetail: null,
        }
      : {
          agentId,
          status: "running",
          iteration: 0,
          startedAt_ms: now,
          updatedAt_ms: now,
          lastActivityAt_ms: null,
          doneItems: [],
          lastNote: null,
          spendUsd: 0,
          stopReason: null,
          stopDetail: null,
        };
    const saved = await this.store.put(next);
    this.interrupts.delete(agentId);
    this.emit(saved);
    void this.drive(agentId).catch((error) => {
      this.logger.error({ err: error, agentId }, "Autorun driver loop crashed");
    });
    return saved;
  }

  // Turn autonomous mode OFF.
  async stopAgent(agentId: string): Promise<AutorunState> {
    this.interrupts.add(agentId);
    await this.cancelIfInFlight(agentId);
    const current = await this.store.get(agentId);
    if (!current) {
      // Never turned on: report a synthetic stopped state so the toggle is consistent.
      return AutorunStateSchema.parse({
        agentId,
        status: "stopped",
        iteration: 0,
        doneItems: [],
        spendUsd: 0,
        updatedAt_ms: this.now(),
        stopReason: "user",
      });
    }
    if (current.status === "stopped") return current;
    const stopped = await this.store.update(agentId, (s) => ({
      ...s,
      status: "stopped" as const,
      stopReason: "user" as const,
      stopDetail: "Turned off by you",
      updatedAt_ms: this.now(),
    }));
    if (!stopped) throw new Error(`Autorun state not found: ${agentId}`);
    this.emit(stopped);
    this.onStopped?.(stopped);
    return stopped;
  }

  private emit(state: AutorunState): void {
    this.onUpdate?.(state);
  }

  // Sleep for `ms` while an idle run waits for new work, but wake early (within ~1s) if the
  // user turns it off or it is stopped, so the off switch stays responsive during long waits.
  private async interruptibleWait(agentId: string, ms: number): Promise<void> {
    const deadline = this.now() + ms;
    while (this.now() < deadline) {
      if (this.interrupts.has(agentId)) return;
      const state = await this.store.get(agentId);
      if (!state || state.status !== "running") return;
      await sleep(Math.min(1000, deadline - this.now()));
    }
  }

  private async cancelIfInFlight(agentId: string): Promise<void> {
    if (this.agentManager.hasInFlightRun(agentId)) {
      await this.agentManager.cancelAgentRun(agentId).catch((error) => {
        this.logger.warn({ err: error, agentId }, "Failed to cancel autorun agent turn");
      });
    }
  }

  private async drive(agentId: string): Promise<void> {
    if (this.driving.has(agentId)) return;
    this.driving.add(agentId);
    try {
      let noProgress = 0;
      let nothingNewStreak = 0;
      let failures = 0;

      while (true) {
        const state = await this.store.get(agentId);
        if (!state || state.status !== "running") break;
        if (this.interrupts.has(agentId)) break;

        const cap = this.checkCaps(state);
        if (cap) {
          await this.finish(agentId, cap.reason, cap.detail);
          break;
        }

        // Never fight a turn the user started (their message is steering). Wait for it.
        if (this.agentManager.hasInFlightRun(agentId)) {
          await sleep(BUSY_RECHECK_MS);
          continue;
        }

        const prompt = this.buildPrompt(state);
        let result: TurnResult;
        let usage: AgentUsage | undefined;
        let canceled = false;
        try {
          const r = await this.agentManager.runAgent(agentId, prompt);
          usage = r.usage;
          canceled = r.canceled ?? false;
          result = parseTurnResult(r.finalText);
          failures = 0;
        } catch (error) {
          failures += 1;
          const detail = error instanceof Error ? error.message : String(error);
          await this.recordTurn(
            agentId,
            { done: false, nothingNew: false, note: `error: ${detail}`, doneItems: [] },
            usage,
          );
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            await this.finish(
              agentId,
              "error",
              `${failures} consecutive failures; last: ${detail}`,
            );
            break;
          }
          continue;
        }

        // Operator turned it off mid-turn: let stopAgent own the terminal state.
        if (canceled && this.interrupts.has(agentId)) break;

        await this.recordTurn(agentId, result, usage);

        // `done` is the ONLY thing that ends a run on its own: the goal is fully achieved.
        if (result.done) {
          await this.finish(agentId, "done", result.note ?? "Goal complete");
          break;
        }
        // `nothing_new` is NOT done — it means "no new work this moment" (e.g. waiting for
        // replies). Stay alive, back off, and re-check so the agent reacts to things that
        // appear over time. This is the difference between a 2-minute batch and a run that
        // keeps going for hours. Bounded by the wall-clock + cost caps (checkCaps).
        if (result.nothingNew) {
          nothingNewStreak += 1;
          const wait = Math.min(
            this.idleBackoffBaseMs * 2 ** (nothingNewStreak - 1),
            this.idleBackoffMaxMs,
          );
          await this.interruptibleWait(agentId, wait);
          continue;
        }
        nothingNewStreak = 0;
        if (result.doneItems.length === 0) {
          noProgress += 1;
          if (noProgress >= MAX_NO_PROGRESS) {
            await this.finish(agentId, "no-progress", `No new progress for ${noProgress} turns`);
            break;
          }
        } else {
          noProgress = 0;
        }
      }
    } finally {
      this.driving.delete(agentId);
    }
  }

  private checkCaps(state: AutorunState): { reason: AutorunStopReason; detail: string } | null {
    if (state.iteration >= MAX_ITERATIONS) {
      return { reason: "guard", detail: `Reached the safety cap of ${MAX_ITERATIONS} turns` };
    }
    if (state.spendUsd >= MAX_COST_USD) {
      return { reason: "guard", detail: `Reached the safety cost cap ($${MAX_COST_USD})` };
    }
    if (state.startedAt_ms != null && this.now() - state.startedAt_ms >= MAX_WALL_CLOCK_MS) {
      return { reason: "guard", detail: `Reached the ${MAX_WALL_CLOCK_MS / 3600000}h safety cap` };
    }
    return null;
  }

  private async recordTurn(
    agentId: string,
    result: TurnResult,
    usage: AgentUsage | undefined,
  ): Promise<void> {
    const now = this.now();
    const madeProgress = result.doneItems.length > 0;
    const updated = await this.store.update(agentId, (s) => ({
      ...s,
      iteration: s.iteration + 1,
      updatedAt_ms: now,
      lastActivityAt_ms: madeProgress ? now : s.lastActivityAt_ms,
      lastNote: result.note ?? s.lastNote,
      spendUsd: s.spendUsd + (usage?.totalCostUsd ?? 0),
      doneItems: mergeDoneItems(s.doneItems, result.doneItems),
    }));
    if (updated) this.emit(updated);
  }

  private async finish(agentId: string, reason: AutorunStopReason, detail: string): Promise<void> {
    const updated = await this.store.update(agentId, (s) => ({
      ...s,
      status: "stopped" as const,
      stopReason: reason,
      stopDetail: detail,
      updatedAt_ms: this.now(),
    }));
    if (updated) {
      this.emit(updated);
      this.onStopped?.(updated);
    }
  }

  private buildPrompt(state: AutorunState): string {
    const contract = [
      `When you finish this turn, end your final message with exactly one line:`,
      `${AUTORUN_RESULT_MARKER} {"done": <bool>, "nothing_new": <bool>, "note": <string>, "done_items": [<strings>]}`,
      `- done: true ONLY when the WHOLE goal is permanently complete — nothing more will ever be needed. This ends autonomous mode.`,
      `- nothing_new: true if there is nothing to do at THIS moment but the goal is still open (e.g. you are waiting for replies / new items to appear). This does NOT end the run — I will keep you alive and re-run you later so you can react to anything new. Prefer this over done whenever more could still happen.`,
      `- note: one short line summarizing this turn.`,
      `- done_items: each NEW, concrete thing you actually completed THIS turn (e.g. "messaged @acme", "replied to @foo", "wrote tests for parser") so you never repeat it.`,
    ].join("\n");

    const alreadyDone =
      state.doneItems.length > 0
        ? [
            ``,
            `You have ALREADY done the following — DO NOT do any of these again:`,
            ...state.doneItems.map((item) => `- ${item}`),
          ]
        : [];

    return [
      `Autonomous mode is ON. Keep working toward what I asked you above — do not stop and do not wait for me to reply.`,
      ...alreadyDone,
      ``,
      `Now: look at the CURRENT real state (open the page / re-check the files / read new replies) and do the single next NEW, useful step that is not already done. React to what has actually changed. Never redo completed work.`,
      ``,
      contract,
    ].join("\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeDoneItems(existing: string[], added: string[]): string[] {
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
  const merged = [...existing];
  for (const item of added) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  // Keep the most recent items so the fed-back prompt stays bounded.
  return merged.length > DONE_ITEMS_KEEP ? merged.slice(merged.length - DONE_ITEMS_KEEP) : merged;
}

function parseTurnResult(finalText: string): TurnResult {
  const fallback: TurnResult = { done: false, nothingNew: false, note: null, doneItems: [] };
  const index = finalText.lastIndexOf(AUTORUN_RESULT_MARKER);
  if (index < 0) return { ...fallback, note: "no result marker in turn output" };
  const rest = finalText.slice(index + AUTORUN_RESULT_MARKER.length).trim();
  const brace = rest.indexOf("{");
  if (brace < 0) return { ...fallback, note: "malformed result marker" };
  const jsonText = extractBalancedObject(rest.slice(brace));
  if (!jsonText) return { ...fallback, note: "malformed result marker" };
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const items = Array.isArray(parsed.done_items)
      ? parsed.done_items.filter((v): v is string => typeof v === "string")
      : [];
    return {
      done: parsed.done === true,
      nothingNew: parsed.nothing_new === true,
      note: typeof parsed.note === "string" ? parsed.note : null,
      doneItems: items,
    };
  } catch {
    return { ...fallback, note: "unparseable result marker" };
  }
}

// Read the first balanced {...} so trailing prose after the marker line is tolerated.
function extractBalancedObject(text: string): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  return null;
}
