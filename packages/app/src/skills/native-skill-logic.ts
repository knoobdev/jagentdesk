import {
  SKILL_PROVIDER_ORDER,
  type SkillCatalogItem,
  type SkillEntry,
  type SkillScope,
  type SkillSourceInfo,
  type SkillSourceRef,
  type SkillTraining,
} from "@jagentdesk/protocol/native-skills";

/**
 * Pure helpers behind the native Skills UI (spec 22.6–22.9, ADR-0022). Kept free
 * of React and stores so the filtering, picker, legacy-id and training rules are
 * unit-testable and shared by the Skills screen, the composer picker and the
 * in-conversation train bar.
 */

export type SkillProviderId = (typeof SKILL_PROVIDER_ORDER)[number];

/** Product names of the providers that read skill directories (spec 22.3). */
export const SKILL_PROVIDER_LABELS: Record<SkillProviderId, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  copilot: "Copilot",
  pi: "Pi",
  omp: "Oh My Pi",
  kimi: "Kimi",
  kiro: "Kiro",
};

export function isSkillProvider(provider: string): provider is SkillProviderId {
  return (SKILL_PROVIDER_ORDER as readonly string[]).includes(provider);
}

export function skillProviderLabel(provider: string): string {
  return isSkillProvider(provider) ? SKILL_PROVIDER_LABELS[provider] : provider;
}

/**
 * The provider whose skill directories an agent reads: built-in ids map to
 * themselves; a custom provider maps to the provider it `extends` (daemon
 * config). Anything else (generic ACP, unknown) returns null — the app then
 * does not filter by visibility and the daemon falls back to the sentence form.
 */
export function resolveSkillProvider(
  provider: string | null | undefined,
  providersConfig?: Record<string, unknown> | null,
): SkillProviderId | null {
  if (!provider) return null;
  if (isSkillProvider(provider)) return provider;
  const config = providersConfig?.[provider];
  const base =
    config && typeof config === "object" ? (config as { extends?: unknown }).extends : undefined;
  return typeof base === "string" && isSkillProvider(base) ? base : null;
}

// ── Installed tab filters (spec 22.6) ────────────────────────────────────────
export type SkillOwnershipFilter = "all" | "owned" | "external";
export type SkillScopeFilter = "all" | SkillScope;

export interface InstalledSkillFilters {
  /** "all" or a provider id: keep skills that provider can see. */
  provider: string;
  scope: SkillScopeFilter;
  /** "all" or a `SkillSourceInfo.kind`. */
  source: string;
  ownership: SkillOwnershipFilter;
  query: string;
}

export const DEFAULT_INSTALLED_FILTERS: InstalledSkillFilters = {
  provider: "all",
  scope: "all",
  source: "all",
  ownership: "all",
  query: "",
};

function matchesQuery(entry: SkillEntry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    entry.name.toLowerCase().includes(needle) || entry.description.toLowerCase().includes(needle)
  );
}

function matchesOwnership(entry: SkillEntry, ownership: SkillOwnershipFilter): boolean {
  if (ownership === "all") return true;
  return ownership === "owned" ? entry.owned : !entry.owned;
}

export function matchesInstalledFilters(
  entry: SkillEntry,
  filters: InstalledSkillFilters,
): boolean {
  if (filters.provider !== "all" && !entry.visibleTo.includes(filters.provider)) return false;
  if (filters.scope !== "all" && entry.scope !== filters.scope) return false;
  if (filters.source !== "all" && entry.source.kind !== filters.source) return false;
  if (!matchesOwnership(entry, filters.ownership)) return false;
  return matchesQuery(entry, filters.query);
}

/** Stable display order: project skills first, then by name, then by id. */
export function sortSkillEntries(entries: readonly SkillEntry[]): SkillEntry[] {
  return [...entries].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    return a.name.localeCompare(b.name) || a.skillId.localeCompare(b.skillId);
  });
}

export function filterInstalledSkills(
  entries: readonly SkillEntry[],
  filters: InstalledSkillFilters,
): SkillEntry[] {
  return sortSkillEntries(entries.filter((entry) => matchesInstalledFilters(entry, filters)));
}

