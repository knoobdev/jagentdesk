import { constants, type Stats } from "node:fs";
import { open, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import pLimit from "p-limit";
import { withTimeout } from "./promise-timeout.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import {
  JAgentDeskConfigRawSchema,
  JAgentDeskConfigSchema,
  type JAgentDeskConfig,
  type JAgentDeskConfigRaw,
  type JAgentDeskConfigRevision,
  type ProjectConfigRpcError,
} from "@jagentdesk/protocol/jagentdesk-config-schema";
export {
  JAgentDeskConfigRevisionSchema,
  ProjectConfigRpcErrorSchema,
  type JAgentDeskConfigRevision,
  type ProjectConfigRpcError,
} from "@jagentdesk/protocol/jagentdesk-config-schema";

export const JAGENTDESK_CONFIG_FILE_NAME = "jagentdesk.json";
// Configuration is deliberately small. Bound both IO and main-thread JSON/schema work.
export const MAX_JAGENTDESK_CONFIG_BYTES = 256 * 1024;

export type ReadJAgentDeskConfigForEditResult =
  | { ok: true; config: JAgentDeskConfigRaw | null; revision: JAgentDeskConfigRevision | null }
  | { ok: false; error: ProjectConfigRpcError };
export type ReadJAgentDeskConfigResult =
  | { ok: true; config: JAgentDeskConfig | null }
  | { ok: false; configPath: string; error: unknown };
export type WriteJAgentDeskConfigForEditResult =
  | { ok: true; config: JAgentDeskConfigRaw; revision: JAgentDeskConfigRevision }
  | { ok: false; error: ProjectConfigRpcError };
export interface WriteJAgentDeskConfigForEditInput {
  repoRoot: string;
  config: JAgentDeskConfigRaw;
  expectedRevision: JAgentDeskConfigRevision | null;
}

export function resolveJAgentDeskConfigPath(repoRoot: string): string {
  return join(repoRoot, JAGENTDESK_CONFIG_FILE_NAME);
}

function revision(stats: Stats): JAgentDeskConfigRevision {
  return { mtimeMs: stats.mtimeMs, size: stats.size };
}

