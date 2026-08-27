/**
 * Persistence for the set of hosts that are currently failing to connect
 * ("timing out"). The set is written to local storage so that, on the next app
 * launch, the user can be re-notified about hosts that were still failing when
 * the app was last closed:
 *
 * - `kind: "tailnet"` — likely a lapsed Tailscale login; prompt to log in again.
 * - `kind: "local"`   — a local host that exhausted its retries; prompt to
 *   remove and recreate it.
 *
 * This module is intentionally pure (no storage access) so the serialization
 * and the enter/leave set arithmetic can be unit-tested in isolation. The
 * runtime store owns the actual read/write against `HostRuntimeStorage`.
 */

export const TIMING_OUT_HOSTS_STORAGE_KEY = "@jagentdesk:timing-out-hosts";

export type TimingOutHostKind = "tailnet" | "local";

export interface TimingOutHostEntry {
  serverId: string;
  label: string;
  kind: TimingOutHostKind;
  /** Milliseconds Unix UTC — when the host last entered/updated the failing state. */
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeEntry(value: unknown): TimingOutHostEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  const serverId = typeof value.serverId === "string" ? value.serverId.trim() : "";
  if (!serverId) {
    return null;
  }
  const kind = value.kind === "tailnet" || value.kind === "local" ? value.kind : null;
  if (!kind) {
    return null;
  }
  const label =
    typeof value.label === "string" && value.label.trim().length > 0 ? value.label : serverId;
  const updatedAt =
    typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) ? value.updatedAt : 0;
  return { serverId, label, kind, updatedAt };
}

/** Parse a stored JSON payload into a validated, de-duplicated entry list. */
export function parseTimingOutHosts(raw: string | null): TimingOutHostEntry[] {
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const seen = new Set<string>();
  const entries: TimingOutHostEntry[] = [];
  for (const candidate of parsed) {
    const entry = normalizeEntry(candidate);
    if (!entry || seen.has(entry.serverId)) {
      continue;
    }
    seen.add(entry.serverId);
    entries.push(entry);
  }
  return entries;
}

export function serializeTimingOutHosts(entries: readonly TimingOutHostEntry[]): string {
  return JSON.stringify(entries);
}

/**
 * Return the set with `entry` inserted or updated (keyed by `serverId`).
 * Returns the same array reference when nothing changed, so callers can skip a
 * redundant persist.
 */
export function upsertTimingOutHost(
  entries: readonly TimingOutHostEntry[],
  entry: TimingOutHostEntry,
): TimingOutHostEntry[] {
  const existing = entries.find((candidate) => candidate.serverId === entry.serverId);
  if (existing && existing.kind === entry.kind && existing.label === entry.label) {
    // Same host in the same failing state — keep the earlier updatedAt so the
    // set reference (and persisted payload) stays stable across repeated ticks.
    return entries as TimingOutHostEntry[];
  }
  const next = entries.filter((candidate) => candidate.serverId !== entry.serverId);
  next.push(entry);
  return next;
}

/**
 * Return the set with the host removed. Returns the same array reference when
 * the host was not present.
 */
export function removeTimingOutHost(
  entries: readonly TimingOutHostEntry[],
  serverId: string,
): TimingOutHostEntry[] {
  if (!entries.some((candidate) => candidate.serverId === serverId)) {
    return entries as TimingOutHostEntry[];
  }
  return entries.filter((candidate) => candidate.serverId !== serverId);
}
