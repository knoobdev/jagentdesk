import type pino from "pino";
import { jqlTime } from "./board-view.js";
import { JiraApiError } from "./errors.js";
import { jiraTime, obj, objs, str, type Json } from "./json.js";
import type { JiraSite } from "./site.js";

// Polling while a view is open (spec 29.3, ADR-0034 §5): an open board asks every 15 s for issues
// with `updated >= <last poll − 2 min>` and reports the ones it has not seen; an open issue asks
// for its `updated`. A watch belongs to one client view; unwatch (or the client disconnecting)
// stops it, and nothing polls when no view is open.

export const JIRA_POLL_INTERVAL_MS = 15_000;
const OVERLAP_MS = 2 * 60_000;
const SEEN_TTL_MS = 10 * 60_000;
// A first poll ignores updates older than this before the watch began: the view loaded them.
const BASELINE_SLACK_MS = 30_000;

export type BoardChange = (issueKeys: string[]) => void;
export type IssueChange = (updated_ms: number) => void;

interface Watch {
  owner: string;
  connectionId: string;
  timer: ReturnType<typeof setInterval>;
}

export interface JiraWatchesOptions {
  site: (connectionId: string) => JiraSite;
  logger: pino.Logger;
  intervalMs?: number;
  now?: () => number;
}

export class JiraWatches {
  private readonly watches = new Map<string, Watch>();
  private readonly site: (connectionId: string) => JiraSite;
  private readonly logger: pino.Logger;
  private readonly intervalMs: number;
  private readonly now: () => number;

  constructor(options: JiraWatchesOptions) {
    this.site = options.site;
    this.logger = options.logger.child({ module: "jira-watches" });
    this.intervalMs = options.intervalMs ?? JIRA_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  /** Number of live watches (observable for tests and diagnostics). */
  get size(): number {
    return this.watches.size;
  }

  watchBoard(input: {
    watchId: string;
    owner: string;
    connectionId: string;
    boardId: number;
    onChange: BoardChange;
  }): void {
    this.unwatch(input.watchId);
    const startedAt = this.now();
    let since = startedAt;
    let first = true;
    const seen = new Map<string, number>();
    const poll = async () => {
      const site = this.site(input.connectionId);
      const pollStart = this.now();
      const timeZone = site.connection.timeZone ?? "UTC";
      const page: Json = await site.get(`${site.flavor.boardIssues}/board/${input.boardId}/issue`, {
        jql: `updated >= "${jqlTime(since - OVERLAP_MS, timeZone)}"`,
        fields: "updated",
        maxResults: 100,
      });
      const changed: string[] = [];
      for (const issue of objs(page.issues)) {
        const updated = jiraTime(obj(issue.fields)?.updated) ?? 0;
        const mark = `${str(issue.id)}:${updated}`;
        if (seen.has(mark)) continue;
        seen.set(mark, pollStart);
        const preexisting = first && updated < startedAt - BASELINE_SLACK_MS;
        if (!preexisting) changed.push(str(issue.key) ?? "");
      }
      for (const [mark, at] of seen) if (pollStart - at > SEEN_TTL_MS) seen.delete(mark);
      first = false;
      since = pollStart;
      if (changed.length > 0) input.onChange(changed);
    };
    this.start(input.watchId, input.owner, input.connectionId, poll);
  }

  watchIssue(input: {
    watchId: string;
    owner: string;
    connectionId: string;
    issueKey: string;
    onChange: IssueChange;
  }): void {
    this.unwatch(input.watchId);
    let last: number | null = null;
    const poll = async () => {
      const site = this.site(input.connectionId);
      const issue: Json = await site.get(site.api(`/issue/${encodeURIComponent(input.issueKey)}`), {
        fields: "updated",
      });
      const updated = jiraTime(obj(issue.fields)?.updated) ?? 0;
      if (last !== null && updated !== last) input.onChange(updated);
      last = updated;
    };
    this.start(input.watchId, input.owner, input.connectionId, poll);
    void this.runPoll(input.watchId, poll);
  }

  private start(
    watchId: string,
    owner: string,
    connectionId: string,
    poll: () => Promise<void>,
  ): void {
    const timer = setInterval(() => void this.runPoll(watchId, poll), this.intervalMs);
    timer.unref?.();
    this.watches.set(watchId, { owner, connectionId, timer });
  }

  private async runPoll(watchId: string, poll: () => Promise<void>): Promise<void> {
    if (!this.watches.has(watchId)) return;
    try {
      await poll();
    } catch (error) {
      if (
        error instanceof JiraApiError &&
        (error.code === "needs_reauth" || error.code === "auth_failed")
      ) {
        this.logger.warn({ watchId }, "jira watch stopped: connection needs sign-in");
        this.unwatch(watchId);
        return;
      }
      this.logger.info(
        { watchId, err: error instanceof Error ? error.message : String(error) },
        "jira poll failed",
      );
    }
  }

  unwatch(watchId: string): void {
    const watch = this.watches.get(watchId);
    if (!watch) return;
    clearInterval(watch.timer);
    this.watches.delete(watchId);
  }

  /** A client went away: its views are closed. */
  unwatchOwner(owner: string): void {
    for (const [watchId, watch] of this.watches) if (watch.owner === owner) this.unwatch(watchId);
  }

  unwatchConnection(connectionId: string): void {
    for (const [watchId, watch] of this.watches) {
      if (watch.connectionId === connectionId) this.unwatch(watchId);
    }
  }

  dispose(): void {
    for (const watchId of this.watches.keys()) this.unwatch(watchId);
  }
}
