import { z } from "zod";

/**
 * Native multi-provider skills (spec 22, ADR-0022).
 *
 * A skill is a standard Agent Skills directory `<name>/SKILL.md`. The daemon
 * scans the provider skill directories (22.3), installs owned skills as one real
 * directory under `.agents/skills` plus symlinks into `.claude/skills` and
 * `.kiro/skills`, and records everything it wrote in
 * `$JAGENTDESK_HOME/skills/lock.json`. Every operation goes through these RPCs so
 * desktop and mobile behave the same.
 *
 * Errors are reported as `rpc_error` with one of {@link NATIVE_SKILLS_ERROR_CODES}.
 */

/** Directory labels of spec 22.3, in scan order. */
export const SKILL_DIR_LABELS = [
  "agents",
  "claude",
  "kiro",
  "codex",
  "opencode",
  "copilot",
  "cursor",
  "pi",
  "omp",
  "kimi",
] as const;
export const SkillDirLabelSchema = z.enum(SKILL_DIR_LABELS);
export type SkillDirLabel = z.infer<typeof SkillDirLabelSchema>;

/** Provider ids that read skill directories, in display order. */
export const SKILL_PROVIDER_ORDER = [
  "claude",
  "codex",
  "opencode",
  "cursor",
  "copilot",
  "pi",
  "omp",
  "kimi",
  "kiro",
] as const;

export const SkillScopeSchema = z.enum(["global", "project"]);
export type SkillScope = z.infer<typeof SkillScopeSchema>;

export const NATIVE_SKILLS_ERROR_CODES = [
  "skill_name_conflict",
  "skill_not_found",
  "skill_not_owned",
  "confirmation_required",
  "invalid_skill",
  "invalid_request",
  "path_not_allowed",
  "source_fetch_failed",
  "catalog_item_not_found",
  "source_not_found",
] as const;
export type NativeSkillsErrorCode = (typeof NATIVE_SKILLS_ERROR_CODES)[number];

export const SkillLinkSchema = z.object({
  dir: SkillDirLabelSchema,
  path: z.string(),
});
export type SkillLink = z.infer<typeof SkillLinkSchema>;

export const SkillSourceKindSchema = z.enum([
  "github",
  "npm",
  "authored",
  "migrated",
  "fork",
  "local",
  "provider-runtime",
]);

export const SkillSourceInfoSchema = z.object({
  kind: SkillSourceKindSchema,
  ref: z.string().nullable(),
  revision: z.string().nullable(),
});
export type SkillSourceInfo = z.infer<typeof SkillSourceInfoSchema>;

/** Training progress of an owned skill (XP rules are the ones of `skills.ts`). */
export const SkillTrainingSchema = z.object({
  lessons: z.number(),
  approvals: z.number(),
  runs: z.number(),
  xp: z.number(),
  consecutiveApprovals: z.number(),
  status: z.enum(["training", "graduated"]),
});
export type SkillTraining = z.infer<typeof SkillTrainingSchema>;

export const SkillEntrySchema = z.object({
  /** `<scope>:<dir label>:<directory name>`, e.g. `global:agents:frontend-design`. */
  skillId: z.string(),
  name: z.string(),
  description: z.string(),
  scope: SkillScopeSchema,
  /** Project root the entry was scanned from (`project` scope only). */
  projectRoot: z.string().nullable(),
  /** Directory label of the primary location (where `skillId` points). */
  dir: SkillDirLabelSchema.nullable(),
  realPath: z.string(),
  links: z.array(SkillLinkSchema),
  visibleTo: z.array(z.string()),
  owned: z.boolean(),
  enabled: z.boolean(),
  status: z.enum(["ok", "invalid"]),
  invalidReason: z.string().nullable(),
  source: SkillSourceInfoSchema,
  hasScripts: z.boolean(),
  /**
   * `sha256:<hex>` over SKILL.md + the sorted relative file list with sizes;
   * compares copies of a family (spec 22.6.1). Optional for older daemons.
   */
  contentHash: z.string().nullable().optional(),
  training: SkillTrainingSchema.nullable(),
  /** Id of the legacy JSON skill this was migrated from (COMPAT(nativeSkills)). */
  legacyId: z.string().nullable(),
});
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

