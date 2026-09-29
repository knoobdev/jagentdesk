import {
  SKILL_DIR_LABELS,
  SKILL_PROVIDER_ORDER,
  type SkillEntry,
  type SkillScope,
} from "@jagentdesk/protocol/native-skills";
import {
  matchesInstalledFilters,
  type InstalledSkillFilters,
  type SkillProviderId,
} from "@/skills/native-skill-logic";

/**
 * Skill families (spec 22.6.1). Different real directories with the same skill
 * name in the same scope (e.g. copies in `~/.agents/skills` and
 * `~/.claude/skills` made by different installers) are one family: the
 * Installed tab and the composer picker show one row per family.
 */
export interface SkillFamily {
  /** `<scope>:<project root>:<name>` — stable React key. */
  key: string;
  name: string;
  scope: SkillScope;
  projectRoot: string | null;
  /** The copy whose name/description represent the family. */
  primary: SkillEntry;
  /** Every copy, primary first, then in primary-rule order. */
  copies: SkillEntry[];
  /** Union of the copies' `visibleTo`, in provider display order. */
  visibleTo: string[];
  /** Copies report different `contentHash` values ("Copies differ"). */
  contentDiffers: boolean;
}

export function skillFamilyKey(entry: Pick<SkillEntry, "scope" | "projectRoot" | "name">): string {
  return `${entry.scope}:${entry.projectRoot ?? ""}:${entry.name}`;
}

function dirRank(entry: SkillEntry): number {
  const index = entry.dir ? SKILL_DIR_LABELS.indexOf(entry.dir) : -1;
  return index === -1 ? SKILL_DIR_LABELS.length : index;
}

/**
 * Primary-copy order (spec 22.6.1): the copy JAgentDesk owns, else the one in
 * `agents`, then `claude`, then the 22.3 table order (`SKILL_DIR_LABELS`).
 */
export function comparePrimaryCopies(a: SkillEntry, b: SkillEntry): number {
  if (a.owned !== b.owned) return a.owned ? -1 : 1;
  return dirRank(a) - dirRank(b) || a.skillId.localeCompare(b.skillId);
}

export function pickPrimaryCopy(copies: readonly SkillEntry[]): SkillEntry {
  return [...copies].sort(comparePrimaryCopies)[0]!;
}

/** Union of providers, known ones in display order, unknown ones appended. */
export function unionVisibleTo(copies: readonly SkillEntry[]): string[] {
  const seen = new Set(copies.flatMap((copy) => copy.visibleTo));
  const known = SKILL_PROVIDER_ORDER.filter((provider) => seen.has(provider));
  const extra = Array.from(seen).filter(
    (provider) => !(SKILL_PROVIDER_ORDER as readonly string[]).includes(provider),
  );
  return [...known, ...extra];
}

/** True when at least two copies report a hash and the hashes differ. */
export function copiesDiffer(copies: readonly SkillEntry[]): boolean {
  const hashes = new Set(
    copies.map((copy) => copy.contentHash).filter((hash): hash is string => Boolean(hash)),
  );
  return hashes.size > 1;
}

function toFamily(key: string, copies: SkillEntry[]): SkillFamily {
  const ordered = [...copies].sort(comparePrimaryCopies);
  const primary = ordered[0]!;
  return {
    key,
    name: primary.name,
    scope: primary.scope,
    projectRoot: primary.projectRoot,
    primary,
    copies: ordered,
    visibleTo: unionVisibleTo(ordered),
    contentDiffers: copiesDiffer(ordered),
  };
}

/** Group entries into families; project families first, then by name. */
export function groupSkillFamilies(entries: readonly SkillEntry[]): SkillFamily[] {
  const groups = new Map<string, SkillEntry[]>();
  for (const entry of entries) {
    const key = skillFamilyKey(entry);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  return Array.from(groups, ([key, copies]) => toFamily(key, copies)).sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    return a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  });
}

/** Installed tab: a family is listed (with all its copies) when any copy matches. */
export function filterSkillFamilies(
  families: readonly SkillFamily[],
  filters: InstalledSkillFilters,
): SkillFamily[] {
  return families.filter((family) =>
    family.copies.some((copy) => matchesInstalledFilters(copy, filters)),
  );
}

// ── Composer picker (spec 22.6.1 + 22.7) ─────────────────────────────────────
function isUsable(entry: SkillEntry): boolean {
  return entry.enabled && entry.status === "ok";
}

export interface PickerFamilyChoice {
  family: SkillFamily;
  /** Copy whose `skillId` is sent: the primary, or the copy the provider sees. */
  copy: SkillEntry;
  /** No usable copy is visible to the provider: offer "Install for <provider>". */
  needsInstall: boolean;
}

/**
 * One picker choice per family of usable (enabled, valid) copies. With a known
 * provider the first visible copy in primary order is chosen; when none is
 * visible the primary is offered for install. Without a provider (generic ACP)
 * the primary is used.
 */
export function pickerFamilyChoices(
  entries: readonly SkillEntry[],
  provider: SkillProviderId | null,
): PickerFamilyChoice[] {
  const families = groupSkillFamilies(entries.filter(isUsable));
  return families.map((family) => {
    if (!provider) return { family, copy: family.primary, needsInstall: false };
    const visible = family.copies.find((copy) => copy.visibleTo.includes(provider));
    return visible
      ? { family, copy: visible, needsInstall: false }
      : { family, copy: family.primary, needsInstall: true };
  });
}

/**
 * Toggle a family in the agent's attachments: when any copy of the family is
 * attached, every copy is detached; otherwise `skillId` is attached.
 */
export function toggleFamilyAttachment(
  attachedIds: readonly string[],
  skillId: string,
  familyIds: readonly string[],
): string[] {
  const family = new Set([skillId, ...familyIds]);
  const attached = attachedIds.some((id) => family.has(id));
  return attached
    ? attachedIds.filter((id) => !family.has(id))
    : Array.from(new Set([...attachedIds, skillId]));
}
