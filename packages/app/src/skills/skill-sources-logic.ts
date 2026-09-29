import {
  OFFICIAL_SKILL_REPOS,
  type SkillSourceSpec,
  type SkillSourceStatus,
} from "@jagentdesk/protocol/native-skills";
import { skillErrorCode, skillErrorMessage } from "@/skills/native-skill-logic";

/**
 * Pure helpers behind the Browse tab and the Sources sheet (spec 22.5, 22.6).
 * The marketplace is the union of the enabled configured sources
 * (`skills.sources.browse` without `sourceId`); provider plugin marketplaces are
 * not part of that merge, so they stay reachable as their own filter.
 */

/** Browse filter: every enabled source, one configured source, or provider marketplaces. */
export const BROWSE_ALL_SOURCES = "all";
export const BROWSE_PROVIDER_MARKETPLACES = "provider-marketplace";

export type BrowseRequest =
  | { kind: "configured"; sourceId?: string }
  | { kind: "provider-marketplace" };

export function browseRequestFor(filter: string): BrowseRequest {
  if (filter === BROWSE_PROVIDER_MARKETPLACES) return { kind: "provider-marketplace" };
  if (filter === BROWSE_ALL_SOURCES) return { kind: "configured" };
  return { kind: "configured", sourceId: filter };
}

/**
 * The filter to use given the current sources: a filter naming a source that is
 * gone or disabled falls back to "all".
 */
export function effectiveBrowseFilter(
  filter: string,
  sources: readonly SkillSourceStatus[] | undefined,
): string {
  if (filter === BROWSE_ALL_SOURCES || filter === BROWSE_PROVIDER_MARKETPLACES) return filter;
  if (!sources) return filter;
  return sources.some((source) => source.sourceId === filter && source.enabled)
    ? filter
    : BROWSE_ALL_SOURCES;
}

/** The text a user would type to add this source again (`owner/repo/path@ref`, package, URL, path). */
export function describeSourceSpec(spec: SkillSourceSpec): string {
  switch (spec.kind) {
    case "github": {
      const base = `${spec.owner}/${spec.repo}${spec.subpath ? `/${spec.subpath}` : ""}`;
      return spec.ref ? `${base}@${spec.ref}` : base;
    }
    case "npm":
      return `npm:${spec.pkg}`;
    case "index":
      return spec.url;
    case "local":
      return spec.path;
  }
}

function isOfficial(spec: SkillSourceSpec, repo: string): boolean {
  return (
    spec.kind === "github" &&
    !spec.ref &&
    !spec.subpath &&
    `${spec.owner}/${spec.repo}`.toLowerCase() === repo.toLowerCase()
  );
}

/** Default (official) repositories no longer in the source list — "Restore defaults" re-adds them. */
export function missingDefaultSources(sources: readonly SkillSourceStatus[]): string[] {
  return OFFICIAL_SKILL_REPOS.filter(
    (repo) => !sources.some((source) => isOfficial(source.spec, repo)),
  );
}

export type SourceAddErrorKind = "invalid" | "fetch" | "other";

/**
 * `skills.sources.add` rejections: `invalid_request` (the text is not a source
 * the daemon understands) and `source_fetch_failed` (listing it failed —
 * network, rate limit with reset time, missing repository) carry the daemon's
 * message; anything else is shown as a generic failure.
 */
export function describeSourceAddError(error: unknown): {
  kind: SourceAddErrorKind;
  message: string;
} {
  const code = skillErrorCode(error);
  const message = skillErrorMessage(error);
  if (code === "invalid_request") return { kind: "invalid", message };
  if (code === "source_fetch_failed") return { kind: "fetch", message };
  return { kind: "other", message };
}