export const SkillFileSchema = z.object({
  path: z.string(),
  size: z.number(),
  isScript: z.boolean(),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;

export const OFFICIAL_SKILL_REPOS = ["anthropics/skills", "openai/skills"] as const;

/**
 * A user-managed skill source (`$JAGENTDESK_HOME/skills/sources.json`). Listing
 * reads metadata only; installing downloads only the chosen skill's files
 * (npm: the package tarball, npm has no per-file API).
 *
 * - `github`: a repository, optionally at `ref` and restricted to `subpath`.
 *   Listed with one tree API call + the SKILL.md files from
 *   raw.githubusercontent.com, pinned to the resolved commit.
 * - `npm`: a package; listed from registry metadata + the jsDelivr file list.
 * - `index`: an https URL to a JSON file matching {@link SkillsIndexFileSchema}.
 * - `local`: an absolute directory on the daemon host holding skill folders.
 */
export const SkillSourceSpecSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("github"),
    owner: z.string().min(1),
    repo: z.string().min(1),
    ref: z.string().nullable(),
    subpath: z.string().nullable(),
  }),
  z.object({ kind: z.literal("npm"), pkg: z.string().min(1) }),
  z.object({ kind: z.literal("index"), url: z.string().min(1) }),
  z.object({ kind: z.literal("local"), path: z.string().min(1) }),
]);
export type SkillSourceSpec = z.infer<typeof SkillSourceSpecSchema>;

/**
 * Format of an `index` source: a JSON file served over https.
 *
 * ```json
 * { "skills": [
 *   { "name": "pdf", "description": "Work with PDFs.", "source": "anthropics/skills",
 *     "path": "skills/pdf" },
 *   { "name": "lint", "description": "Lint code.", "source": "npm:@scope/skill-pack",
 *     "path": "skills/lint" } ] }
 * ```
 *
 * `source` uses the same syntax as adding a source (`owner/repo`, a github.com
 * URL incl. `/tree/<ref>/<path>`, `npm:<package>`, `@scope/package`); `path` is
 * the skill directory inside it (default: the source root). Listing reads the
 * index only; the skill's files are fetched from `source` when installing.
 */
export const SkillsIndexFileSchema = z.object({
  skills: z.array(
    z.object({
      name: z.string().min(1),
      description: z.string(),
      source: z.string().min(1),
      path: z.string().optional(),
    }),
  ),
});
export type SkillsIndexFile = z.infer<typeof SkillsIndexFileSchema>;

/**
 * A searchable directory behind an `index` source whose host has an adapter
 * (ADR-0023). Directories have no full listing: they are searched page by page.
 */
export const SkillDirectoryStatusSchema = z.object({
  provider: z.literal("skillsmp"),
  /** An API key is stored on the daemon (the key itself is never sent to apps). */
  hasApiKey: z.boolean(),
  /** From the last search response's rate-limit headers; null before the first search. */
  quota: z
    .object({
      limit: z.number().nullable(),
      remaining: z.number().nullable(),
      resetAtMs: z.number().nullable(),
    })
    .nullable(),
});
export type SkillDirectoryStatus = z.infer<typeof SkillDirectoryStatusSchema>;

/** A configured source with its listing status. */
export const SkillSourceStatusSchema = z.object({
  /** Stable id derived from the source (`src_<hex>`); re-adding a source keeps it. */
  sourceId: z.string(),
  spec: SkillSourceSpecSchema,
  /** Custom label, or a label derived from the source. */
  label: z.string(),
  customLabel: z.string().nullable(),
  /** One of the default sources (the official repositories). */
  builtin: z.boolean(),
  enabled: z.boolean(),
  addedAtMs: z.number(),
  /** Last successful listing, null when never listed. */
  lastRefreshMs: z.number().nullable(),
  itemCount: z.number().nullable(),
  revision: z.string().nullable(),
  /** Last listing failure (cleared by the next success). */
  error: z.string().nullable(),
  /** Set when the source is a searchable directory (ADR-0023). */
  directory: SkillDirectoryStatusSchema.nullable().optional(),
});
export type SkillSourceStatus = z.infer<typeof SkillSourceStatusSchema>;

