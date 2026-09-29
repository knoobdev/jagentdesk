import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  SkillDirLabel,
  SkillEntry,
  SkillLink,
  SkillScope,
} from "@jagentdesk/protocol/native-skills";
import { hasScripts, listSkillFiles, lstatOrNull, realpathOrNull } from "./fs-utils.js";
import { parseSkillMarkdown, readSkillMetadata, splitLessons } from "./frontmatter.js";
import type { MovedSkillRecord, OwnedSkillRecord, SkillsLock } from "./lock-store.js";
import { buildSkillId, SKILL_DIR_SPECS, skillDirPath, visibleToFor } from "./paths.js";

export interface SkillLocation {
  scope: SkillScope;
  label: SkillDirLabel;
  /** Path of the directory entry inside the scanned directory. */
  path: string;
  isSymlink: boolean;
}

export interface ScanRoots {
  homeDir: string;
  /** Resolved project root, or null for a global-only scan. */
  projectRoot: string | null;
}

export interface SkillDirInfo {
  name: string | null;
  description: string;
  invalidReason: string | null;
  body: string;
  hasScripts: boolean;
}

export async function readSkillDir(dir: string): Promise<SkillDirInfo | null> {
  let content: string;
  try {
    content = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
  const parsed = parseSkillMarkdown(content);
  const meta = readSkillMetadata(parsed.frontmatter);
  return { ...meta, body: parsed.body, hasScripts: await hasScripts(dir) };
}

const contentHashCache = new Map<string, { key: string; hash: string }>();

/**
 * Spec 22.6.1: `sha256:<hex>` over SKILL.md + the sorted relative file list with
 * sizes — cheap enough to compare the copies of a family. Cached per real path
 * and keyed by the mtimes of the directory and its SKILL.md.
 */
export async function skillContentHash(dir: string): Promise<string | null> {
  const [dirStats, skillStats] = await Promise.all([
    lstatOrNull(dir),
    lstatOrNull(path.join(dir, "SKILL.md")),
  ]);
  if (!dirStats || !skillStats) return null;
  const key = `${dirStats.mtimeMs}:${skillStats.mtimeMs}:${skillStats.size}`;
  const cached = contentHashCache.get(dir);
  if (cached?.key === key) return cached.hash;
  let content: Buffer;
  try {
    content = await fs.readFile(path.join(dir, "SKILL.md"));
  } catch {
    return null;
  }
  const hash = createHash("sha256");
  hash.update(content);
  hash.update("\0");
  for (const file of await listSkillFiles(dir)) hash.update(`${file.path}\0${file.size}\n`);
  const value = `sha256:${hash.digest("hex")}`;
  contentHashCache.set(dir, { key, hash: value });
  return value;
}

function scopesFor(roots: ScanRoots): Array<{ scope: SkillScope; root: string }> {
  const scopes: Array<{ scope: SkillScope; root: string }> = [
    { scope: "global", root: roots.homeDir },
  ];
  if (roots.projectRoot && path.resolve(roots.projectRoot) !== path.resolve(roots.homeDir)) {
    scopes.push({ scope: "project", root: roots.projectRoot });
  }
  return scopes;
}

async function scanOneDir(
  scope: SkillScope,
  label: SkillDirLabel,
  dir: string,
): Promise<SkillLocation[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const locations: SkillLocation[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".")) continue;
    const entryPath = path.join(dir, name);
    const stats = await lstatOrNull(entryPath);
    if (!stats || !(stats.isDirectory() || stats.isSymbolicLink())) continue;
    locations.push({ scope, label, path: entryPath, isSymlink: stats.isSymbolicLink() });
  }
  return locations;
}

/** Every skill directory entry of spec 22.3, grouped by real directory. */
export async function scanLocations(roots: ScanRoots): Promise<Map<string, SkillLocation[]>> {
  const groups = new Map<string, SkillLocation[]>();
  for (const { scope, root } of scopesFor(roots)) {
    for (const spec of SKILL_DIR_SPECS) {
      const dir = skillDirPath(spec.label, scope, root);
      for (const location of await scanOneDir(scope, spec.label, dir)) {
        const real = await realpathOrNull(location.path);
        if (!real) continue;
        const realStats = await lstatOrNull(path.join(real, "SKILL.md"));
        if (!realStats) continue;
        const group = groups.get(real) ?? [];
        group.push(location);
        groups.set(real, group);
      }
    }
  }
  return groups;
}

function pickPrimary(locations: SkillLocation[], owned: OwnedSkillRecord | null): SkillLocation {
  const ownedPrimary = owned
    ? locations.find((location) => path.resolve(location.path) === path.resolve(owned.realPath))
    : undefined;
  return ownedPrimary ?? locations.find((location) => !location.isSymlink) ?? locations[0]!;
}

