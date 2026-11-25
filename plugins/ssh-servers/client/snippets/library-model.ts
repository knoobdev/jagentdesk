import type {
  SshCommandHistoryEntry,
  SshSnippet,
  SshSnippetPackage,
} from "@jagentdesk/protocol/ssh/snippets-schemas";

// Pure view models for the Snippets tab (spec 25.7, 25.13): the package list with search,
// server selection by group for "Run on servers", and history search.

export interface SnippetPackageGroup {
  /** Package id, or "none" for snippets outside any package. */
  key: string;
  pkg: SshSnippetPackage | null;
  snippets: SshSnippet[];
}

function normalize(query: string): string {
  return query.trim().toLowerCase();
}

function includesNeedle(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle);
}

/**
 * Packages in the library order, then "No package" first. A query matches a snippet's label or
 * script, or a package's name (then the whole package shows). While searching, packages with
 * nothing to show are hidden; without a query every package shows, empty or not.
 */
export function buildSnippetPackageGroups(input: {
  packages: readonly SshSnippetPackage[];
  snippets: readonly SshSnippet[];
  query: string;
}): SnippetPackageGroup[] {
  const needle = normalize(input.query);
  const isSearching = needle !== "";
  const known = new Set(input.packages.map((pkg) => pkg.id));
  function matches(snippet: SshSnippet): boolean {
    return includesNeedle(snippet.label, needle) || includesNeedle(snippet.script, needle);
  }
  const loose = input.snippets.filter(
    (snippet) => (!snippet.packageId || !known.has(snippet.packageId)) && matches(snippet),
  );
  const packaged = input.packages.map((pkg) => {
    const members = input.snippets.filter((snippet) => snippet.packageId === pkg.id);
    const packageMatches = isSearching && includesNeedle(pkg.label, needle);
    return {
      key: pkg.id,
      pkg,
      snippets: packageMatches ? members : members.filter(matches),
      packageMatches,
    };
  });
  const visiblePackages = packaged.filter(
    (group) => !isSearching || group.packageMatches || group.snippets.length > 0,
  );
  const groups: SnippetPackageGroup[] = visiblePackages.map(({ key, pkg, snippets }) => ({
    key,
    pkg,
    snippets,
  }));
  if (loose.length === 0) return groups;
  return [{ key: "none", pkg: null, snippets: loose }, ...groups];
}

export interface PickerServer {
  id: string;
  groupId?: string;
}

export interface PickerGroup {
  id: string;
  label: string;
  parentId?: string;
}

/** Servers of a group and of all its sub-groups (spec 25.2: a group lists its sub-groups' servers). */
export function serverIdsInGroup(
  groupId: string,
  servers: readonly PickerServer[],
  groups: readonly PickerGroup[],
): string[] {
  const included = new Set([groupId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const group of groups) {
      if (group.parentId && included.has(group.parentId) && !included.has(group.id)) {
        included.add(group.id);
        grew = true;
      }
    }
  }
  return servers
    .filter((server) => server.groupId !== undefined && included.has(server.groupId))
    .map((server) => server.id);
}

/** Adds the group's servers to the selection, or removes them when all are already selected. */
export function toggleGroupSelection(
  selected: readonly string[],
  groupServerIds: readonly string[],
): string[] {
  const allSelected = groupServerIds.every((id) => selected.includes(id));
  if (allSelected) return selected.filter((id) => !groupServerIds.includes(id));
  return [...selected, ...groupServerIds.filter((id) => !selected.includes(id))];
}

export function filterHistory(
  entries: readonly SshCommandHistoryEntry[],
  query: string,
): SshCommandHistoryEntry[] {
  const needle = normalize(query);
  if (needle === "") return [...entries];
  return entries.filter((entry) => includesNeedle(entry.command, needle));
}