export const SkillSourceRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("official"), repo: z.string().optional() }),
  z.object({ kind: z.literal("url"), url: z.string().min(1) }),
  /** A source from `skills.sources.list` (items of a merged browse carry it). */
  z.object({ kind: z.literal("configured"), sourceId: z.string().min(1) }),
  z.object({
    kind: z.literal("provider-marketplace"),
    provider: z.enum(["claude", "codex"]).optional(),
    marketplace: z.string().optional(),
  }),
  z.object({ kind: z.literal("local"), cwd: z.string().optional() }),
]);
export type SkillSourceRef = z.infer<typeof SkillSourceRefSchema>;

export const SkillCatalogItemSchema = z.object({
  /** Skill: repo-relative directory. Plugin: `<plugin>@<marketplace>`. Local: skillId. */
  itemId: z.string(),
  kind: z.enum(["skill", "plugin"]),
  name: z.string(),
  description: z.string(),
  source: SkillSourceRefSchema,
  /** Human label of where the item comes from (`anthropics/skills`, marketplace name…). */
  origin: z.string(),
  revision: z.string().nullable(),
  files: z.array(z.string()),
  hasScripts: z.boolean(),
  /** SKILL.md body (after frontmatter) for skill items; null for plugins. */
  body: z.string().nullable(),
  provider: z.string().nullable(),
  category: z.string().nullable(),
  /** Command the daemon runs to install a provider plugin (shown to the user). */
  installCommand: z.array(z.string()).nullable(),
  installed: z.boolean(),
  installedSkillId: z.string().nullable(),
  invalidReason: z.string().nullable(),
  /** Configured source the item comes from (null for official/url/local/plugin browses). */
  sourceId: z.string().nullable().optional(),
  sourceLabel: z.string().nullable().optional(),
  /**
   * A directory search result (ADR-0023): `files`, `body` and `hasScripts` are not
   * known yet; browse `source` (a `url` ref) to read them before installing.
   */
  metadataOnly: z.boolean().optional(),
  /** Popularity reported by a directory (GitHub stars), when known. */
  stars: z.number().nullable().optional(),
});
export type SkillCatalogItem = z.infer<typeof SkillCatalogItemSchema>;

export const SkillCatalogItemRefSchema = z.object({
  source: SkillSourceRefSchema,
  itemId: z.string().min(1),
});
export type SkillCatalogItemRef = z.infer<typeof SkillCatalogItemRefSchema>;

export const SkillPluginInstallResultSchema = z.object({
  provider: z.string(),
  command: z.array(z.string()),
  cwd: z.string().nullable(),
  ok: z.boolean(),
  exitCode: z.number().nullable(),
  stdout: z.string(),
  stderr: z.string(),
});
export type SkillPluginInstallResult = z.infer<typeof SkillPluginInstallResultSchema>;

/** Absolute paths JAgentDesk wrote (ADR-0022 decision 3: shown in Settings/Skills). */
export const SkillWrittenPathsSchema = z.object({
  lockPath: z.string(),
  paths: z.array(z.string()),
});
export type SkillWrittenPaths = z.infer<typeof SkillWrittenPathsSchema>;

// ── Requests ─────────────────────────────────────────────────────────────────
const cwdField = z.string().optional();

