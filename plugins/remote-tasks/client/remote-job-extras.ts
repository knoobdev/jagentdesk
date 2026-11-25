/**
 * Optional job-record fields from ADR-0045 (`noCode`, `sources`), read at runtime instead of
 * through the protocol type: the fields are additive (spec 33.6), so the card must render
 * records from old daemons that never carry them.
 */

export interface RemoteJobSourceSync {
  filesUploaded: number;
  filesDeleted: number;
}

export interface RemoteJobSource {
  name: string;
  /** Absolute path on the daemon machine (spec 33.6); informational. */
  path?: string;
  sync?: RemoteJobSourceSync | null;
}

export interface RemoteJobExtras {
  /** `noCode: true` — the job ran without sending any code (`sendCode: false`, spec 33.4). */
  noCode: boolean;
  /** Sources selected via `remote_run.source`; empty for the default (cwd) source. */
  sources: RemoteJobSource[];
}

const EMPTY_EXTRAS: RemoteJobExtras = { noCode: false, sources: [] };

export function readRemoteJobExtras(job: unknown): RemoteJobExtras {
  if (!job || typeof job !== "object") return EMPTY_EXTRAS;
  const record = job as Record<string, unknown>;
  const sources = readSources(record.sources);
  if (record.noCode !== true && sources.length === 0) return EMPTY_EXTRAS;
  return { noCode: record.noCode === true, sources };
}

function readSources(value: unknown): RemoteJobSource[] {
  if (!Array.isArray(value)) return [];
  const sources: RemoteJobSource[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || record.name.length === 0) continue;
    sources.push({
      name: record.name,
      ...(typeof record.path === "string" && record.path.length > 0 ? { path: record.path } : {}),
      ...readSync(record.sync),
    });
  }
  return sources;
}

function readSync(value: unknown): { sync: RemoteJobSourceSync } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.filesUploaded !== "number" || typeof record.filesDeleted !== "number") {
    return null;
  }
  return {
    sync: { filesUploaded: record.filesUploaded, filesDeleted: record.filesDeleted },
  };
}
