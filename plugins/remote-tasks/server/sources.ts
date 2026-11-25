import { promises as fs } from "node:fs";
import path from "node:path";
import { RemoteExecError } from "./types.js";

// Source selection for remote_run (spec 33.4 / ADR-0045): `source` names one or more directories
// inside the agent's cwd, `sendCode: false` runs without any code. The default (no `source`) keeps
// the whole cwd as the single source, git or not — `not_git_workspace` no longer exists.

export const MAX_SOURCES = 8;

export interface ResolvedSource {
  /** Source name = basename of the resolved directory (spec 33.4). */
  name: string;
  /** Absolute path on the daemon after realpath. */
  absolutePath: string;
}

export type SourceSelection =
  | { kind: "default" }
  | { kind: "noCode" }
  | { kind: "explicit"; sources: ResolvedSource[] };

function invalidSource(message: string): RemoteExecError {
  return new RemoteExecError("invalid_source", message);
}

async function resolveElement(cwd: string, element: string): Promise<ResolvedSource> {
  const raw = path.resolve(cwd, element);
  let absolutePath: string;
  try {
    absolutePath = await fs.realpath(raw);
  } catch {
    throw new RemoteExecError(
      "source_not_found",
      `Source "${element}" does not exist in the workspace`,
    );
  }
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    throw new RemoteExecError(
      "source_not_found",
      `Source "${element}" does not exist in the workspace`,
    );
  }
  if (!stats.isDirectory()) {
    throw new RemoteExecError("source_not_found", `Source "${element}" is not a directory`);
  }
  // realpath of the source must stay inside cwd (cwd itself counts as inside, spec 33.4). cwd is
  // resolved too, so a symlinked cwd keeps its own subtree inside the boundary.
  const cwdReal = await fs.realpath(cwd);
  if (absolutePath !== cwdReal && !absolutePath.startsWith(`${cwdReal}${path.sep}`)) {
    throw new RemoteExecError(
      "source_outside_workspace",
      `Source "${element}" resolves outside the workspace (${absolutePath})`,
    );
  }
  return { name: path.basename(absolutePath), absolutePath };
}

export async function resolveSourceSelection(input: {
  cwd: string;
  source?: string | string[];
  noCode?: boolean;
}): Promise<SourceSelection> {
  const cwd = path.resolve(input.cwd);
  if (input.source === undefined) {
    if (input.noCode === true) return { kind: "noCode" };
    return { kind: "default" };
  }
  if (input.noCode === true) {
    throw invalidSource("sendCode: false cannot be combined with source");
  }
  const elements = Array.isArray(input.source) ? input.source : [input.source];
  if (elements.length === 0) {
    throw invalidSource("source must name at least one directory");
  }
  for (const element of elements) {
    if (typeof element !== "string" || element.length === 0) {
      throw invalidSource("source entries must be non-empty paths");
    }
  }
  // Duplicates of the same path merge; name conflicts and the 8-source cap apply after merging
  // (spec 33.4).
  const merged = new Map<string, ResolvedSource>();
  for (const element of elements) {
    const resolved = await resolveElement(cwd, element);
    const existing = merged.get(resolved.absolutePath);
    if (!existing) merged.set(resolved.absolutePath, resolved);
  }
  const sources = [...merged.values()];
  if (sources.length > MAX_SOURCES) {
    throw new RemoteExecError(
      "too_many_sources",
      `At most ${MAX_SOURCES} sources can run in one job (got ${sources.length})`,
    );
  }
  const byName = new Map<string, string>();
  for (const source of sources) {
    const owner = byName.get(source.name);
    if (owner && owner !== source.absolutePath) {
      throw new RemoteExecError(
        "source_name_conflict",
        `Two sources share the name "${source.name}" (${owner}, ${source.absolutePath})`,
      );
    }
    byName.set(source.name, source.absolutePath);
  }
  return { kind: "explicit", sources };
}
