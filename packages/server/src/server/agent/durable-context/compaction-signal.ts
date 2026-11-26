import type { AgentTimelineItem, AgentUsage } from "../agent-sdk-types.js";

/**
 * Providers that report their own compactions (spec 42 §1): Claude `compact_boundary`, Codex
 * `contextCompaction`, OpenCode summary messages, Oh My Pi `compaction_*`. Every other provider —
 * Pi, Copilot, Cursor, Kimi, Kiro, custom API providers, generic ACP — gets the inferred signal.
 * An explicit compaction row from any provider still counts.
 */
export const EXPLICIT_COMPACTION_PROVIDERS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "omp",
]);

/** Inferred compaction: context use falls by at least this share between two usage reports. */
export const INFERRED_DROP_SHARE = 0.4;
/** Ignore drops smaller than this; a few hundred tokens of noise is not a compaction. */
export const INFERRED_MIN_DROP_TOKENS = 2_000;
/** An explicit and an inferred signal this close together are the same compaction. */
export const SAME_COMPACTION_WINDOW_MS = 120_000;

export interface DetectedCompaction {
  provider: string;
  trigger: "auto" | "manual" | null;
  preTokens: number | null;
  postTokens: number | null;
  inferred: boolean;
  /** True when this explicit signal confirms an inferred compaction already recorded. */
  confirmsPrevious: boolean;
}

export interface UsageObservation {
  /** A compaction read off the usage drop (inferred providers only). */
  detected: DetectedCompaction | null;
  /** Context size after a compaction an explicit signal reported earlier. */
  postTokens: number | null;
}

interface AgentSignalState {
  sessionId: string | null;
  lastUsedTokens: number | null;
  /** An explicit compaction is waiting for the next usage report to learn its size after. */
  awaitingPostTokens: boolean;
  lastExplicitAt: number | null;
  lastInferredAt: number | null;
}

function usedTokens(usage: AgentUsage): number | null {
  const used = usage.contextWindowUsedTokens;
  return typeof used === "number" && Number.isFinite(used) && used >= 0 ? used : null;
}

/**
 * Detects compactions per agent from the provider's own compaction rows and from context usage.
 * Pure state machine; the daemon feeds it live events only (never history replays).
 */
export class CompactionSignalTracker {
  private readonly states = new Map<string, AgentSignalState>();

  constructor(private readonly now: () => number = Date.now) {}

  private state(agentId: string, sessionId: string | null): AgentSignalState {
    let state = this.states.get(agentId);
    if (!state) {
      state = {
        sessionId,
        lastUsedTokens: null,
        awaitingPostTokens: false,
        lastExplicitAt: null,
        lastInferredAt: null,
      };
      this.states.set(agentId, state);
    } else if (sessionId && state.sessionId && state.sessionId !== sessionId) {
      // A new native session (`/clear`, rollover, provider switch) starts small: not a compaction.
      this.reset(agentId);
      return this.state(agentId, sessionId);
    } else if (sessionId && !state.sessionId) {
      state.sessionId = sessionId;
    }
    return state;
  }

  observeTimelineItem(input: {
    agentId: string;
    provider: string;
    sessionId: string | null;
    item: AgentTimelineItem;
  }): DetectedCompaction | null {
    const { item } = input;
    if (item.type !== "compaction" || item.status !== "completed") return null;
    const state = this.state(input.agentId, input.sessionId);
    const now = this.now();
    const confirmsPrevious =
      state.lastInferredAt !== null && now - state.lastInferredAt <= SAME_COMPACTION_WINDOW_MS;
    state.lastExplicitAt = now;
    state.lastInferredAt = null;
    state.awaitingPostTokens = !confirmsPrevious;
    const preTokens =
      typeof item.preTokens === "number" ? item.preTokens : (state.lastUsedTokens ?? null);
    let trigger: DetectedCompaction["trigger"] = null;
    if (item.trigger === "manual" || item.trigger === "auto") trigger = item.trigger;
    return {
      provider: input.provider,
      trigger,
      preTokens,
      postTokens: null,
      inferred: false,
      confirmsPrevious,
    };
  }

  observeUsage(input: {
    agentId: string;
    provider: string;
    sessionId: string | null;
    usage: AgentUsage;
  }): UsageObservation {
    const used = usedTokens(input.usage);
    if (used === null) return { detected: null, postTokens: null };
    const state = this.state(input.agentId, input.sessionId);
    const previous = state.lastUsedTokens;
    state.lastUsedTokens = used;
    if (state.awaitingPostTokens) {
      state.awaitingPostTokens = false;
      return { detected: null, postTokens: used };
    }
    if (previous === null || EXPLICIT_COMPACTION_PROVIDERS.has(input.provider)) {
      return { detected: null, postTokens: null };
    }
    const drop = previous - used;
    if (drop < INFERRED_MIN_DROP_TOKENS || used > previous * (1 - INFERRED_DROP_SHARE)) {
      return { detected: null, postTokens: null };
    }
    const now = this.now();
    if (state.lastExplicitAt !== null && now - state.lastExplicitAt <= SAME_COMPACTION_WINDOW_MS) {
      return { detected: null, postTokens: null };
    }
    state.lastInferredAt = now;
    return {
      detected: {
        provider: input.provider,
        trigger: null,
        preTokens: previous,
        postTokens: used,
        inferred: true,
        confirmsPrevious: false,
      },
      postTokens: null,
    };
  }

  /** A fresh native session: forget the baseline so its small context is not read as a drop. */
  reset(agentId: string): void {
    this.states.delete(agentId);
  }
}
