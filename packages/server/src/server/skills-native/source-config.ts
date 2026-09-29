import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  OFFICIAL_SKILL_REPOS,
  SkillSourceSpecSchema,
  type SkillSourceSpec,
} from "@jagentdesk/protocol/native-skills";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { NativeSkillsError } from "./errors.js";
import { parseRemoteSource } from "./remote-sources.js";

/**
 * User-managed skill sources: `$JAGENTDESK_HOME/skills/sources.json`. A missing
 * file means the defaults (the official repositories, enabled). Removing a
 * default is remembered; adding it again restores it under the same id.
 */
const ConfiguredSourceSchema = z.object({
  sourceId: z.string(),
  spec: SkillSourceSpecSchema,
  label: z.string().nullable(),
  enabled: z.boolean(),
  added_at_ms: z.number(),
});
export type ConfiguredSource = z.infer<typeof ConfiguredSourceSchema>;

const SourcesFileSchema = z.object({
  version: z.literal(1),
  sources: z.array(ConfiguredSourceSchema),
});

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

export function officialSpecs(): Array<Extract<SkillSourceSpec, { kind: "github" }>> {
  return OFFICIAL_SKILL_REPOS.map((name) => {
    const [owner, repo] = name.split("/");
    return { kind: "github", owner: owner!, repo: repo!, ref: null, subpath: null };
  });
}

/** Identity of a source: equal for two inputs naming the same thing. */
export function canonicalSource(spec: SkillSourceSpec): string {
  switch (spec.kind) {
    case "github": {
      const ref = spec.ref ? `@${spec.ref}` : "";
      const sub = spec.subpath ? `/${spec.subpath}` : "";
      return `github:${spec.owner.toLowerCase()}/${spec.repo.toLowerCase()}${ref}${sub}`;
    }
    case "npm":
      return `npm:${spec.pkg}`;
    case "index":
      return `index:${spec.url}`;
    case "local":
      return `local:${spec.path}`;
  }
}

export function sourceIdFor(spec: SkillSourceSpec): string {
  return `src_${createHash("sha256").update(canonicalSource(spec)).digest("hex").slice(0, 12)}`;
}

/** Human label of a source (`owner/repo/path@ref`, package, index URL, directory). */
export function specLabel(spec: SkillSourceSpec): string {
  switch (spec.kind) {
    case "github": {
      const base = `${spec.owner}/${spec.repo}${spec.subpath ? `/${spec.subpath}` : ""}`;
      return spec.ref ? `${base}@${spec.ref}` : base;
    }
    case "npm":
      return spec.pkg;
    case "index":
      return spec.url;
    case "local":
      return spec.path;
  }
}

export function isBuiltinSource(spec: SkillSourceSpec): boolean {
  const canonical = canonicalSource(spec);
  return officialSpecs().some((official) => canonicalSource(official) === canonical);
}

function invalid(message: string): NativeSkillsError {
  return new NativeSkillsError("invalid_request", message);
}

function cleanSubpath(value: string | null): string | null {
  if (!value) return null;
  const parts = value.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (parts.includes("..")) throw invalid("A source path cannot contain '..'");
  return parts.join("/") || null;
}

function normalizeIndexUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid(`Not a URL: ${value}`);
  }
  if (url.protocol !== "https:") throw invalid("An index source must be an https URL");
  return url.toString();
}

/** Validate and normalize a spec; throws `invalid_request`. */
export function normalizeSpec(spec: SkillSourceSpec, homeDir: string): SkillSourceSpec {
  switch (spec.kind) {
    case "github": {
      const repo = spec.repo.replace(/\.git$/, "");
      if (!GITHUB_SEGMENT.test(spec.owner) || !GITHUB_SEGMENT.test(repo)) {
        throw invalid(`Not a GitHub repository: ${spec.owner}/${spec.repo}`);
      }
      // HEAD is the default branch, the same as no ref.
      const trimmed = spec.ref?.trim();
      const ref = trimmed && trimmed !== "HEAD" ? trimmed : null;
      return { kind: "github", owner: spec.owner, repo, ref, subpath: cleanSubpath(spec.subpath) };
    }
    case "npm":
      if (!NPM_NAME.test(spec.pkg)) throw invalid(`Not an npm package name: ${spec.pkg}`);
      return spec;
    case "index":
      return { kind: "index", url: normalizeIndexUrl(spec.url) };
    case "local": {
      const expanded = spec.path.startsWith("~/")
        ? path.join(homeDir, spec.path.slice(2))
        : spec.path;
      if (!path.isAbsolute(expanded)) throw invalid("A local source must be an absolute path");
      return { kind: "local", path: path.resolve(expanded) };
    }
  }
}

