import type { AgentProvider, AgentTimelineItem } from "../agent-sdk-types.js";
import { isDaemonBackgroundWorkItem, type AgentBackgroundWorkItem } from "./index.js";

/**
 * Claude's timeline already links a background start to its end (the Bash call with
 * `run_in_background` and its task notification), so it gets no synthesized rows.
 */
const PROVIDERS_WITH_OWN_BACKGROUND_ROWS: ReadonlySet<AgentProvider> = new Set(["claude"]);

/** `metadata.source` of the rows below; the app draws them as background rows (spec 38 §4.4b). */
export const BACKGROUND_WORK_TIMELINE_SOURCE = "background_work";

interface AnnouncedWork {
  label: string;
  kind: string;
  startedAtMs: number;
}

function labelOf(item: AgentBackgroundWorkItem): string {
  return item.command?.trim() || item.description?.trim() || item.kind;
}

function startedRow(id: string, work: AnnouncedWork): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: `background_work:${id}:${work.startedAtMs}:started`,
    name: "background_work",
    status: "completed",
    error: null,
    detail: {
      type: "plain_text",
      label: `Started in background · ${work.label}`,
      icon: "square_terminal",
    },
    metadata: {
      synthetic: true,
      source: BACKGROUND_WORK_TIMELINE_SOURCE,
      phase: "started",
      workId: id,
      kind: work.kind,
      label: work.label,
    },
  };
}

function finishedRow(id: string, work: AnnouncedWork, nowMs: number): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: `background_work:${id}:${work.startedAtMs}:finished`,
    name: "background_work",
    status: "completed",
    error: null,
    detail: {
      type: "plain_text",
      label: `Background task finished · ${work.label}`,
      icon: "square_terminal",
    },
    metadata: {
      synthetic: true,
      source: BACKGROUND_WORK_TIMELINE_SOURCE,
      phase: "finished",
      workId: id,
      kind: work.kind,
      label: work.label,
      durationMs: Math.max(0, nowMs - work.startedAtMs),
    },
  };
}

/**
 * Turns a provider's live background inventory into timeline rows for providers whose own
 * timeline does not show when background work starts and ends (Codex, OpenCode, …): one row
 * when an item first appears, one when a live update no longer lists it.
 *
 * What was announced survives an inventory reset (`items: null` on reconnect or restart of the
 * provider connection), so work that is listed again is not announced twice and work that ended
 * meanwhile still gets its finish row.
 */
export class BackgroundWorkTimeline {
  private readonly announced = new Map<string, Map<string, AnnouncedWork>>();

  /** Rows for the change from what was announced to `items`, the provider's current list. */
  update(input: {
    agentId: string;
    provider: AgentProvider;
    items: readonly AgentBackgroundWorkItem[];
    nowMs: number;
  }): AgentTimelineItem[] {
    if (PROVIDERS_WITH_OWN_BACKGROUND_ROWS.has(input.provider)) return [];
    const providerItems = input.items.filter((item) => !isDaemonBackgroundWorkItem(item));
    const announced = this.announced.get(input.agentId) ?? new Map<string, AnnouncedWork>();
    const rows: AgentTimelineItem[] = [];
    const live = new Set<string>();
    for (const item of providerItems) {
      live.add(item.id);
      if (announced.has(item.id)) continue;
      const startedAtMs = Date.parse(item.startedAt);
      const work: AnnouncedWork = {
        label: labelOf(item),
        kind: item.kind,
        startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : input.nowMs,
      };
      announced.set(item.id, work);
      rows.push(startedRow(item.id, work));
    }
    for (const [id, work] of announced) {
      if (live.has(id)) continue;
      announced.delete(id);
      rows.push(finishedRow(id, work, input.nowMs));
    }
    if (announced.size > 0) this.announced.set(input.agentId, announced);
    else this.announced.delete(input.agentId);
    return rows;
  }

  /** The agent closed or went away; its background work went with it. */
  forget(agentId: string): void {
    this.announced.delete(agentId);
  }
}
