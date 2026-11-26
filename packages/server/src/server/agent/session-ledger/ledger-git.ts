import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

const GIT_TIMEOUT_MS = 10_000;
export const MAX_DIFF_CHARS = 20_000;

interface GitResult {
  code: number;
  stdout: string;
}

function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        if (!error) {
          resolve({ code: 0, stdout: String(stdout) });
          return;
        }
        const code =
          typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : -1;
        resolve({ code, stdout: String(stdout ?? "") });
      },
    );
  });
}

export interface LedgerGitBase {
  root: string;
  baseCommit: string;
}

/** The repository root and HEAD of `cwd`, or null when it is not a git checkout with a commit. */
export async function readLedgerGitBase(cwd: string): Promise<LedgerGitBase | null> {
  if (!existsSync(cwd)) return null;
  const root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0) return null;
  const head = await runGit(cwd, ["rev-parse", "HEAD"]);
  if (head.code !== 0) return null;
  return { root: root.stdout.trim(), baseCommit: head.stdout.trim() };
}

/** Resolves symlinks in the existing part of a path (macOS temp dirs live under /private). */
function resolveReal(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(resolveReal(parent), path.basename(target));
  }
}

function clampDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_CHARS) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS)}\n[…diff cut, ${diff.length} characters in full]`;
}

/**
 * Current diff of each file against the base commit, keyed by the path as given. Files git does
 * not track yet are diffed against /dev/null. Paths with no change are left out.
 */
export async function readLedgerFileDiffs(input: {
  cwd: string;
  base: LedgerGitBase;
  paths: readonly string[];
}): Promise<Map<string, string>> {
  const diffs = new Map<string, string>();
  for (const filePath of input.paths) {
    const absolute = resolveReal(
      path.isAbsolute(filePath) ? filePath : path.join(input.cwd, filePath),
    );
    const relative = path.relative(resolveReal(input.base.root), absolute);
    if (!relative || relative.startsWith("..")) continue;
    const tracked = await runGit(input.base.root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      input.base.baseCommit,
      "--",
      relative,
    ]);
    let diff = tracked.code === 0 ? tracked.stdout : "";
    if (!diff.trim() && existsSync(absolute)) {
      const known = await runGit(input.base.root, ["ls-files", "--error-unmatch", "--", relative]);
      if (known.code !== 0) {
        // `git diff --no-index` exits 1 when the files differ, which is the expected case here.
        const untracked = await runGit(input.base.root, [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-index",
          "--",
          "/dev/null",
          relative,
        ]);
        diff = untracked.code === 0 || untracked.code === 1 ? untracked.stdout : "";
      }
    }
    if (diff.trim()) diffs.set(filePath, clampDiff(diff.trimEnd()));
  }
  return diffs;
}
