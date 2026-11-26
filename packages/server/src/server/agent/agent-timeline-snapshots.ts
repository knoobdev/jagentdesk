import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { writeFileAtomic } from "../atomic-file.js";
import type { AgentTimelineSnapshot } from "./agent-timeline-store.js";
import type { ProviderSubagentSnapshot } from "./provider-subagents/store.js";

const SNAPSHOT_VERSION = 1;
const DEFAULT_WRITE_DELAY_MS = 5_000;

/**
 * An agent's projected timeline as the daemon last held it, and the provider history it was
 * projected from. Reopening the agent restores it instead of replaying the provider history,
 * provided the provider still reports the same history version.
 */
export interface StoredAgentTimelineSnapshot {
  version: typeof SNAPSHOT_VERSION;
  agentId: string;
  provider: string;
  sessionId: string;
  historyVersion: string;
  writtenAt: string;
  timeline: AgentTimelineSnapshot;
  subagents: ProviderSubagentSnapshot[];
}

/** What the owner captures for a write, or why there is nothing to write yet. */
export type AgentTimelineSnapshotCapture =
  | { status: "ready"; snapshot: StoredAgentTimelineSnapshot }
  /** The agent is mid-run; its timeline and provider history are not settled. */
  | { status: "busy" }
  /** The agent has nothing a snapshot can describe. */
  | { status: "skip" };

interface AgentTimelineSnapshotsOptions {
  directory: string;
  logger: Logger;
  writeDelayMs?: number;
}

function isStoredSnapshot(value: unknown, agentId: string): value is StoredAgentTimelineSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredAgentTimelineSnapshot>;
  return (
    record.version === SNAPSHOT_VERSION &&
    record.agentId === agentId &&
    typeof record.provider === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.historyVersion === "string" &&
    typeof record.timeline?.epoch === "string" &&
    typeof record.timeline.nextSeq === "number" &&
    Array.isArray(record.timeline.rows) &&
    Array.isArray(record.subagents)
  );
}

/**
 * File-backed projected-timeline snapshots, one JSON file per agent. A snapshot is a cache: a
 * missing, unreadable or outdated one costs a provider replay, never history.
 */
export class AgentTimelineSnapshots {
  private readonly directory: string;
  private readonly logger: Logger;
  private readonly writeDelayMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly dirty = new Set<string>();
  private readonly writes = new Map<string, Promise<void>>();
  private capture: ((agentId: string) => Promise<AgentTimelineSnapshotCapture>) | null = null;

  constructor(options: AgentTimelineSnapshotsOptions) {
    this.directory = options.directory;
    this.logger = options.logger.child({ module: "agent-timeline-snapshots" });
    this.writeDelayMs = options.writeDelayMs ?? DEFAULT_WRITE_DELAY_MS;
  }

  /** The owner of the timelines provides what a write stores. */
  attach(capture: (agentId: string) => Promise<AgentTimelineSnapshotCapture>): void {
    this.capture = capture;
  }

  private filePath(agentId: string): string {
    return path.join(this.directory, `${encodeURIComponent(agentId)}.json`);
  }

  async read(agentId: string): Promise<StoredAgentTimelineSnapshot | null> {
    await this.writes.get(agentId);
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath(agentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      this.logger.warn({ err: error, agentId }, "Failed to read agent timeline snapshot");
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isStoredSnapshot(parsed, agentId)) return parsed;
      this.logger.warn({ agentId }, "Ignoring agent timeline snapshot with an unknown shape");
    } catch (error) {
      this.logger.warn({ err: error, agentId }, "Ignoring unreadable agent timeline snapshot");
    }
    return null;
  }

  /** The timeline changed; write it once it has been quiet and the agent is settled. */
  markChanged(agentId: string): void {
    this.dirty.add(agentId);
    this.schedule(agentId, this.writeDelayMs);
  }

  private schedule(agentId: string, delayMs: number): void {
    const existing = this.timers.get(agentId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(agentId);
      void this.flush(agentId, { retryWhenBusy: true });
    }, delayMs);
    timer.unref?.();
    this.timers.set(agentId, timer);
  }

  /** Writes a pending change now. A busy agent is retried later only when asked to. */
  async flush(agentId: string, options?: { retryWhenBusy?: boolean }): Promise<void> {
    const timer = this.timers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(agentId);
    }
    await this.writes.get(agentId);
    if (!this.dirty.has(agentId) || !this.capture) return;
    const write = this.writeCaptured(agentId, options?.retryWhenBusy === true);
    this.writes.set(agentId, write);
    try {
      await write;
    } finally {
      if (this.writes.get(agentId) === write) this.writes.delete(agentId);
    }
  }

  private async writeCaptured(agentId: string, retryWhenBusy: boolean): Promise<void> {
    if (!this.capture) return;
    // Cleared before capturing: a change that lands while this write runs marks it again.
    this.dirty.delete(agentId);
    try {
      const capture = await this.capture(agentId);
      if (capture.status === "busy") {
        this.dirty.add(agentId);
        if (retryWhenBusy) this.schedule(agentId, this.writeDelayMs);
        return;
      }
      if (capture.status === "skip") return;
      const startedAt = performance.now();
      const data = JSON.stringify(capture.snapshot);
      await writeFileAtomic(this.filePath(agentId), data);
      this.logger.debug(
        {
          agentId,
          rows: capture.snapshot.timeline.rows.length,
          bytes: data.length,
          durationMs: Math.round(performance.now() - startedAt),
        },
        "Wrote agent timeline snapshot",
      );
    } catch (error) {
      this.dirty.add(agentId);
      this.logger.warn({ err: error, agentId }, "Failed to write agent timeline snapshot");
    }
  }

  /** Forgets the agent's snapshot: its timeline is being rebuilt from the provider or removed. */
  async delete(agentId: string): Promise<void> {
    const timer = this.timers.get(agentId);
    if (timer) clearTimeout(timer);
    this.timers.delete(agentId);
    this.dirty.delete(agentId);
    await this.writes.get(agentId);
    await fs.rm(this.filePath(agentId), { force: true }).catch((error: unknown) => {
      this.logger.warn({ err: error, agentId }, "Failed to delete agent timeline snapshot");
    });
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.dirty].map((agentId) => this.flush(agentId)));
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
