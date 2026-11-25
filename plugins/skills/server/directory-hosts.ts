import type { SkillDirectoryStatus } from "@jagentdesk/protocol/native-skills";

export type DirectoryProvider = SkillDirectoryStatus["provider"];

/** Hosts of the searchable skill directories JAgentDesk has an adapter for (ADR-0023). */
const SKILLSMP = {
  provider: "skillsmp",
  origin: "https://skillsmp.com",
  label: "SkillsMP",
} as const;
const DIRECTORY_HOSTS: Record<
  string,
  { provider: DirectoryProvider; origin: string; label: string }
> = {
  "skillsmp.com": SKILLSMP,
  "www.skillsmp.com": SKILLSMP,
};

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The directory adapter for a source URL, or null when the host has none. */
export function directoryProviderFor(url: string): DirectoryProvider | null {
  const host = hostOf(url);
  return host ? (DIRECTORY_HOSTS[host]?.provider ?? null) : null;
}

/** Any page of a directory is stored as the directory itself (one source per site). */
export function canonicalDirectoryUrl(url: string): string | null {
  const host = hostOf(url);
  return host ? (DIRECTORY_HOSTS[host]?.origin ?? null) : null;
}

/** Display name of a directory source (used when the user gives no label). */
export function directoryLabelFor(url: string): string | null {
  const host = hostOf(url);
  return host ? (DIRECTORY_HOSTS[host]?.label ?? null) : null;
}
