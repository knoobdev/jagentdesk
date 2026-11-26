import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  LEARNED_RULES_HEADING,
  MAX_CITATIONS,
  MAX_EXCERPT_CHARS,
  type MemoryCitation,
} from "../shared/types.js";

/** Files above this size are not read to look for an excerpt; the citation counts as broken. */
const MAX_CITED_FILE_BYTES = 4 * 1024 * 1024;

export class LessonInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LessonInputError";
  }
}

/**
 * Cleans the citations an agent or the user gave: paths inside `root` become relative to it,
 * empty fields go, at most {@link MAX_CITATIONS}.
 */
export function normalizeCitations(
  citations: readonly MemoryCitation[] | undefined,
  root: string | null,
): MemoryCitation[] {
  const result: MemoryCitation[] = [];
  for (const citation of citations ?? []) {
    const raw = citation.path?.trim();
    if (!raw) continue;
    let citedPath = raw;
    if (root && path.isAbsolute(raw)) {
      const relative = path.relative(root, raw);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        citedPath = relative;
      }
    }
    const entry: MemoryCitation = { path: citedPath.split(path.sep).join("/") };
    const symbol = citation.symbol?.trim();
    if (symbol) entry.symbol = symbol.slice(0, 200);
    const excerpt = citation.excerpt?.trim();
    if (excerpt) entry.excerpt = excerpt.slice(0, MAX_EXCERPT_CHARS);
    if (!result.some((other) => sameCitation(other, entry))) result.push(entry);
    if (result.length >= MAX_CITATIONS) break;
  }
  return result;
}

function sameCitation(left: MemoryCitation, right: MemoryCitation): boolean {
  return left.path === right.path && left.symbol === right.symbol && left.excerpt === right.excerpt;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function resolveCitationPath(citation: MemoryCitation, root: string): string {
  return path.isAbsolute(citation.path) ? citation.path : path.join(root, citation.path);
}

/**
 * The deterministic check run before a lesson goes into a prompt (spec 42 §4): every cited file
 * still exists under `root`, and every excerpt still appears in its file (whitespace collapsed).
 * Returns null when the lesson holds, otherwise the reason it does not.
 */
export function checkCitations(citations: readonly MemoryCitation[], root: string): string | null {
  if (citations.length === 0) return "The lesson cites no file.";
  for (const citation of citations) {
    const absolute = resolveCitationPath(citation, root);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return `Cited file not found: ${citation.path}`;
    }
    if (!stat.isFile()) return `Cited path is not a file: ${citation.path}`;
    if (!citation.excerpt) continue;
    if (stat.size > MAX_CITED_FILE_BYTES)
      return `Cited file is too large to check: ${citation.path}`;
    const content = fs.readFileSync(absolute, "utf8");
    if (!collapseWhitespace(content).includes(collapseWhitespace(citation.excerpt))) {
      return `Cited text is no longer in ${citation.path}`;
    }
  }
  return null;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface RulesFileTarget {
  path: string;
  relativePath: string;
  exists: boolean;
  before: string;
}

/** AGENTS.md, or CLAUDE.md when the project only has that one; AGENTS.md is created otherwise. */
export function pickRulesFile(root: string): RulesFileTarget {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) {
      return {
        path: candidate,
        relativePath: name,
        exists: true,
        before: fs.readFileSync(candidate, "utf8"),
      };
    }
  }
  return {
    path: path.join(root, "AGENTS.md"),
    relativePath: "AGENTS.md",
    exists: false,
    before: "",
  };
}

function ruleLine(text: string, citations: readonly MemoryCitation[]): string {
  const rule = collapseWhitespace(text);
  const sources = citations.map((citation) => `\`${citation.path}\``);
  return sources.length > 0 ? `- ${rule} (see ${sources.join(", ")})` : `- ${rule}`;
}

/**
 * The rules file with the lesson added as a bullet at the end of its `## Learned rules` section;
 * the section is appended when the file has none.
 */
export function addLearnedRule(
  before: string,
  text: string,
  citations: readonly MemoryCitation[],
): string {
  const line = ruleLine(text, citations);
  const lines = before.length > 0 ? before.replace(/\n$/, "").split("\n") : [];
  const headingIndex = lines.findIndex((entry) => entry.trim() === LEARNED_RULES_HEADING);
  if (headingIndex < 0) {
    const prefix = lines.length > 0 ? [...lines, ""] : [];
    return [...prefix, LEARNED_RULES_HEADING, "", line, ""].join("\n");
  }
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,2}\s/.test(lines[index])) {
      end = index;
      break;
    }
  }
  // Insert after the section's last non-blank line.
  let insertAt = end;
  while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === "") insertAt -= 1;
  const next = [...lines];
  next.splice(insertAt, 0, line);
  if (insertAt === headingIndex + 1) next.splice(insertAt, 0, "");
  return `${next.join("\n")}\n`;
}

/**
 * A unified diff for an edit that only inserts lines (all `addLearnedRule` does), with three
 * lines of context. Good enough for a review sheet; Changes shows git's own diff after apply.
 */
export function insertionDiff(relativePath: string, before: string, after: string): string {
  const oldLines = before.length > 0 ? before.replace(/\n$/, "").split("\n") : [];
  const newLines = after.replace(/\n$/, "").split("\n");
  let start = 0;
  while (start < oldLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  const contextStart = Math.max(0, start - 3);
  const contextEnd = Math.min(oldLines.length, oldEnd + 3);
  const body: string[] = [];
  for (let index = contextStart; index < start; index += 1) body.push(` ${oldLines[index]}`);
  for (let index = start; index < oldEnd; index += 1) body.push(`-${oldLines[index]}`);
  for (let index = start; index < newEnd; index += 1) body.push(`+${newLines[index]}`);
  for (let index = oldEnd; index < contextEnd; index += 1) body.push(` ${oldLines[index]}`);
  const oldCount = contextEnd - contextStart;
  const newCount = oldCount - (oldEnd - start) + (newEnd - start);
  const oldStart = oldCount === 0 ? 0 : contextStart + 1;
  return [
    before.length > 0 ? `--- a/${relativePath}` : "--- /dev/null",
    `+++ b/${relativePath}`,
    `@@ -${oldStart},${oldCount} +${contextStart + 1},${newCount} @@`,
    ...body,
  ].join("\n");
}