export const SkillsCatalogListRequestSchema = z.object({
  type: z.literal("skills.catalog.list.request"),
  requestId: z.string(),
  cwd: cwdField,
});
export const SkillsCatalogGetRequestSchema = z.object({
  type: z.literal("skills.catalog.get.request"),
  requestId: z.string(),
  skillId: z.string(),
  /** Needed to resolve a non-owned `project` skill. */
  cwd: cwdField,
});
export const SkillsSourcesBrowseRequestSchema = z.object({
  type: z.literal("skills.sources.browse.request"),
  requestId: z.string(),
  /**
   * What to browse. Omitted: the configured sources — `sourceId` alone, or
   * every enabled one merged (deduplicated by source + skill path).
   */
  source: SkillSourceRefSchema.optional(),
  sourceId: z.string().optional(),
  query: z.string().optional(),
  /** Result page of a directory search (from 1; ADR-0023). */
  page: z.number().int().min(1).optional(),
  /** Bypass the 10-minute list cache. */
  refresh: z.boolean().optional(),
});
export const SkillsSourcesListRequestSchema = z.object({
  type: z.literal("skills.sources.list.request"),
  requestId: z.string(),
});
export const SkillsSourcesAddRequestSchema = z.object({
  type: z.literal("skills.sources.add.request"),
  requestId: z.string(),
  /**
   * `owner/repo[/path]`, a github.com URL (incl. `/tree/<ref>/<path>`),
   * `npm:<package>` / `@scope/package` / an npmjs.com URL, an https URL to an
   * index JSON, an absolute directory path — or an explicit spec.
   */
  source: z.union([z.string().min(1), SkillSourceSpecSchema]),
  label: z.string().optional(),
});
export const SkillsSourcesRemoveRequestSchema = z.object({
  type: z.literal("skills.sources.remove.request"),
  requestId: z.string(),
  sourceId: z.string(),
});
export const SkillsSourcesSetEnabledRequestSchema = z.object({
  type: z.literal("skills.sources.set_enabled.request"),
  requestId: z.string(),
  sourceId: z.string(),
  enabled: z.boolean(),
});
/** Store (string) or clear (null) a directory source's API key (ADR-0023). */
export const SkillsSourcesSetApiKeyRequestSchema = z.object({
  type: z.literal("skills.sources.set_api_key.request"),
  requestId: z.string(),
  sourceId: z.string(),
  apiKey: z.string().min(1).nullable(),
});
export const SkillsInstallRequestSchema = z.object({
  type: z.literal("skills.install.request"),
  requestId: z.string(),
  item: SkillCatalogItemRefSchema,
  scope: SkillScopeSchema,
  cwd: cwdField,
  rename: z.string().optional(),
});
export const SkillsUninstallRequestSchema = z.object({
  type: z.literal("skills.uninstall.request"),
  requestId: z.string(),
  skillId: z.string(),
  cwd: cwdField,
  /** Required to remove a skill JAgentDesk does not own (it is backed up first). */
  confirm: z.boolean().optional(),
});
export const SkillsSetEnabledRequestSchema = z.object({
  type: z.literal("skills.set_enabled.request"),
  requestId: z.string(),
  skillId: z.string(),
  enabled: z.boolean(),
  cwd: cwdField,
  /** Required to disable a skill JAgentDesk does not own. */
  confirm: z.boolean().optional(),
});
export const SkillsAuthorRequestSchema = z.object({
  type: z.literal("skills.author.request"),
  requestId: z.string(),
  skillId: z.string().optional(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  scope: SkillScopeSchema,
  cwd: cwdField,
});
export const SkillsLearnRequestSchema = z.object({
  type: z.literal("skills.learn.request"),
  requestId: z.string(),
  skillId: z.string(),
  lesson: z.string(),
  approved: z.boolean(),
  agentId: z.string().optional(),
  cwd: cwdField,
});
export const SkillsForkRequestSchema = z.object({
  type: z.literal("skills.fork.request"),
  requestId: z.string(),
  skillId: z.string(),
  name: z.string().optional(),
  cwd: cwdField,
});

// ── Responses ────────────────────────────────────────────────────────────────
export const SkillsCatalogListResponseSchema = z.object({
  type: z.literal("skills.catalog.list.response"),
  payload: z.object({
    requestId: z.string(),
    skills: z.array(SkillEntrySchema),
    written: SkillWrittenPathsSchema,
  }),
});
export const SkillsCatalogGetResponseSchema = z.object({
  type: z.literal("skills.catalog.get.response"),
  payload: z.object({
    requestId: z.string(),
    skill: SkillEntrySchema,
    files: z.array(SkillFileSchema),
    body: z.string(),
  }),
});
export const SkillsSourcesBrowseResponseSchema = z.object({
  type: z.literal("skills.sources.browse.response"),
  payload: z.object({
    requestId: z.string(),
    items: z.array(SkillCatalogItemSchema),
    /** A directory search has another page (ADR-0023). */
    hasMore: z.boolean().optional(),
  }),
});
export const SkillsSourcesListResponseSchema = z.object({
  type: z.literal("skills.sources.list.response"),
  payload: z.object({ requestId: z.string(), sources: z.array(SkillSourceStatusSchema) }),
});
export const SkillsSourcesAddResponseSchema = z.object({
  type: z.literal("skills.sources.add.response"),
  payload: z.object({ requestId: z.string(), source: SkillSourceStatusSchema }),
});
export const SkillsSourcesRemoveResponseSchema = z.object({
  type: z.literal("skills.sources.remove.response"),
  payload: z.object({ requestId: z.string(), sourceId: z.string() }),
});
export const SkillsSourcesSetApiKeyResponseSchema = z.object({
  type: z.literal("skills.sources.set_api_key.response"),
  payload: z.object({ requestId: z.string(), source: SkillSourceStatusSchema }),
});
export const SkillsSourcesSetEnabledResponseSchema = z.object({
  type: z.literal("skills.sources.set_enabled.response"),
  payload: z.object({ requestId: z.string(), source: SkillSourceStatusSchema }),
});
export const SkillsInstallResponseSchema = z.object({
  type: z.literal("skills.install.response"),
  payload: z.object({
    requestId: z.string(),
    /** The installed skill; null for a provider plugin install. */
    skill: SkillEntrySchema.nullable(),
    plugin: SkillPluginInstallResultSchema.nullable(),
  }),
});
export const SkillsUninstallResponseSchema = z.object({
  type: z.literal("skills.uninstall.response"),
  payload: z.object({
    requestId: z.string(),
    removed: z.array(z.string()),
    /** Backup location of a removed non-owned skill. */
    backupPath: z.string().nullable(),
  }),
});
function skillResponse<const Type extends string>(type: Type) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), skill: SkillEntrySchema }),
  });
}
export const SkillsSetEnabledResponseSchema = skillResponse("skills.set_enabled.response");
export const SkillsAuthorResponseSchema = skillResponse("skills.author.response");
export const SkillsLearnResponseSchema = skillResponse("skills.learn.response");
export const SkillsForkResponseSchema = skillResponse("skills.fork.response");