async function inspect(repoRoot: string): Promise<Stats | null> {
  try {
    return await stat(resolveJAgentDeskConfigPath(repoRoot));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function statJAgentDeskConfigPath(
  repoRoot: string,
): Promise<JAgentDeskConfigRevision | null> {
  const stats = await inspect(repoRoot);
  return stats ? revision(stats) : null;
}

function admit(stats: Stats): void {
  if (!stats.isFile() || stats.size > MAX_JAGENTDESK_CONFIG_BYTES) {
    throw new Error(
      `jagentdesk.json must be a regular file of at most ${MAX_JAGENTDESK_CONFIG_BYTES} bytes`,
    );
  }
}

function fingerprint(stats: Stats | null): string {
  return stats
    ? `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`
    : "missing";
}

// The record schema validates every script synchronously. Validate bounded groups
// through the same schemas so thousands of script entries do not monopolize a turn.
async function validateConfig(json: unknown): Promise<{
  edit: ReturnType<typeof JAgentDeskConfigRawSchema.safeParse>;
  runtime: JAgentDeskConfig;
}> {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    return {
      edit: JAgentDeskConfigRawSchema.safeParse(json),
      runtime: JAgentDeskConfigSchema.parse(json),
    };
  }
  const scripts = (json as Record<string, unknown>).scripts;
  if (scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) {
    return {
      edit: JAgentDeskConfigRawSchema.safeParse(json),
      runtime: JAgentDeskConfigSchema.parse(json),
    };
  }
  const withoutScripts = { ...json, scripts: {} };
  let edit = JAgentDeskConfigRawSchema.safeParse(withoutScripts);
  const runtime = JAgentDeskConfigSchema.parse(withoutScripts);
  const entries = Object.entries(scripts);
  if (entries.length > 32) await nextTurn();
  let lastYield = performance.now();
  for (let offset = 0; offset < entries.length; offset += 32) {
    const group = { scripts: Object.fromEntries(entries.slice(offset, offset + 32)) };
    if (edit.success) {
      const parsed = JAgentDeskConfigRawSchema.safeParse(group);
      if (parsed.success) Object.assign(edit.data.scripts!, parsed.data.scripts);
      else edit = parsed;
    }
    Object.assign(runtime.scripts!, JAgentDeskConfigSchema.parse(group).scripts);
    if (performance.now() - lastYield >= 2) {
      await nextTurn();
      lastYield = performance.now();
    }
  }
  return { edit, runtime };
}

interface Snapshot {
  fingerprint: string;
  edit: ReadJAgentDeskConfigForEditResult;
  runtime: ReadJAgentDeskConfigResult;
}

// How long a caller waits for the filesystem, including time queued behind other roots.
const READ_BUDGET_MS = 5_000;
// Above the roots a busy daemon lists: a listing that visits more roots than this evicts the next one it needs.
const MAX_SNAPSHOTS = 1_024;
const UNAVAILABLE = Symbol("project config unavailable");

/** Owns config admission, snapshots and daemon read/modify/write ordering for every consumer. */
class ProjectConfigOwner {
  // A stalled mount retains its slot until the OS returns; never consume the whole fs pool.
  private readonly filesystemOperations = pLimit(2);
  private readonly pendingAliases = new Map<string, Promise<string>>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly pending = new Map<
    string,
    { kind: "read" | "write"; promise: Promise<unknown> }
  >();

  async resolveRoot(repoRoot: string, activeRoots: Set<string>): Promise<string | null> {
    const root = resolve(repoRoot);
    if (activeRoots.has(root)) return root;
    let pending = this.pendingAliases.get(root);
    if (!pending) {
      pending = this.filesystemOperations(() => realpath(root)).finally(() =>
        this.pendingAliases.delete(root),
      );
      this.pendingAliases.set(root, pending);
    }
    try {
      const alias = await withTimeout(pending, 5_000, "Project root unavailable");
      return activeRoots.has(alias) ? alias : null;
    } catch {
      return null;
    }
  }

  private async serialized<T>(
    root: string,
    kind: "read" | "write",
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.pending.get(root);
    if (kind === "read" && previous?.kind === "read") return previous.promise as Promise<T>;
    const next = (async () => {
      await previous?.promise.catch(() => undefined);
      return this.filesystemOperations(operation);
    })();
    this.pending.set(root, { kind, promise: next });
    try {
      return await next;
    } finally {
      if (this.pending.get(root)?.promise === next) this.pending.delete(root);
    }
  }

  private remember(root: string, snapshot: Snapshot): Snapshot {
    this.snapshots.delete(root);
    this.snapshots.set(root, snapshot);
    // Worktrees come and go; retain only a bounded set of reusable snapshots.
    if (this.snapshots.size > MAX_SNAPSHOTS)
      this.snapshots.delete(this.snapshots.keys().next().value!);
    return snapshot;
  }

  async read(repoRoot: string): Promise<Snapshot> {
    const checked = await this.check(resolve(repoRoot));
    if (checked === UNAVAILABLE) throw new Error("Project config unavailable");
    return checked;
  }

  /** A check the filesystem does not answer in time answers the last config read for that root. */
  async readOrLastKnown(repoRoot: string): Promise<Snapshot> {
    const root = resolve(repoRoot);
    const checked = await this.check(root);
    if (checked !== UNAVAILABLE) return checked;
    const known = this.snapshots.get(root);
    if (!known) throw new Error("Project config unavailable");
    return known;
  }

  private async check(root: string): Promise<Snapshot | typeof UNAVAILABLE> {
    let budget: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.serialized(root, "read", () => this.load(root)),
        new Promise<typeof UNAVAILABLE>((settle) => {
          budget = setTimeout(settle, READ_BUDGET_MS, UNAVAILABLE);
        }),
      ]);
    } finally {
      clearTimeout(budget);
    }
  }

  private async load(root: string): Promise<Snapshot> {
    const stats = await inspect(root);
    if (stats) admit(stats);
    const key = fingerprint(stats);
    const cached = this.snapshots.get(root);
    if (cached?.fingerprint === key) return this.remember(root, cached);
    let json: unknown = null;
    if (stats) {
      // O_NONBLOCK prevents a regular-file -> FIFO replacement between stat and open
      // from waiting for a writer. Check the opened descriptor again before any read.
      const handle = await open(
        resolveJAgentDeskConfigPath(root),
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      try {
        const openedStats = await handle.stat();
        admit(openedStats);
        const bytes = Buffer.alloc(MAX_JAGENTDESK_CONFIG_BYTES + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        if (length > MAX_JAGENTDESK_CONFIG_BYTES)
          throw new Error("jagentdesk.json exceeds byte limit");
        // Never publish bytes under a revision that did not describe the opened file.
        if (fingerprint(await handle.stat()) !== fingerprint(openedStats)) {
          throw new Error("jagentdesk.json changed while reading; retry the operation");
        }
        try {
          json = JSON.parse(bytes.toString("utf8", 0, length));
        } catch (error) {
          return this.remember(root, {
            fingerprint: key,
            edit: { ok: false, error: { code: "invalid_project_config" } },
            runtime: { ok: false, configPath: resolveJAgentDeskConfigPath(root), error },
          });
        }
        if (fingerprint(openedStats) !== key) {
          throw new Error("jagentdesk.json was replaced while reading; retry the operation");
        }
      } finally {
        await handle.close();
      }
    }
    const validated = json === null ? null : await validateConfig(json);
    const parsed = validated?.edit ?? null;
    let edit: ReadJAgentDeskConfigForEditResult = { ok: true, config: null, revision: null };
    if (parsed !== null) {
      edit = parsed.success
        ? { ok: true, config: parsed.data, revision: stats ? revision(stats) : null }
        : { ok: false, error: { code: "invalid_project_config" } };
    }
    return this.remember(root, {
      fingerprint: key,
      edit,
      runtime: { ok: true, config: validated?.runtime ?? null },
    });
  }

  async write(
    input: WriteJAgentDeskConfigForEditInput,
  ): Promise<WriteJAgentDeskConfigForEditResult> {
    const root = resolve(input.repoRoot);
    return this.serialized(root, "write", async () => {
      const { edit: parsed, runtime } = await validateConfig(input.config);
      if (!parsed.success) return { ok: false, error: { code: "invalid_project_config" } };
      const content = `${JSON.stringify(parsed.data, null, 2)}\n`;
      if (Buffer.byteLength(content) > MAX_JAGENTDESK_CONFIG_BYTES) {
        return { ok: false, error: { code: "invalid_project_config" } };
      }
      const tempPath = join(
        root,
        `.${JAGENTDESK_CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        await writeFile(tempPath, content, { flag: "wx" });
        const savedStats = await stat(tempPath);
        const savedRevision = revision(savedStats);
        const currentStats = await inspect(root);
        if (currentStats) admit(currentStats);
        const currentRevision = currentStats ? revision(currentStats) : null;
        if (!jagentdeskConfigRevisionsEqual(currentRevision, input.expectedRevision)) {
          return { ok: false, error: { code: "stale_project_config", currentRevision } };
        }
        // Serialized against daemon edits. External writers still have the existing
        // optimistic stat/rename race; revision tokens remain mtime + size.
        await rename(tempPath, resolveJAgentDeskConfigPath(root));
        // Remember what was saved without another read, so a late check right after the save
        // still has a config to show. A rename that changes ctime only costs the next check a reload.
        this.remember(root, {
          fingerprint: fingerprint(savedStats),
          edit: { ok: true, config: parsed.data, revision: savedRevision },
          runtime: { ok: true, config: runtime },
        });
        return { ok: true, config: parsed.data, revision: savedRevision };
      } catch {
        return { ok: false, error: { code: "write_failed" } };
      } finally {
        await rm(tempPath, { force: true }).catch(() => undefined);
      }
    });
  }
}

const projectConfig = new ProjectConfigOwner();

export function resolveProjectConfigRoot(
  repoRoot: string,
  activeRoots: Set<string>,
): Promise<string | null> {
  return projectConfig.resolveRoot(repoRoot, activeRoots);
}

export async function readJAgentDeskConfig(repoRoot: string): Promise<ReadJAgentDeskConfigResult> {
  try {
    return (await projectConfig.read(repoRoot)).runtime;
  } catch (error) {
    return { ok: false, configPath: resolveJAgentDeskConfigPath(repoRoot), error };
  }
}

/**
 * For callers that show a config, such as workspace listings and script status: a slow filesystem
 * answers the last config read instead of none. Edits and execution use readJAgentDeskConfig.
 */
export async function readJAgentDeskConfigOrLastKnown(
  repoRoot: string,
): Promise<ReadJAgentDeskConfigResult> {
  try {
    return (await projectConfig.readOrLastKnown(repoRoot)).runtime;
  } catch (error) {
    return { ok: false, configPath: resolveJAgentDeskConfigPath(repoRoot), error };
  }
}

export async function readJAgentDeskConfigForEdit(
  repoRoot: string,
): Promise<ReadJAgentDeskConfigForEditResult> {
  try {
    return (await projectConfig.read(repoRoot)).edit;
  } catch {
    return { ok: false, error: { code: "invalid_project_config" } };
  }
}

export function writeJAgentDeskConfigForEdit(
  input: WriteJAgentDeskConfigForEditInput,
): Promise<WriteJAgentDeskConfigForEditResult> {
  return projectConfig.write(input);
}

function jagentdeskConfigRevisionsEqual(
  left: JAgentDeskConfigRevision | null,
  right: JAgentDeskConfigRevision | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}
