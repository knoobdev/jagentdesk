import { stat } from "node:fs/promises";
import type { AgentBackgroundWorkSourcePayload } from "@jagentdesk/protocol/messages";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import {
  describeRedirect,
  findLastReads,
  planExtraSources,
  PROVIDER_SOURCE_ID,
  readScript,
  redirectOutputSource,
  SCRIPT_SOURCE_ID,
} from "./extra-sources.js";
import type { AgentBackgroundWorkDetail, BackgroundWorkOutputSource } from "./index.js";
import { isInsideOutputRoots } from "./output-stream.js";

export interface BackgroundWorkSourceContext {
  detail: AgentBackgroundWorkDetail;
  /** The agent's own folder; the work's folder when the provider reports none. */
  agentCwd: string | null;
  /** The agent's timeline, read only when the command has redirect files. */
  readTimeline: () => Promise<readonly AgentTimelineRow[] | null>;
}

/**
 * ADR-0064: every source of one item for its detail — the provider's own output, each redirect
 * file the command writes and may be read, and the script it runs — in that order.
 */
export async function describeBackgroundWorkSources(
  context: BackgroundWorkSourceContext,
): Promise<AgentBackgroundWorkSourcePayload[]> {
  const { detail, agentCwd } = context;
  const sources: AgentBackgroundWorkSourcePayload[] = [await describeProvider(detail.output)];
  const plan = planExtraSources({
    command: detail.item.command,
    workCwd: detail.cwd,
    agentCwd,
  });
  if (plan.redirects.length > 0) {
    const rows = await context.readTimeline().catch(() => null);
    const reads = rows
      ? findLastReads({
          rows,
          startedAt: detail.item.startedAt,
          redirects: plan.redirects,
          agentCwd: detail.cwd ?? agentCwd,
        })
      : new Map();
    for (const redirect of plan.redirects) {
      const state = await describeRedirect(redirect);
      // A file that exists but may not be read (symlink out, FIFO, device) gets no tab.
      if (!state) continue;
      // A file that never appeared for work that ended has nothing to show.
      if (!state.exists && detail.status !== "running") continue;
      const lastRead = reads.get(redirect.id);
      sources.push({
        id: redirect.id,
        kind: "redirect",
        label: redirect.label,
        path: redirect.path,
        available: state.exists,
        size: state.size,
        modifiedAt: state.modifiedAt,
        ...(lastRead ? { lastRead } : {}),
      });
    }
  }
  const script = plan.script ? await readScript(plan.script) : null;
  if (script) {
    sources.push({
      id: SCRIPT_SOURCE_ID,
      kind: "script",
      label: script.label,
      path: script.path,
      available: true,
      script: {
        content: script.content,
        truncated: script.truncated,
        lineCount: script.lineCount,
      },
    });
  }
  return sources;
}

async function describeProvider(
  output: BackgroundWorkOutputSource | null,
): Promise<AgentBackgroundWorkSourcePayload> {
  const base = { id: PROVIDER_SOURCE_ID, kind: "provider", label: "" };
  if (!output) return { ...base, available: false };
  if (output.type === "reader") {
    const size = await output
      .read({ cursor: 0, limit: 1 })
      .then((page) => page.size)
      .catch(() => null);
    return size === null ? { ...base, available: true } : { ...base, available: true, size };
  }
  const file = await output.locate().catch(() => null);
  if (!file || !(await isInsideOutputRoots(file))) return { ...base, available: false };
  const info = await stat(file.path).catch(() => null);
  return info
    ? { ...base, available: true, size: info.size, modifiedAt: info.mtime.toISOString() }
    : { ...base, available: false };
}

/** ADR-0062's `outputAvailable`: the provider's source can be read now. */
export async function isOutputSourceAvailable(
  output: BackgroundWorkOutputSource | null,
): Promise<boolean> {
  if (!output) return false;
  if (output.type === "reader") return true;
  return (await output.locate().catch(() => null)) !== null;
}

export class UnknownBackgroundWorkSourceError extends Error {
  constructor() {
    super("Unknown output source");
    this.name = "UnknownBackgroundWorkSourceError";
  }
}

/**
 * The output source a subscription follows. `sourceId` only picks among the sources re-derived
 * from the item itself; it never carries a path.
 */
export function resolveBackgroundWorkOutputSource(input: {
  detail: AgentBackgroundWorkDetail;
  agentCwd: string | null;
  sourceId: string | undefined;
  isRunning: () => boolean;
}): BackgroundWorkOutputSource | null {
  const { detail, sourceId } = input;
  if (sourceId === undefined || sourceId === PROVIDER_SOURCE_ID) return detail.output;
  const plan = planExtraSources({
    command: detail.item.command,
    workCwd: detail.cwd,
    agentCwd: input.agentCwd,
  });
  const redirect = plan.redirects.find((candidate) => candidate.id === sourceId);
  if (!redirect) throw new UnknownBackgroundWorkSourceError();
  return redirectOutputSource(redirect, input.isRunning);
}