/** Source kinds present in the list, for the Source filter chips. */
export function presentSourceKinds(entries: readonly SkillEntry[]): string[] {
  return Array.from(new Set(entries.map((entry) => entry.source.kind))).sort();
}

/** Providers that can see at least one listed skill, in spec display order. */
export function presentProviders(entries: readonly SkillEntry[]): SkillProviderId[] {
  const seen = new Set(entries.flatMap((entry) => entry.visibleTo));
  return SKILL_PROVIDER_ORDER.filter((provider) => seen.has(provider));
}

// ── Composer picker (spec 22.7) ──────────────────────────────────────────────
export interface PickerSkillPartition {
  /** Enabled, valid skills the agent's provider reads — attachable. */
  available: SkillEntry[];
  /** Enabled, valid skills the provider cannot see — offer "Install for <provider>". */
  needsInstall: SkillEntry[];
}

function isUsable(entry: SkillEntry): boolean {
  return entry.enabled && entry.status === "ok";
}

export function partitionSkillsForProvider(
  entries: readonly SkillEntry[],
  provider: SkillProviderId | null,
): PickerSkillPartition {
  const available: SkillEntry[] = [];
  const needsInstall: SkillEntry[] = [];
  for (const entry of sortSkillEntries(entries)) {
    if (!isUsable(entry)) continue;
    if (!provider || entry.visibleTo.includes(provider)) {
      available.push(entry);
    } else {
      needsInstall.push(entry);
    }
  }
  return { available, needsInstall };
}

/** Merge several catalogs (global + per-project lists) keeping the first entry per id. */
export function dedupeSkillEntries(lists: ReadonlyArray<readonly SkillEntry[]>): SkillEntry[] {
  const byId = new Map<string, SkillEntry>();
  for (const list of lists) {
    for (const entry of list) {
      if (!byId.has(entry.skillId)) byId.set(entry.skillId, entry);
    }
  }
  return Array.from(byId.values());
}

// ── Legacy ids (spec 22.10 migration) ────────────────────────────────────────
/** legacy JSON skill id → native skillId, from the migrated entries' `legacyId`. */
export function buildLegacyIdMap(entries: readonly SkillEntry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.legacyId) map[entry.legacyId] = entry.skillId;
  }
  return map;
}

/** Rewrite stored attachment ids to native skillIds; unknown ids are kept, order kept, deduped. */
export function normalizeSkillIds(
  ids: readonly string[],
  legacyMap: Readonly<Record<string, string>>,
): string[] {
  return Array.from(new Set(ids.map((id) => legacyMap[id] ?? id)));
}

// ── Turn skills (spec 22.7: the daemon adds the invocation) ─────────────────
export interface TurnSkillInput {
  attachedIds: readonly string[];
  matchedIds: readonly string[];
  /** Skills already invoked on an earlier turn of this agent. */
  alreadySentIds: readonly string[];
}

/**
 * Skill ids to pass on this send: attached ∪ auto-matched, minus the ones the
 * agent already received. A skill is invoked once per agent conversation — the
 * provider keeps it loaded afterwards.
 */
export function selectTurnSkillIds(input: TurnSkillInput): string[] {
  const sent = new Set(input.alreadySentIds);
  return Array.from(new Set([...input.attachedIds, ...input.matchedIds])).filter(
    (id) => !sent.has(id),
  );
}

// ── Training (spec 22.9) ─────────────────────────────────────────────────────
const MAX_LESSON_LENGTH = 160;

/**
 * The lesson proposed from an agent reply: its first sentence, one line, capped.
 * Deterministic text heuristic — no model call (spec 22.11 #9).
 */
export function conciseLessonFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const firstSentence = clean.split(/(?<=[.!?])\s/)[0] ?? clean;
  return firstSentence.length > MAX_LESSON_LENGTH
    ? `${firstSentence.slice(0, MAX_LESSON_LENGTH - 1)}…`
    : firstSentence;
}

export interface TrainingChecklistItem {
  id: "approvals" | "approvalRate" | "streak";
  have: number;
  need: number;
  done: boolean;
}

