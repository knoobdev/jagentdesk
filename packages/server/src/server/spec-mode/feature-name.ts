import { readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Feature directory names for agents that share a checkout (spec 28.3 step 5): the daemon
 * picks `specs/<NNN>-<short-name>` before Specify runs so each agent gets its own directory.
 * Mirrors spec-kit's `create-new-feature.sh` (`generate_branch_name` + sequential numbering).
 */

// create-new-feature.sh `generate_branch_name` stop words.
const STOP_WORDS = new Set(
  "i a an the to for of in on at by with from is are was were be been being have has had do does did will would should could can may might must shall this that these those my your our their want need add get set".split(
    " ",
  ),
);

function hasNonAscii(word: string): boolean {
  return [...word].some((char) => (char.codePointAt(0) ?? 0) > 0x7f);
}

export function featureShortName(description: string): string {
  const words = description
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  const originalUpper = new Set(
    description.split(/[^\p{L}\p{N}]+/u).filter((w) => /^[A-Z0-9]+$/.test(w)),
  );
  const meaningful = words.filter((word) => {
    if (STOP_WORDS.has(word)) return false;
    if (word.length >= 3 || hasNonAscii(word)) return true;
    return originalUpper.has(word.toUpperCase());
  });
  if (meaningful.length > 0) {
    const maxWords = meaningful.length === 4 ? 4 : 3;
    return meaningful.slice(0, maxWords).join("-");
  }
  const fallback = words.slice(0, 3).join("-");
  return fallback || "feature";
}

function featureNumber(name: string): number | null {
  const match = /^(\d{3,})-/.exec(name);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

/** Next sequential `specs/NNN-<name>` not used on disk nor reserved by another agent. */
export async function nextFeatureDirectory(params: {
  cwd: string;
  description: string;
  reserved: readonly string[];
}): Promise<string> {
  let names: string[] = [];
  try {
    const entries = await readdir(path.join(params.cwd, "specs"), { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const used = [...names, ...params.reserved.map((dir) => path.posix.basename(dir))]
    .map(featureNumber)
    .filter((value): value is number => value !== null);
  const next = (used.length > 0 ? Math.max(...used) : 0) + 1;
  return `specs/${String(next).padStart(3, "0")}-${featureShortName(params.description)}`;
}
