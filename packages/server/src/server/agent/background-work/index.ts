import { randomUUID } from "node:crypto";
import type { AgentBackgroundWorkSummary } from "@jagentdesk/protocol/messages";

export interface AgentBackgroundWorkInput {
  id: string;
  /** Provider-neutral kind; consumers treat unknown kinds as other work. */
  kind: string;
  description: string | null;
  command?: string;
  canStop?: boolean;
  /** The folder the work runs in, when the provider reports it. Never sent in the list. */
  cwd?: string;
  /** Where the work's output can be read (ADR-0062). Daemon-only; never sent to clients. */
  output?: BackgroundWorkOutputSource;
}

/** One page of output read through a provider API. */
export interface BackgroundWorkOutputPage {
  /** Raw bytes the provider returned for `[cursor, nextCursor)`. */
  bytes: Uint8Array;
  /** Byte offset after this page. */
  nextCursor: number;
  /** Total bytes the provider holds for this work. */
  size: number;
}

/**
 * The single output source a provider attached to one background item. The daemon reads
 * nothing else for it (ADR-0062 §3): no RPC takes a path.
 */
export type BackgroundWorkOutputSource =
  | {
      type: "file";
      /** Resolves the file the provider wrote for this item, or null when it is not readable. */
      locate(): Promise<BackgroundWorkOutputFile | null>;
      /**
       * ADR-0064: a file the command has not created yet reads as empty while this returns
       * true (the work still runs). Without it a missing file is unavailable.
       */
      waitWhile?: () => boolean;
    }
  | {
      type: "reader";
      read(input: { cursor: number; limit: number }): Promise<BackgroundWorkOutputPage>;
    };

export interface BackgroundWorkOutputFile {
  path: string;
  /** The opened file must resolve inside one of these folders. */
  roots: readonly string[];
  /** True refuses the file by its real path (ADR-0064's secret patterns). */
  refuse?: (realPath: string) => boolean;
}

export type BackgroundWorkStatus = "running" | "finished" | "failed" | "stopped";

/** How one item ended, when the provider says so. */
export interface AgentBackgroundWorkEnd {
  id: string;
  status: Exclude<BackgroundWorkStatus, "running">;
  exitCode?: number | null;
  /** Late output source, e.g. the output file named in the end notice. */
  output?: BackgroundWorkOutputSource;
}

/** What `detail` knows about one item, live or recently ended. */
export interface AgentBackgroundWorkDetail {
  item: AgentBackgroundWorkItem;
  status: BackgroundWorkStatus;
  endedAt: string | null;
  exitCode: number | null;
  cwd: string | null;
  output: BackgroundWorkOutputSource | null;
}

interface ItemExtras {
  cwd?: string;
  output?: BackgroundWorkOutputSource;
}

interface EndedWork {
  item: AgentBackgroundWorkItem;
  endedAt: string;
  status: Exclude<BackgroundWorkStatus, "running">;
  exitCode: number | null;
  extras: ItemExtras;
}

/** Ended items kept per agent so their detail and output stay readable after they finish. */
const MAX_ENDED_PER_AGENT = 50;

export interface AgentBackgroundWorkItem extends AgentBackgroundWorkInput {
  startedAt: string;
  stopToken?: string;
}

export interface DaemonBackgroundWorkKey {
  agentId: string;
  namespace: "heartbeat" | "change-request-watch";
  id: string;
}

export interface DaemonBackgroundWorkInput extends DaemonBackgroundWorkKey {
  kind: string;
  description: string | null;
  startedAt: string;
  countsAsRunning?: boolean;
  stop: () => Promise<void>;
}

interface DaemonBackgroundWork {
  item: AgentBackgroundWorkItem;
  countsAsRunning: boolean;
  stop: DaemonBackgroundWorkInput["stop"];
}

const HEARTBEAT_ID_PREFIX = "heartbeat:";
const DAEMON_ID_PREFIX = "daemon:";
const PROVIDER_ID_ESCAPE = "provider:";

export function isDaemonBackgroundWorkItem(item: { id: string }): boolean {
  return item.id.startsWith(HEARTBEAT_ID_PREFIX) || item.id.startsWith(DAEMON_ID_PREFIX);
}

function daemonItemId({ namespace, id }: DaemonBackgroundWorkKey): string {
  return namespace === "heartbeat"
    ? HEARTBEAT_ID_PREFIX + id
    : `${DAEMON_ID_PREFIX}${namespace}:${id}`;
}

function encodeProviderItemId(id: string): string {
  // Preserve existing wire IDs outside the reserved namespaces.
  return isDaemonBackgroundWorkItem({ id }) || id.startsWith(PROVIDER_ID_ESCAPE)
    ? PROVIDER_ID_ESCAPE + id
    : id;
}