export function trainingApprovalRate(training: SkillTraining): number {
  return training.runs > 0 ? training.approvals / training.runs : 0;
}

/** Graduation checklist derived from the lock training state (same thresholds as before). */
export function trainingChecklist(training: SkillTraining): {
  items: TrainingChecklistItem[];
  canGraduate: boolean;
} {
  const rate = trainingApprovalRate(training);
  const items: TrainingChecklistItem[] = [
    { id: "approvals", have: training.approvals, need: 6, done: training.approvals >= 6 },
    {
      id: "approvalRate",
      have: Math.round(rate * 100),
      need: 80,
      done: training.runs >= 5 && rate >= 0.8,
    },
    {
      id: "streak",
      have: training.consecutiveApprovals,
      need: 3,
      done: training.consecutiveApprovals >= 3,
    },
  ];
  return { items, canGraduate: items.every((item) => item.done) };
}

// ── Browse tab (spec 22.5) ───────────────────────────────────────────────────
export type BrowseSourceKind = "official" | "provider-marketplace" | "url";

/**
 * The `SourceRef` for the Browse picker. `option` narrows Official to one repo
 * and Provider marketplaces to one provider ("all" = every one). A Link source
 * needs a non-empty link; null means "nothing to browse yet".
 */
export function buildBrowseSource(
  kind: BrowseSourceKind,
  option: string,
  link: string,
): SkillSourceRef | null {
  if (kind === "url") {
    const url = link.trim();
    return url ? { kind: "url", url } : null;
  }
  if (kind === "official") {
    return option === "all" ? { kind: "official" } : { kind: "official", repo: option };
  }
  if (option === "claude" || option === "codex") {
    return { kind: "provider-marketplace", provider: option };
  }
  return { kind: "provider-marketplace" };
}

/** Client-side search over a browsed source (the daemon's `query` is the same substring match). */
export function filterCatalogItems(
  items: readonly SkillCatalogItem[],
  query: string,
): SkillCatalogItem[] {
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? items.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) ||
          item.description.toLowerCase().includes(needle) ||
          item.origin.toLowerCase().includes(needle),
      )
    : [...items];
  return matching.sort((a, b) => a.name.localeCompare(b.name) || a.itemId.localeCompare(b.itemId));
}

/** Files under `scripts/` are code the agent can run — highlighted before install (spec 22.8). */
export function isScriptPath(path: string): boolean {
  return path === "scripts" || path.startsWith("scripts/");
}

// ── Errors ───────────────────────────────────────────────────────────────────
/** The `rpc_error` code carried by a rejected native-skills request, if any. */
export function skillErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Human message of a rejected request without the client's `requestType=… code=…` suffix. */
export function skillErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+requestType=\S+/, "").replace(/\s+code=\S+/, "");
}

// ── Display helpers ──────────────────────────────────────────────────────────
export function shortRevision(revision: string | null): string | null {
  if (!revision) return null;
  return /^[0-9a-f]{12,}$/i.test(revision) ? revision.slice(0, 7) : revision;
}

/** "anthropics/skills @ 1a2b3c4", "authored", … */
export function formatSkillSource(source: SkillSourceInfo): string {
  const parts: string[] = [source.ref ?? source.kind];
  const rev = shortRevision(source.revision);
  if (rev) parts.push(`@ ${rev}`);
  return parts.join(" ");
}

export interface SkillProjectOption {
  /** Project root path, passed as `cwd` to the skills RPCs. */
  path: string;
  label: string;
}

/** One option per project root among the host's workspaces, sorted by label. */
export function projectOptionsFromWorkspaces(
  workspaces: Iterable<{
    projectRootPath: string;
    projectDisplayName: string;
    projectCustomName?: string | null;
  }>,
): SkillProjectOption[] {
  const byPath = new Map<string, string>();
  for (const workspace of workspaces) {
    const path = workspace.projectRootPath;
    if (!path || byPath.has(path)) continue;
    byPath.set(path, workspace.projectCustomName || workspace.projectDisplayName || path);
  }
  return Array.from(byPath, ([path, label]) => ({ path, label })).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}