export type SkillsCatalogListRequest = z.infer<typeof SkillsCatalogListRequestSchema>;
export type SkillsCatalogGetRequest = z.infer<typeof SkillsCatalogGetRequestSchema>;
export type SkillsSourcesBrowseRequest = z.infer<typeof SkillsSourcesBrowseRequestSchema>;
export type SkillsSourcesListRequest = z.infer<typeof SkillsSourcesListRequestSchema>;
export type SkillsSourcesAddRequest = z.infer<typeof SkillsSourcesAddRequestSchema>;
export type SkillsSourcesRemoveRequest = z.infer<typeof SkillsSourcesRemoveRequestSchema>;
export type SkillsSourcesSetEnabledRequest = z.infer<typeof SkillsSourcesSetEnabledRequestSchema>;
export type SkillsSourcesSetApiKeyRequest = z.infer<typeof SkillsSourcesSetApiKeyRequestSchema>;
export type SkillsInstallRequest = z.infer<typeof SkillsInstallRequestSchema>;
export type SkillsUninstallRequest = z.infer<typeof SkillsUninstallRequestSchema>;
export type SkillsSetEnabledRequest = z.infer<typeof SkillsSetEnabledRequestSchema>;
export type SkillsAuthorRequest = z.infer<typeof SkillsAuthorRequestSchema>;
export type SkillsLearnRequest = z.infer<typeof SkillsLearnRequestSchema>;
export type SkillsForkRequest = z.infer<typeof SkillsForkRequestSchema>;