function trainingOf(record: OwnedSkillRecord, lessons: number): SkillEntry["training"] {
  const t = record.training;
  return {
    lessons,
    approvals: t.approvals,
    runs: t.runs,
    xp: t.xp,
    consecutiveApprovals: t.consecutiveApprovals,
    status: t.status,
  };
}

interface EntryInput {
  realPath: string;
  primary: SkillLocation;
  links: SkillLink[];
  labels: SkillDirLabel[];
  info: SkillDirInfo;
  contentHash: string | null;
  owned: OwnedSkillRecord | null;
  enabled: boolean;
  projectRoot: string | null;
}

function toEntry(input: EntryInput): SkillEntry {
  const { primary, info, owned } = input;
  const dirName = path.basename(primary.path);
  return {
    skillId: buildSkillId(primary.scope, primary.label, dirName),
    name: info.name ?? dirName,
    description: info.description,
    scope: primary.scope,
    projectRoot: primary.scope === "project" ? input.projectRoot : null,
    dir: primary.label,
    realPath: input.realPath,
    links: input.links,
    visibleTo: input.enabled ? visibleToFor(input.labels) : [],
    owned: owned !== null,
    enabled: input.enabled,
    status: info.invalidReason ? "invalid" : "ok",
    invalidReason: info.invalidReason,
    source: owned?.source ?? { kind: "local", ref: null, revision: null },
    hasScripts: info.hasScripts,
    contentHash: input.contentHash,
    training: owned ? trainingOf(owned, splitLessons(info.body).lessons.length) : null,
    legacyId: owned?.legacyId ?? null,
  };
}

async function findOwnedByRealPath(
  lock: SkillsLock,
  realPath: string,
): Promise<OwnedSkillRecord | null> {
  for (const record of lock.skills) {
    if (!record.enabled) continue;
    const resolved = (await realpathOrNull(record.realPath)) ?? path.resolve(record.realPath);
    if (resolved === realPath) return record;
  }
  return null;
}

function recordInScope(
  record: { scope: SkillScope; projectRoot: string | null },
  roots: ScanRoots,
): boolean {
  if (record.scope === "global") return true;
  return (
    roots.projectRoot !== null &&
    record.projectRoot !== null &&
    path.resolve(record.projectRoot) === path.resolve(roots.projectRoot)
  );
}

async function disabledOwnedEntry(record: OwnedSkillRecord): Promise<SkillEntry | null> {
  if (!record.disabledPath) return null;
  const info = await readSkillDir(record.disabledPath);
  if (!info) return null;
  return toEntry({
    realPath: record.disabledPath,
    primary: { scope: record.scope, label: "agents", path: record.realPath, isSymlink: false },
    links: [],
    labels: [],
    info,
    contentHash: await skillContentHash(record.disabledPath),
    owned: record,
    enabled: false,
    projectRoot: record.projectRoot,
  });
}

async function disabledForeignEntry(record: MovedSkillRecord): Promise<SkillEntry | null> {
  const primary = record.entries.find((entry) => entry.kind === "dir") ?? record.entries[0];
  if (!primary) return null;
  const info = (await readSkillDir(primary.backupPath)) ?? {
    name: record.name,
    description: record.description,
    invalidReason: null,
    body: "",
    hasScripts: false,
  };
  const entry = toEntry({
    realPath: primary.backupPath,
    primary: {
      scope: record.scope,
      label: primary.dir,
      path: primary.originalPath,
      isSymlink: false,
    },
    links: [],
    labels: [],
    info,
    contentHash: await skillContentHash(primary.backupPath),
    owned: null,
    enabled: false,
    projectRoot: record.projectRoot,
  });
  return { ...entry, skillId: record.skillId };
}

/** The Installed list (spec 22.3 / 22.4): scanned skills + disabled ones from the lock. */
export async function scanSkills(roots: ScanRoots, lock: SkillsLock): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = [];
  const groups = await scanLocations(roots);
  for (const [realPath, locations] of groups) {
    const info = await readSkillDir(realPath);
    if (!info) continue;
    const owned = await findOwnedByRealPath(lock, realPath);
    const primary = pickPrimary(locations, owned);
    const links = locations
      .filter((location) => location !== primary)
      .map((location) => ({ dir: location.label, path: location.path }));
    const labels = locations.map((location) => location.label);
    entries.push(
      toEntry({
        realPath,
        primary,
        links,
        labels,
        info,
        contentHash: await skillContentHash(realPath),
        owned,
        enabled: true,
        projectRoot: roots.projectRoot,
      }),
    );
  }
  for (const record of lock.skills) {
    if (record.enabled || !recordInScope(record, roots)) continue;
    const entry = await disabledOwnedEntry(record);
    if (entry) entries.push(entry);
  }
  for (const record of lock.disabled) {
    if (!recordInScope(record, roots)) continue;
    const entry = await disabledForeignEntry(record);
    if (entry) entries.push(entry);
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name) || a.skillId.localeCompare(b.skillId));
}
