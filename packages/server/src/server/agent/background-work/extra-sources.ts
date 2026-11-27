import { lstat, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, normalize, resolve, sep } from "node:path";
import type { AgentTimelineRow } from "../agent-timeline-store-types.js";
import { parseBackgroundCommand, parseReadCommand } from "./command-parse.js";
import type { BackgroundWorkOutputFile, BackgroundWorkOutputSource } from "./index.js";
import { isInsideOutputRoots, openVerifiedOutputFile } from "./output-stream.js";

/**
 * ADR-0064: the extra output sources of one background item, taken from its own command — the
 * files the command redirects its output to and the script it runs — and the agent's latest
 * read of a redirect file, taken from the agent's own timeline. No path ever comes from a
 * client: every path here is re-derived from the command on each request.
 */

/** ADR-0064 §2: the most of a script shown. */
export const SCRIPT_MAX_BYTES = 64 * 1024;
/** The most of one recorded read shown. */
export const LAST_READ_MAX_CHARS = 64 * 1024;

export const PROVIDER_SOURCE_ID = "provider";
export const SCRIPT_SOURCE_ID = "script";
const REDIRECT_SOURCE_PREFIX = "redirect:";

/** `/var/folders/<x>/<y>/T`, macOS's per-user temp folder. */
const MAC_USER_TEMP = /^(?:\/private)?\/var\/folders\/[^/]+\/[^/]+\/T(?=\/)/;

export interface ExtraSourceContext {
  command: string | undefined;
  /** The folder the work runs in, when the provider reports it. Relative paths start here. */
  workCwd: string | null;
  /** The agent's own folder (cwd/worktree); files inside it are allowed. */
  agentCwd: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  /** Replaces the system temp folders; tests use it to keep a folder outside every root. */
  tempRoots?: readonly string[];
}

export interface PlannedFile {
  path: string;
  roots: readonly string[];
}

export interface PlannedRedirect extends PlannedFile {
  id: string;
  label: string;
}

export interface ExtraSourcePlan {
  redirects: PlannedRedirect[];
  script: PlannedFile | null;
}

/**
 * The redirect targets and script of a command that pass the path rules: inside the agent's
 * folder or a system temp folder, and not a secret. Whether the file is a regular file that
 * stays inside after symlinks is checked when it is opened.
 */
export function planExtraSources(context: ExtraSourceContext): ExtraSourcePlan {
  if (!context.command) return { redirects: [], script: null };
  const env = context.env ?? process.env;
  const home = context.home ?? homedir();
  const parsed = parseBackgroundCommand(context.command, {
    cwd: context.workCwd ?? context.agentCwd,
    home,
  });
  const redirects: PlannedRedirect[] = [];
  const rootsOf = (path: string) =>
    allowedRoots(path, context.agentCwd, context.tempRoots ?? systemTempRoots(env, path));
  parsed.redirects.forEach((path, index) => {
    const roots = rootsOf(path);
    if (!roots) return;
    redirects.push({ id: REDIRECT_SOURCE_PREFIX + index, label: basename(path), path, roots });
  });
  let script: PlannedFile | null = null;
  if (parsed.script) {
    const roots = rootsOf(parsed.script);
    if (roots) script = { path: parsed.script, roots };
  }
  return { redirects, script };
}

/** The folders a path may resolve into, or null when the path is not allowed at all. */
export function allowedRoots(
  path: string,
  agentCwd: string | null,
  tempRoots: readonly string[] = systemTempRoots(process.env, path),
): string[] | null {
  if (!isAbsolute(path) || normalize(path) !== path) return null;
  if (isBlockedSecretPath(path)) return null;
  const roots = [...tempRoots];
  if (agentCwd && isAbsolute(agentCwd) && normalize(agentCwd) !== sep) roots.push(agentCwd);
  const unique = [...new Set(roots.map(trimSeparator))];
  return unique.some((root) => path.startsWith(root + sep)) ? unique : null;
}

/** `$TMPDIR`, `/tmp`, `/private/tmp`, and the `/var/folders/…/T` folder `path` is in, if any. */
export function systemTempRoots(
  env: Readonly<Record<string, string | undefined>> = process.env,
  path?: string,
): string[] {
  const macTemp = path ? MAC_USER_TEMP.exec(path)?.[0] : undefined;
  return [tmpdir(), env.TMPDIR, "/tmp", "/private/tmp", macTemp].filter(
    (root): root is string => typeof root === "string" && isAbsolute(root) && root !== sep,
  );
}

function trimSeparator(path: string): string {
  return path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
}

const SECRET_FOLDERS = new Set([".ssh", ".aws", ".gnupg", "Keychains"]);

/**
 * ADR-0064 §1's blocked secrets: `.env*`, `*.pem`, `*.key`, `id_*`, anything under `.ssh/`,
 * `.aws/`, `.config/gh/`, and keychains. `.gnupg/` and `.netrc` are refused as well.
 */
