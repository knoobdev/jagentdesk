import type { SshServerInfo } from "@jagentdesk/client/internal/daemon-client";

/** All tags across the visible servers, de-duplicated case-insensitively, sorted. */
export function collectTags(servers: readonly SshServerInfo[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const server of servers) {
    for (const tag of server.tags ?? []) {
      const trimmed = tag.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      tags.push(trimmed);
    }
  }
  return tags.sort((a, b) => a.localeCompare(b));
}

export function toggleTagIn(selected: ReadonlySet<string>, tag: string): Set<string> {
  const next = new Set(selected);
  if (next.has(tag)) next.delete(tag);
  else next.add(tag);
  return next;
}

/**
 * Free-text search across label, `user@address:port` target text, and tags.
 * Empty query matches everything.
 */
export function serverMatchesQuery(server: SshServerInfo, query: string, target: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [server.label, target, ...(server.tags ?? [])].join(" ").toLowerCase();
  return needle
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/**
 * Tag filter with AND semantics (spec 25.2): a server must carry EVERY selected tag.
 * Comparison is case-insensitive on both sides.
 */
export function serverHasAllTags(
  server: SshServerInfo,
  selectedTags: ReadonlySet<string>,
): boolean {
  if (selectedTags.size === 0) return true;
  const owned = new Set((server.tags ?? []).map((tag) => tag.trim().toLowerCase()));
  for (const tag of selectedTags) {
    if (!owned.has(tag.toLowerCase())) return false;
  }
  return true;
}