/**
 * Live inventory per agent. Providers replace their entire contribution with `apply`.
 * Daemon services publish individual items that outlive provider sessions.
 */
export class AgentBackgroundWorkStore {
  private readonly providerItems = new Map<string, AgentBackgroundWorkItem[]>();
  private readonly daemonItems = new Map<string, Map<string, DaemonBackgroundWork>>();
  private readonly extras = new Map<string, Map<string, ItemExtras>>();
  private readonly ended = new Map<string, EndedWork[]>();
  /** End notices that arrived while the item was still listed. */
  private readonly pendingEnds = new Map<string, Map<string, AgentBackgroundWorkEnd>>();

  apply(
    agentId: string,
    inputs: readonly AgentBackgroundWorkInput[],
    timestamp: string = new Date().toISOString(),
  ): AgentBackgroundWorkItem[] | null {
    const previous = this.providerItems.get(agentId);
    const previousById = new Map(previous?.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const next: AgentBackgroundWorkItem[] = [];
    const extras = this.extras.get(agentId) ?? new Map<string, ItemExtras>();
    for (const input of inputs) {
      const id = encodeProviderItemId(input.id);
      if (seen.has(id)) continue;
      seen.add(id);
      extras.set(id, mergeExtras(extras.get(id), input));
      this.forgetEnded(agentId, id);
      next.push({
        id,
        kind: input.kind,
        description: input.description,
        ...(input.command ? { command: input.command } : {}),
        ...(input.canStop
          ? { canStop: true, stopToken: previousById.get(id)?.stopToken ?? randomUUID() }
          : {}),
        startedAt: previousById.get(id)?.startedAt ?? timestamp,
      });
    }
    this.extras.set(agentId, extras);
    this.retire(agentId, previous ?? [], seen, timestamp);
    if (previous && sameItems(previous, next)) return null;
    this.providerItems.set(agentId, next);
    return this.list(agentId);
  }

  /**
   * Records how an item ended. A notice for a listed item waits until the inventory drops it;
   * a notice for an item that already left updates its ended record.
   */
  end(agentId: string, end: AgentBackgroundWorkEnd): void {
    const id = encodeProviderItemId(end.id);
    const record = this.ended.get(agentId)?.find((work) => work.item.id === id);
    if (record) {
      applyEnd(record, end);
      return;
    }
    if (!this.providerItems.get(agentId)?.some((item) => item.id === id)) return;
    const pending = this.pendingEnds.get(agentId) ?? new Map<string, AgentBackgroundWorkEnd>();
    pending.set(id, { ...pending.get(id), ...end });
    this.pendingEnds.set(agentId, pending);
  }

  /** The item's detail while it runs, or for a while after it ended. */
  detail(agentId: string, itemId: string): AgentBackgroundWorkDetail | null {
    const live = this.providerItems.get(agentId)?.find((item) => item.id === itemId);
    if (live) {
      const extras = this.extras.get(agentId)?.get(itemId);
      return {
        item: live,
        status: "running",
        endedAt: null,
        exitCode: null,
        cwd: extras?.cwd ?? null,
        output: extras?.output ?? null,
      };
    }
    const daemon = this.daemonItems.get(agentId)?.get(itemId);
    if (daemon) {
      return {
        item: daemon.item,
        status: "running",
        endedAt: null,
        exitCode: null,
        cwd: null,
        output: null,
      };
    }
    const ended = this.ended.get(agentId)?.find((work) => work.item.id === itemId);
    if (!ended) return null;
    const { canStop: _canStop, stopToken: _stopToken, ...item } = ended.item;
    return {
      item,
      status: ended.status,
      endedAt: ended.endedAt,
      exitCode: ended.exitCode,
      cwd: ended.extras.cwd ?? null,
      output: ended.extras.output ?? null,
    };
  }

  private retire(
    agentId: string,
    previous: readonly AgentBackgroundWorkItem[],
    live: ReadonlySet<string>,
    timestamp: string,
    status: EndedWork["status"] = "finished",
  ): void {
    const extras = this.extras.get(agentId);
    const pending = this.pendingEnds.get(agentId);
    for (const item of previous) {
      if (live.has(item.id)) continue;
      const end = pending?.get(item.id);
      pending?.delete(item.id);
      const record: EndedWork = {
        item,
        endedAt: timestamp,
        status,
        exitCode: null,
        extras: extras?.get(item.id) ?? {},
      };
      if (end) applyEnd(record, end);
      extras?.delete(item.id);
      const ended = this.ended.get(agentId) ?? [];
      ended.unshift(record);
      ended.length = Math.min(ended.length, MAX_ENDED_PER_AGENT);
      this.ended.set(agentId, ended);
    }
    if (pending?.size === 0) this.pendingEnds.delete(agentId);
    if (extras?.size === 0) this.extras.delete(agentId);
  }

  private forgetEnded(agentId: string, id: string): void {
    const ended = this.ended.get(agentId);
    if (!ended) return;
    const index = ended.findIndex((work) => work.item.id === id);
    if (index >= 0) ended.splice(index, 1);
  }

  setDaemonBackgroundWork(input: DaemonBackgroundWorkInput): AgentBackgroundWorkItem[] | null {
    const { agentId, kind, description, startedAt, countsAsRunning = true, stop } = input;
    const id = daemonItemId(input);
    const items = this.daemonItems.get(agentId) ?? new Map<string, DaemonBackgroundWork>();
    const previous = items.get(id);
    const item: AgentBackgroundWorkItem = {
      id,
      kind,
      description,
      startedAt,
      canStop: true,
      stopToken: previous?.item.stopToken ?? randomUUID(),
    };
    items.set(id, { item, countsAsRunning, stop });
    this.daemonItems.set(agentId, items);
    return previous?.countsAsRunning === countsAsRunning && sameItems([previous.item], [item])
      ? null
      : this.list(agentId);
  }

  removeDaemonBackgroundWork(key: DaemonBackgroundWorkKey): AgentBackgroundWorkItem[] | null {
    const { agentId } = key;
    const items = this.daemonItems.get(agentId);
    if (!items?.delete(daemonItemId(key))) return null;
    if (items.size === 0) this.daemonItems.delete(agentId);
    return this.list(agentId);
  }

  async stopDaemon(agentId: string, itemId: string, stopToken: string): Promise<void> {
    const work = this.daemonItems.get(agentId)?.get(itemId);
    if (!work || work.item.stopToken !== stopToken) {
      throw new Error("Background work is no longer available to stop");
    }
    await work.stop();
  }

  authorizeProviderStop(agentId: string, itemId: string, stopToken: string): string {
    const item = this.providerItems.get(agentId)?.find(({ id }) => id === itemId);
    if (!item?.canStop || item.stopToken !== stopToken) {
      throw new Error("Background work is no longer available to stop");
    }
    return itemId.startsWith(PROVIDER_ID_ESCAPE) ? itemId.slice(PROVIDER_ID_ESCAPE.length) : itemId;
  }

  list(agentId: string): AgentBackgroundWorkItem[] {
    const items = [...(this.providerItems.get(agentId) ?? [])];
    for (const { item } of this.daemonItems.get(agentId)?.values() ?? []) {
      items.push(item);
    }
    return items;
  }

  summary(agentId: string): AgentBackgroundWorkSummary | undefined {
    const items = this.providerItems.get(agentId);
    const daemonItems = this.daemonItems.get(agentId);
    if (!items && !daemonItems) return undefined;

    const count = (items?.length ?? 0) + (daemonItems?.size ?? 0);
    let runningCount = items?.length ?? 0;
    for (const work of daemonItems?.values() ?? []) {
      if (work.countsAsRunning) runningCount++;
    }
    return runningCount === count ? { count } : { count, runningCount };
  }

  clear(
    agentId: string,
    timestamp: string = new Date().toISOString(),
  ): AgentBackgroundWorkItem[] | null {
    const previous = this.providerItems.get(agentId);
    if (!previous) return null;
    // A reset drops the roster: the provider process that owned it went away. Work listed
    // again later comes back as live.
    this.retire(agentId, previous, new Set(), timestamp, "stopped");
    this.providerItems.delete(agentId);
    return this.list(agentId);
  }

  /** The agent is gone; nothing about its work stays readable. */
  forget(agentId: string): void {
    this.ended.delete(agentId);
    this.pendingEnds.delete(agentId);
    this.extras.delete(agentId);
  }
}

/** A provider may report the folder or output source in a later update than the first. */
function mergeExtras(known: ItemExtras | undefined, input: AgentBackgroundWorkInput): ItemExtras {
  const merged: ItemExtras = {};
  const cwd = input.cwd ?? known?.cwd;
  const output = input.output ?? known?.output;
  if (cwd) merged.cwd = cwd;
  if (output) merged.output = output;
  return merged;
}

function applyEnd(record: EndedWork, end: AgentBackgroundWorkEnd): void {
  record.status = end.status;
  if (end.exitCode !== undefined) record.exitCode = end.exitCode;
  if (end.output) record.extras = { ...record.extras, output: end.output };
}

function sameItems(
  left: readonly AgentBackgroundWorkItem[],
  right: readonly AgentBackgroundWorkItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        item.id === other.id &&
        item.kind === other.kind &&
        item.description === other.description &&
        item.command === other.command &&
        item.canStop === other.canStop &&
        item.stopToken === other.stopToken &&
        item.startedAt === other.startedAt
      );
    })
  );
}