export function isBlockedSecretPath(path: string): boolean {
  const segments = path.split(sep).filter(Boolean);
  const name = segments.at(-1) ?? "";
  if (/^\.env/i.test(name) || /\.(?:pem|key)$/i.test(name) || name.startsWith("id_")) return true;
  if (name === ".netrc" || /\.keychain(?:-db)?$/i.test(name)) return true;
  return segments.some(
    (segment, index) =>
      SECRET_FOLDERS.has(segment) ||
      /^\.env/i.test(segment) ||
      (segment === "gh" && segments[index - 1] === ".config"),
  );
}

/** One planned redirect file's state for the detail; null when it exists but may not be read. */
export async function describeRedirect(
  redirect: PlannedRedirect,
): Promise<{ exists: boolean; size: number; modifiedAt: string | null } | null> {
  try {
    await lstat(redirect.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { exists: false, size: 0, modifiedAt: null };
    return null;
  }
  const file = redirectFile(redirect);
  if (!(await isInsideOutputRoots(file))) return null;
  const info = await stat(redirect.path).catch(() => null);
  if (!info?.isFile()) return null;
  return { exists: true, size: info.size, modifiedAt: info.mtime.toISOString() };
}

function redirectFile(planned: PlannedFile): BackgroundWorkOutputFile {
  return { path: planned.path, roots: planned.roots, refuse: isBlockedSecretPath };
}

/** The output source for one redirect file; it waits for the file while the work runs. */
export function redirectOutputSource(
  redirect: PlannedRedirect,
  isRunning: () => boolean,
): BackgroundWorkOutputSource {
  const file = redirectFile(redirect);
  return { type: "file", locate: async () => file, waitWhile: isRunning };
}

export interface ScriptContent {
  path: string;
  label: string;
  content: string;
  truncated: boolean;
  lineCount: number;
}

/** The first 64 KiB of the script, or null when it is missing, refused or not text. */
export async function readScript(script: PlannedFile): Promise<ScriptContent | null> {
  let handle: Awaited<ReturnType<typeof openVerifiedOutputFile>>;
  try {
    handle = await openVerifiedOutputFile(redirectFile(script));
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(SCRIPT_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, Math.min(bytesRead, SCRIPT_MAX_BYTES));
    // A binary is not a script to show.
    if (bytes.includes(0)) return null;
    const content = bytes.toString("utf8");
    return {
      path: script.path,
      label: basename(script.path),
      content,
      truncated: bytesRead > SCRIPT_MAX_BYTES,
      lineCount: countLines(content),
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const breaks = text.split("\n").length - 1;
  return text.endsWith("\n") ? breaks : breaks + 1;
}

export interface LastRead {
  at: string;
  content: string;
  truncated: boolean;
}

/**
 * ADR-0064 §3: the latest read of each redirect file by the agent after the work started — a
 * `cat`/`tail`/`head`/`less` shell call or the provider's read-file tool — from the agent's own
 * timeline. Nothing is read from disk here.
 */
export function findLastReads(input: {
  rows: readonly AgentTimelineRow[];
  startedAt: string;
  redirects: readonly PlannedRedirect[];
  agentCwd: string | null;
  home?: string;
}): Map<string, LastRead> {
  const reads = new Map<string, LastRead>();
  if (input.redirects.length === 0) return reads;
  const byPath = new Map(input.redirects.map((redirect) => [redirect.path, redirect.id]));
  const startedAtMs = Date.parse(input.startedAt);
  const home = input.home ?? homedir();
  for (const row of input.rows) {
    const item = row.item;
    if (item.type !== "tool_call" || (item.status !== "completed" && item.status !== "failed"))
      continue;
    const atMs = Date.parse(row.timestamp);
    if (Number.isFinite(startedAtMs) && Number.isFinite(atMs) && atMs < startedAtMs) continue;
    const detail = item.detail;
    let paths: string[] = [];
    let content: string | undefined;
    if (detail.type === "shell") {
      paths = parseReadCommand(detail.command, { cwd: detail.cwd ?? input.agentCwd, home });
      content = detail.output;
    } else if (detail.type === "read") {
      const path = resolveReadPath(detail.filePath, input.agentCwd);
      if (path) paths = [path];
      content = detail.content;
    }
    if (content === undefined) continue;
    for (const path of paths) {
      const id = byPath.get(path);
      if (!id) continue;
      const truncated = content.length > LAST_READ_MAX_CHARS;
      reads.set(id, {
        at: row.timestamp,
        content: truncated ? content.slice(0, LAST_READ_MAX_CHARS) : content,
        truncated,
      });
    }
  }
  return reads;
}

function resolveReadPath(filePath: string, cwd: string | null): string | null {
  if (isAbsolute(filePath)) return normalize(filePath);
  return cwd ? resolve(cwd, filePath) : null;
}