function looksLikeLocalPath(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * `owner/repo[/path]`, a github.com URL (incl. `/tree/<ref>/<path>`), `npm:<pkg>`,
 * `@scope/pkg`, an npmjs.com URL, an https index URL, or an absolute directory.
 */
export function parseSourceInput(input: string, homeDir: string): SkillSourceSpec {
  const value = input.trim();
  if (looksLikeLocalPath(value)) return normalizeSpec({ kind: "local", path: value }, homeDir);
  const remote = parseRemoteSource(value);
  if (remote) return normalizeSpec(remote, homeDir);
  if (/^https:\/\//i.test(value)) return normalizeSpec({ kind: "index", url: value }, homeDir);
  throw invalid(
    "Use a GitHub owner/repo[/path] or URL, an npm package, an https index URL, or an absolute directory",
  );
}

export class SkillSourcesStore {
  private sources: ConfiguredSource[] = [];
  private loaded = false;

  constructor(
    private readonly skillsHome: string,
    private readonly now: () => number,
  ) {}

  get filePath(): string {
    return path.join(this.skillsHome, "sources.json");
  }

  async list(): Promise<ConfiguredSource[]> {
    await this.load();
    return [...this.sources];
  }

  async find(sourceId: string): Promise<ConfiguredSource> {
    const source = (await this.list()).find((candidate) => candidate.sourceId === sourceId);
    if (!source) {
      throw new NativeSkillsError("source_not_found", `Unknown skill source: ${sourceId}`);
    }
    return source;
  }

  /** Add a source, or re-enable (and relabel) the same source added before. */
  async upsert(spec: SkillSourceSpec, label: string | null): Promise<ConfiguredSource> {
    await this.load();
    const sourceId = sourceIdFor(spec);
    const existing = this.sources.find((candidate) => candidate.sourceId === sourceId);
    if (existing) {
      existing.enabled = true;
      if (label !== null) existing.label = label;
    } else {
      this.sources.push({ sourceId, spec, label, enabled: true, added_at_ms: this.now() });
    }
    await this.save();
    return this.sources.find((candidate) => candidate.sourceId === sourceId)!;
  }

  async remove(sourceId: string): Promise<void> {
    await this.find(sourceId);
    this.sources = this.sources.filter((candidate) => candidate.sourceId !== sourceId);
    await this.save();
  }

  async setEnabled(sourceId: string, enabled: boolean): Promise<ConfiguredSource> {
    const source = await this.find(sourceId);
    const stored = this.sources.find((candidate) => candidate.sourceId === source.sourceId)!;
    stored.enabled = enabled;
    await this.save();
    return stored;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let raw: string | null = null;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      raw = null;
    }
    if (raw === null) {
      this.sources = this.defaults();
    } else {
      try {
        this.sources = SourcesFileSchema.parse(JSON.parse(raw)).sources;
      } catch (error) {
        throw invalid(`${this.filePath} is not a valid sources file: ${String(error)}`);
      }
    }
    this.loaded = true;
  }

  private defaults(): ConfiguredSource[] {
    return officialSpecs().map((spec) => ({
      sourceId: sourceIdFor(spec),
      spec,
      label: null,
      enabled: true,
      added_at_ms: 0,
    }));
  }

  private async save(): Promise<void> {
    await fs.mkdir(this.skillsHome, { recursive: true });
    await writeJsonFileAtomic(this.filePath, { version: 1, sources: this.sources });
  }
}
