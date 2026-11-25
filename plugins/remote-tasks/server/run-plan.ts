import path from "node:path";
import { computeSourcesSnapshotId, computeWorkspaceKey } from "./ids.js";
import { sha256Hex } from "./hash-cache.js";
import {
  hashSourceEntries,
  listSourceEntries,
  SNAPSHOT_MAX_FILE_BYTES,
  SNAPSHOT_MAX_TOTAL_BYTES,
  type SourceListing,
  type WorkspaceSnapshot,
} from "./snapshot.js";
import { resolveSourceSelection } from "./sources.js";
import { RemoteExecError } from "./types.js";

// The run plan (spec 33.4–33.6): resolves the source selection, lists + lstats every candidate of
// EVERY source of the run (phase one — no file content read), enforces the run-wide size limits,
// and only then hashes (phase two). Both previewSnapshot and startJob go through createRunPlan, so
// source errors always fire before a permission card or a job record, and snapshot_too_large never
// costs a multi-gigabyte hashing pass.

export type RunPlan =
  | {
      kind: "default";
      cwd: string;
      workspaceKey: string;
      snapshot: WorkspaceSnapshot;
    }
  | { kind: "noCode"; cwd: string; workspaceKey: string }
  | {
      kind: "sources";
      cwd: string;
      workspaceKey: string;
      snapshots: Array<{ name: string; path: string; snapshot: WorkspaceSnapshot }>;
    };

/** One-based default: a default-source run is the single source `<name: null>`. */
interface SourceLike {
  name: string | null;
  listing: SourceListing;
}

/**
 * Run-wide size limits (spec 33.4): per file ≤ 100 MiB, total across ALL sources of the run
 * ≤ 1 GiB. Paths are prefixed `<name>/` for explicit sources. The message suggests narrowing the
 * run with `source` or `sendCode: false`.
 */
function enforceRunLimits(sources: readonly SourceLike[]): void {
  const oversized: { path: string; size: number }[] = [];
  let bytesTotal = 0;
  const all: { path: string; size: number }[] = [];
  for (const { name, listing } of sources) {
    const prefix = name === null ? "" : `${name}/`;
    for (const file of listing.files) {
      bytesTotal += file.size;
      const displayPath = `${prefix}${file.path}`;
      all.push({ path: displayPath, size: file.size });
      if (file.size > SNAPSHOT_MAX_FILE_BYTES)
        oversized.push({ path: displayPath, size: file.size });
    }
  }
  if (oversized.length > 0 || bytesTotal > SNAPSHOT_MAX_TOTAL_BYTES) {
    const largest = all
      .toSorted((a, b) => b.size - a.size)
      .slice(0, 10)
      .map((file) => ({ path: file.path, bytes: file.size }));
    throw new RemoteExecError(
      "snapshot_too_large",
      "Snapshot exceeds the size limits; narrow the run with `source` or send no code with " +
        "`sendCode: false`",
      { largest },
    );
  }
}

/** Job-level snapshotId (spec 33.4): the source's id, or the aggregate over (name, id) pairs. */
export function jobSnapshotId(plan: RunPlan): string | null {
  if (plan.kind === "noCode") return null;
  if (plan.kind === "default") return plan.snapshot.snapshotId;
  if (plan.snapshots.length === 1) return plan.snapshots[0].snapshot.snapshotId;
  return computeSourcesSnapshotId(
    plan.snapshots.map((entry) => ({ name: entry.name, snapshotId: entry.snapshot.snapshotId })),
  );
}

export async function createRunPlan(input: {
  cwd: string;
  daemonId: string;
  homeDir: string;
  source?: string | string[];
  noCode?: boolean;
  maxVisitedEntries?: number;
  /** Injected by tests; threaded into the hashing phase only. */
  hasher?: (absolutePath: string) => Promise<string>;
}): Promise<RunPlan> {
  const cwd = path.resolve(input.cwd);
  const workspaceKey = computeWorkspaceKey(input.daemonId, cwd);
  const selection = await resolveSourceSelection({
    cwd,
    source: input.source,
    noCode: input.noCode,
  });
  if (selection.kind === "noCode") return { kind: "noCode", cwd, workspaceKey };
  if (selection.kind === "default") {
    const listing = await listSourceEntries({
      workspacePath: cwd,
      daemonId: input.daemonId,
      maxVisitedEntries: input.maxVisitedEntries,
    });
    enforceRunLimits([{ name: null, listing }]);
    const snapshot = await hashSourceEntries({
      listing,
      homeDir: input.homeDir,
      hasher: input.hasher,
    });
    return { kind: "default", cwd, workspaceKey, snapshot };
  }
  // Phase one for every source before anything is hashed: the limits are run-wide, so an
  // oversized second source must not have let the first one's gigabytes through the hasher.
  const listings: Array<{ name: string; path: string; listing: SourceListing }> = [];
  for (const source of selection.sources) {
    listings.push({
      name: source.name,
      path: source.absolutePath,
      listing: await listSourceEntries({
        workspacePath: source.absolutePath,
        daemonId: input.daemonId,
        // Explicit sources share the run's cwd-based key but get their own cache file so they
        // never evict the default source's cache.
        workspaceKey,
        cacheFile: `${workspaceKey}-${sha256Hex(source.absolutePath).slice(0, 12)}.json`,
        maxVisitedEntries: input.maxVisitedEntries,
      }),
    });
  }
  enforceRunLimits(listings);
  const snapshots: Array<{ name: string; path: string; snapshot: WorkspaceSnapshot }> = [];
  for (const entry of listings) {
    snapshots.push({
      name: entry.name,
      path: entry.path,
      snapshot: await hashSourceEntries({
        listing: entry.listing,
        homeDir: input.homeDir,
        hasher: input.hasher,
      }),
    });
  }
  return { kind: "sources", cwd, workspaceKey, snapshots };
}
