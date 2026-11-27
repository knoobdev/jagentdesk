import type { TFunction } from "i18next";
import { isAgentRunning } from "@jagentdesk/protocol/agent-state-bucket";
import type { AgentBackgroundWorkSummary } from "@jagentdesk/protocol/messages";
import type { ComposerTrackPillSegment } from "@/composer/tracks";
import { STATUS_BUCKET_ORDER } from "@/hooks/sidebar-status-view-model";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import type { SubagentRow } from "./select";
import { providerSubagentLifecycleStatus } from "./provider-store";

function presentationStatus(row: SubagentRow) {
  if (row.kind === "jagentdesk") return row.status;
  return providerSubagentLifecycleStatus(row.status);
}

/**
 * A child's mark reports what it is doing, not whether anyone read it: the track is where a
 * failed child stays visible after the parent's own attention is cleared.
 */
export function deriveSubagentStatusBucket(
  status: ReturnType<typeof presentationStatus>,
  backgroundWork?: AgentBackgroundWorkSummary | null,
): SidebarStateBucket {
  if (status === "error") return "failed";
  if (isAgentRunning({ status, backgroundWork })) return "running";
  return "done";
}

export interface SubagentRowPresentationData {
  key: string;
  kind: "agent";
  label: string;
  subtitle: string;
  titleState: "ready" | "loading";
  statusBucket: SidebarStateBucket | null;
}

export function buildSubagentRowPresentationData(row: SubagentRow): SubagentRowPresentationData {
  // The task distinguishes siblings in a fan-out, so it names the row when present. Providers
  // own the compact secondary context because model, effort, and usage semantics differ.
  const description = resolveRowLabel(row.description);
  const title = resolveRowLabel(row.title);
  const label = description ?? title;
  const providerSubtitle = row.kind === "provider" ? resolveRowLabel(row.subtitle) : null;
  const subtitle = providerSubtitle ?? (description ? title : null);
  const status = presentationStatus(row);
  return {
    key: `${row.kind}_subagent_${row.id}`,
    kind: "agent",
    label: label ?? "",
    subtitle: subtitle ?? "",
    titleState: label ? "ready" : "loading",
    statusBucket: deriveSubagentStatusBucket(
      status,
      row.kind === "jagentdesk" ? row.backgroundWork : undefined,
    ),
  };
}

type ActiveStatusBucket = Exclude<SidebarStateBucket, "done">;

/** The sidebar's list order, minus the state that earns no mark. */
const ACTIVE_STATUS_BUCKET_ORDER = STATUS_BUCKET_ORDER.filter(
  (bucket): bucket is ActiveStatusBucket => bucket !== "done",
);

/** One state the pill reports, and how many children are in it. */
interface SubagentStatusCount {
  bucket: ActiveStatusBucket;
  count: number;
}

/** Everything the pill draws. Built together so no mark can end up next to another one's count. */
export interface SubagentPillPresentation {
  segments: ComposerTrackPillSegment[];
  accessibilityLabel: string;
}

/**
 * What the pill says about a fan-out, and which marks it says it with.
 *
 * A mark and a number sitting together answer the same question, so the pill cannot collapse a
 * mixed fan-out into the most urgent state the way a sidebar project row does: a red dot beside
 * "1 failed" over a child that is still working says the fan-out has stopped. Every state present
 * gets its own mark and its own count, in the order the sidebar's status groups list them.
 *
 * It stays one line because subagent rows only ever reach three states — see
 * `buildSubagentRowPresentationData`, which reports no attention of its own — so the pill is two
 * segments at worst, and falls back to naming what it opens once nothing is happening.
 */
export function buildSubagentPillPresentation(
  t: TFunction,
  rows: readonly SubagentRow[],
): SubagentPillPresentation {
  const counts = summarizeSubagentStatus(rows);
  if (counts.length === 0) {
    const label = totalLabel(t, rows.length);
    return { segments: [{ bucket: null, text: label }], accessibilityLabel: label };
  }
  const labels = counts.map(({ bucket, count }) => statusLabel(t, bucket, count));
  return {
    segments: counts.map(({ bucket }, index) => ({ bucket, text: labels[index] ?? "" })),
    // Marks separate the segments on screen; a screen reader needs the pause spelled out.
    accessibilityLabel: labels.join(", "),
  };
}

/** Wording comes from the sidebar's status groups — one name per state across the whole app. */
function statusLabel(t: TFunction, bucket: ActiveStatusBucket, count: number): string {
  switch (bucket) {
    case "running":
      return t("subagents.pillLabelWorking", { count });
    case "failed":
      return t("subagents.pillLabelFailed", { count });
    case "needs_input":
      return count === 1
        ? t("subagents.pillLabelNeedsInputOne")
        : t("subagents.pillLabelNeedsInputMany", { count });
    case "attention":
      return t("subagents.pillLabelReadyToReview", { count });
  }
}

/** Nothing is happening, so the pill is back to naming what it opens. */
function totalLabel(t: TFunction, total: number): string {
  return total === 1 ? t("subagents.pillLabelOne") : t("subagents.pillLabelMany", { count: total });
}

/**
 * Empty when every child is done: a finished fan-out is not worth a colour above the composer.
 */
function summarizeSubagentStatus(rows: readonly SubagentRow[]): SubagentStatusCount[] {
  const buckets = rows.map((row) => buildSubagentRowPresentationData(row).statusBucket);
  return ACTIVE_STATUS_BUCKET_ORDER.flatMap((bucket) => {
    const count = buckets.filter((candidate) => candidate === bucket).length;
    return count > 0 ? [{ bucket, count }] : [];
  });
}

/** The panel's rank for each state: the sidebar's status order, with finished children last. */
const TRACK_ROW_ORDER: readonly SidebarStateBucket[] = [...ACTIVE_STATUS_BUCKET_ORDER, "done"];

/**
 * The order the track's panel lists children: what wants the user first, in the sidebar's status
 * order (needs input, failed, ready to review, working), then the finished ones, each state in
 * launch order. The pill counts "1 failed" out of a long fan-out; listing by launch time alone
 * left that child somewhere among sixty finished rows, so the count pointed at nothing visible.
 */
export function orderSubagentRowsForTrack(rows: readonly SubagentRow[]): SubagentRow[] {
  const rank = (row: SubagentRow) => {
    const bucket = buildSubagentRowPresentationData(row).statusBucket ?? "done";
    return TRACK_ROW_ORDER.indexOf(bucket);
  };
  return rows
    .map((row, index) => ({ row, index, rank: rank(row) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ row }) => row);
}

/**
 * How a finished child ended, when that is not plain success: the word its facts line leads with.
 * A child the user stopped is "stopped", never "failed" — only an error is a failure.
 */
export type SubagentRowOutcome = "failed" | "stopped";

export function subagentRowOutcome(row: SubagentRow): SubagentRowOutcome | null {
  if (buildSubagentRowPresentationData(row).statusBucket === "failed") return "failed";
  if (row.kind === "provider" && row.status === "canceled") return "stopped";
  return null;
}

export function countFinishedSubagents(rows: readonly SubagentRow[]): number {
  return rows.filter((row) => row.kind === "provider" && row.status !== "running").length;
}

export function resolveRowLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}
