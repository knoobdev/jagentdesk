export function backgroundWorkText(
  item: { description: string | null; command?: string },
  kind: string,
): { title: string; command: string | null } {
  const title = item.description ?? item.command ?? kind;
  return { title, command: item.command && item.command !== title ? item.command : null };
}

/** What a row in the background work list knows about its task's state. */
export type BackgroundWorkRowState =
  | { state: "live" }
  | { state: "stopping"; failed: boolean }
  | {
      state: "finished";
      /** The host's detail of the ended task, or null while unknown (loading, or an older host). */
      outcome: { status: string; exitCode: number | null } | null;
    };

/**
 * The one-line status under a row's label (spec 38 §4.4b, 04 §27c): running time for live work
 * (drawn by the row), "Finished · exit 0", "Failed · exit 1", "Stopped", or "Ended" while the
 * outcome is unknown. One short line, so it never wraps beside the label the way "No longer
 * running" did.
 */
export type BackgroundWorkRowStatus =
  | { kind: "elapsed" }
  | {
      kind: "text";
      tone: "muted" | "success" | "danger";
      key: BackgroundWorkRowStatusKey;
      exitCode: number | null;
    };

export type BackgroundWorkRowStatusKey =
  | "message.backgroundWork.stopping"
  | "message.backgroundWork.stopError"
  | "message.backgroundWork.detail.statusValue.finished"
  | "message.backgroundWork.detail.statusValue.failed"
  | "message.backgroundWork.detail.statusValue.stopped"
  | "message.backgroundWork.ended";

export function backgroundWorkRowStatus(row: BackgroundWorkRowState): BackgroundWorkRowStatus {
  if (row.state === "live") return { kind: "elapsed" };
  if (row.state === "stopping")
    return row.failed
      ? { kind: "text", tone: "danger", key: "message.backgroundWork.stopError", exitCode: null }
      : { kind: "text", tone: "muted", key: "message.backgroundWork.stopping", exitCode: null };
  const outcome = row.outcome;
  if (!outcome || outcome.status === "running")
    return { kind: "text", tone: "muted", key: "message.backgroundWork.ended", exitCode: null };
  if (outcome.status === "stopped")
    return {
      kind: "text",
      tone: "muted",
      key: "message.backgroundWork.detail.statusValue.stopped",
      exitCode: null,
    };
  // The provider's word decides, as in the detail; an unknown status reads as finished.
  const failed = outcome.status === "failed";
  return {
    kind: "text",
    tone: failed ? "danger" : "success",
    key: failed
      ? "message.backgroundWork.detail.statusValue.failed"
      : "message.backgroundWork.detail.statusValue.finished",
    exitCode: outcome.exitCode,
  };
}

/** "Dismiss all" earns its row once there is more than one ended task to clear. */
export function showsDismissAll(finishedCount: number): boolean {
  return finishedCount >= 2;
}
