import {
  isValidSkillName,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
} from "@jagentdesk/protocol/native-skills";

/**
 * A small reader for the YAML frontmatter of SKILL.md. It covers what Agent
 * Skills use in practice — scalars (plain / quoted), folded and literal block
 * scalars, one level of nested map (`metadata:`) and simple lists — without
 * pulling a YAML dependency into the daemon. Frontmatter JAgentDesk writes only
 * ever contains the standard keys `name` and `description`.
 */
export type FrontmatterValue = string | string[] | Record<string, string>;

export interface ParsedSkillMarkdown {
  frontmatter: Record<string, FrontmatterValue> | null;
  /** Text after the closing `---` (the whole file when there is no frontmatter). */
  body: string;
}

export const LESSONS_MARKER = "<!-- jagentdesk:lessons -->";
const LESSONS_HEADING = "## Learned lessons";

function splitFrontmatterBlock(content: string): { yaml: string[]; body: string } | null {
  const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return null;
  return { yaml: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function collectIndented(lines: string[], start: number): { block: string[]; next: number } {
  const block: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() !== "" && indentOf(line) === 0) break;
    block.push(line);
    index += 1;
  }
  while (block.length > 0 && block[block.length - 1]?.trim() === "") block.pop();
  return { block, next: index };
}

function blockScalar(indicator: string, block: string[]): string {
  const minIndent = Math.min(...block.filter((l) => l.trim() !== "").map(indentOf));
  const stripped = block.map((line) => line.slice(Number.isFinite(minIndent) ? minIndent : 0));
  if (indicator.startsWith("|")) return stripped.join("\n").trimEnd();
  return stripped
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, " ").trim())
    .join("\n")
    .trim();
}

function nestedValue(block: string[]): FrontmatterValue {
  const meaningful = block.filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  if (meaningful.length > 0 && meaningful.every((line) => line.trim().startsWith("- "))) {
    return meaningful.map((line) => unquote(line.trim().slice(2)));
  }
  const map: Record<string, string> = {};
  for (const line of meaningful) {
    const trimmed = line.trim();
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    map[trimmed.slice(0, colon).trim()] = unquote(trimmed.slice(colon + 1));
  }
  return map;
}

function inlineValue(raw: string, block: string[]): FrontmatterValue {
  const value = raw.trim();
  if (/^[|>][+-]?\d*$/.test(value)) return blockScalar(value, block);
  if (value === "") return block.length > 0 ? nestedValue(block) : "";
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => unquote(item))
      .filter((item) => item.length > 0);
  }
  if (block.length > 0 && !value.startsWith('"') && !value.startsWith("'")) {
    return [value, ...block.map((line) => line.trim())].filter(Boolean).join(" ");
  }
  return unquote(value);
}

function parseYamlLines(lines: string[]): Record<string, FrontmatterValue> {
  const result: Record<string, FrontmatterValue> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    index += 1;
    if (line.trim() === "" || line.trim().startsWith("#") || indentOf(line) > 0) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const { block, next } = collectIndented(lines, index);
    index = next;
    result[key] = inlineValue(line.slice(colon + 1), block);
  }
  return result;
}

export function parseSkillMarkdown(content: string): ParsedSkillMarkdown {
  const split = splitFrontmatterBlock(content);
  if (!split) {
    return { frontmatter: null, body: content };
  }
  return { frontmatter: parseYamlLines(split.yaml), body: split.body };
}

export interface SkillMetadata {
  name: string | null;
  description: string;
  invalidReason: string | null;
}

/** Validate the standard keys. Invalid skills are still listed (spec 22.3). */
export function readSkillMetadata(
  frontmatter: Record<string, FrontmatterValue> | null,
): SkillMetadata {
  if (!frontmatter) {
    return { name: null, description: "", invalidReason: "SKILL.md has no frontmatter" };
  }
  const rawName = frontmatter["name"];
  const rawDescription = frontmatter["description"];
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : null;
  const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
  let invalidReason: string | null = null;
  if (!name) {
    invalidReason = "Missing name";
  } else if (!isValidSkillName(name)) {
    invalidReason = `Invalid name: use lowercase letters, digits and hyphens (max ${SKILL_NAME_MAX_LENGTH})`;
  } else if (!description) {
    invalidReason = "Missing description";
  } else if (description.length > SKILL_DESCRIPTION_MAX_LENGTH) {
    invalidReason = `Description longer than ${SKILL_DESCRIPTION_MAX_LENGTH} characters`;
  }
  return { name, description, invalidReason };
}

/** SKILL.md as JAgentDesk writes it: standard keys only (ADR-0022 decision 1). */
export function renderSkillMarkdown(input: {
  name: string;
  description: string;
  body: string;
}): string {
  const description = input.description.replace(/\s+/g, " ").trim();
  const body = input.body.replace(/\r\n/g, "\n").replace(/^\n+/, "").trimEnd();
  return `---\nname: ${input.name}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}

/** Rewrite only the `name:` line of an existing SKILL.md (used by install-with-rename). */
export function replaceFrontmatterName(content: string, name: string): string {
  const split = splitFrontmatterBlock(content);
  if (!split) {
    return `---\nname: ${name}\n---\n\n${content}`;
  }
  const hasName = split.yaml.some((line) => /^name\s*:/.test(line));
  const yaml = hasName
    ? split.yaml.map((line) => (/^name\s*:/.test(line) ? `name: ${name}` : line))
    : [`name: ${name}`, ...split.yaml];
  return `---\n${yaml.join("\n")}\n---\n${split.body}`;
}

export interface SplitLessons {
  instructions: string;
  lessons: string[];
}

/** Separate the instructions from the `<!-- jagentdesk:lessons -->` section. */
export function splitLessons(body: string): SplitLessons {
  const markerIndex = body.indexOf(LESSONS_MARKER);
  if (markerIndex === -1) {
    return { instructions: body.trim(), lessons: [] };
  }
  const section = body.slice(markerIndex + LESSONS_MARKER.length);
  const lessons = section
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
  return { instructions: body.slice(0, markerIndex).trim(), lessons };
}

export function normalizeLesson(lesson: string): string {
  return lesson.replace(/\s*\n\s*/g, " ").trim();
}

/** Append one approved lesson; the frontmatter and instructions are left byte-identical. */
export function appendLesson(content: string, lesson: string): string {
  const line = `- ${normalizeLesson(lesson)}`;
  const trimmed = content.replace(/\s+$/, "");
  if (!content.includes(LESSONS_MARKER)) {
    return `${trimmed}\n\n${LESSONS_MARKER}\n${LESSONS_HEADING}\n\n${line}\n`;
  }
  return `${trimmed}\n${line}\n`;
}

/** Instructions + lessons section, for rewriting a skill body while keeping its lessons. */
export function composeBody(instructions: string, lessons: readonly string[]): string {
  const base = instructions.trim();
  if (lessons.length === 0) return base;
  const lines = lessons.map((lesson) => `- ${normalizeLesson(lesson)}`).join("\n");
  return `${base}\n\n${LESSONS_MARKER}\n${LESSONS_HEADING}\n\n${lines}`;
}

/** Slug a free-form legacy skill name into an Agent Skills name. */
export function slugifySkillName(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SKILL_NAME_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "skill";
}