export const NativeSkillsRequestSchemas = [
  SkillsCatalogListRequestSchema,
  SkillsCatalogGetRequestSchema,
  SkillsSourcesBrowseRequestSchema,
  SkillsSourcesListRequestSchema,
  SkillsSourcesAddRequestSchema,
  SkillsSourcesRemoveRequestSchema,
  SkillsSourcesSetEnabledRequestSchema,
  SkillsSourcesSetApiKeyRequestSchema,
  SkillsInstallRequestSchema,
  SkillsUninstallRequestSchema,
  SkillsSetEnabledRequestSchema,
  SkillsAuthorRequestSchema,
  SkillsLearnRequestSchema,
  SkillsForkRequestSchema,
] as const;

export const NativeSkillsResponseSchemas = [
  SkillsCatalogListResponseSchema,
  SkillsCatalogGetResponseSchema,
  SkillsSourcesBrowseResponseSchema,
  SkillsSourcesListResponseSchema,
  SkillsSourcesAddResponseSchema,
  SkillsSourcesRemoveResponseSchema,
  SkillsSourcesSetEnabledResponseSchema,
  SkillsSourcesSetApiKeyResponseSchema,
  SkillsInstallResponseSchema,
  SkillsUninstallResponseSchema,
  SkillsSetEnabledResponseSchema,
  SkillsAuthorResponseSchema,
  SkillsLearnResponseSchema,
  SkillsForkResponseSchema,
] as const;

// ── Invocation (spec 22.7) ───────────────────────────────────────────────────
export type SkillInvocationStyle = "slash" | "dollar" | "skill-colon" | "sentence";

const INVOCATION_STYLE_BY_PROVIDER: Record<string, SkillInvocationStyle> = {
  claude: "slash",
  cursor: "slash",
  copilot: "slash",
  kiro: "slash",
  codex: "dollar",
  pi: "skill-colon",
  omp: "skill-colon",
  kimi: "skill-colon",
  opencode: "sentence",
};

/** OpenCode and generic ACP providers have no verified invocation syntax. */
export function skillInvocationStyle(provider: string): SkillInvocationStyle {
  return INVOCATION_STYLE_BY_PROVIDER[provider] ?? "sentence";
}

export function formatSkillInvocation(provider: string, name: string): string {
  switch (skillInvocationStyle(provider)) {
    case "slash":
      return `/${name}`;
    case "dollar":
      return `$${name}`;
    case "skill-colon":
      return `/skill:${name}`;
    default:
      return `Use the skill \`${name}\`.`;
  }
}

function skillList(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(", ");
}

// Verified live (2026-09-29): a plain "Also use the skill" line did not make Claude load the skill
// body, while "Before you answer, load … with the Skill tool" did. Providers without a named
// skill tool get the same request without the tool name.
function loadSkillsSentence(provider: string, names: readonly string[]): string {
  const noun = names.length === 1 ? "this skill" : "these skills";
  const tool = provider === "claude" ? " with the Skill tool" : "";
  return `Before you answer, load ${noun}${tool}: ${skillList(names)}.`;
}

/**
 * The text the daemon prefixes to a turn for the attached skills, or "" when
 * none (spec 22.7).
 *
 * - Leading-command providers (`/name`, `/skill:name`) only expand the FIRST
 *   leading command — a second `/other` becomes argument text. The first skill
 *   is invoked natively and the rest follow on a new line:
 *   `Before you answer, load these skills: \`b\`, \`c\`.` (Claude adds
 *   "with the Skill tool").
 * - Codex expands several `$name` on one line.
 * - Text providers get one sentence for every skill.
 */
export function buildSkillInvocationLine(provider: string, names: readonly string[]): string {
  const unique = Array.from(new Set(names.filter((name) => name.length > 0)));
  if (unique.length === 0) return "";
  const style = skillInvocationStyle(provider);
  if (style === "dollar") {
    return unique.map((name) => formatSkillInvocation(provider, name)).join(" ");
  }
  if (style === "sentence") return loadSkillsSentence(provider, unique);
  const [first, ...rest] = unique;
  const command = formatSkillInvocation(provider, first!);
  return rest.length === 0 ? command : `${command}\n${loadSkillsSentence(provider, rest)}`;
}

/** Agent Skills naming rule: lowercase letters, digits and single hyphens, ≤ 64 chars. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

export function isValidSkillName(name: string): boolean {
  return name.length > 0 && name.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(name);
}
