import type {
  SshAuthMethod,
  SshGroup,
  SshIdentity,
  SshServerInfo,
} from "@jagentdesk/client/internal/daemon-client";

/** A node of the group tree. `groups` never contains cycles in stored data, but a
 * malformed parentId is treated as a root (and guarded against during traversal). */
export interface SshGroupNode {
  group: SshGroup;
  children: SshGroupNode[];
}

/**
 * Builds the group forest from the flat `ssh.groups` list. Roots are groups with no
 * parent or with a parent that no longer exists; each level is sorted by label so the
 * tree renders in a stable order.
 */
export function buildGroupTree(groups: readonly SshGroup[]): SshGroupNode[] {
  const byId = new Map<string, SshGroupNode>();
  for (const group of groups) {
    byId.set(group.id, { group, children: [] });
  }
  const roots: SshGroupNode[] = [];
  for (const node of byId.values()) {
    const parentId = node.group.parentId;
    const parent = parentId ? byId.get(parentId) : undefined;
    // A parent that points at a deleted group keeps the child at the root level; a
    // cycle (impossible via the UI, possible in a hand-edited file) also breaks here.
    if (parent && parentId && !hasCycleTo(node.group.id, parentId, byId)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (nodes: SshGroupNode[]): SshGroupNode[] => {
    nodes.sort((a, b) => a.group.label.localeCompare(b.group.label));
    for (const node of nodes) {
      sortNodes(node.children);
    }
    return nodes;
  };
  return sortNodes(roots);
}

/** True when walking up from `parentId` reaches `childId` again (malformed parentId data). */
function hasCycleTo(childId: string, parentId: string, byId: Map<string, SshGroupNode>): boolean {
  const seen = new Set<string>([childId]);
  let cursor: string | undefined = parentId;
  while (cursor && byId.has(cursor)) {
    if (seen.has(cursor)) {
      return true;
    }
    seen.add(cursor);
    cursor = byId.get(cursor)?.group.parentId;
  }
  return false;
}

export type SshServerListRow =
  | { kind: "group"; group: SshGroup; depth: number }
  | { kind: "server"; server: SshServerInfo; depth: number };

/**
 * Flattens the tree into render rows, depth-first: ungrouped servers first (depth 0,
 * label-sorted), then each group subtree (group row, its direct servers, then child
 * groups). Collapsed groups hide their whole subtree. When `serverFilter` is given,
 * a group row is kept only if its subtree (incl. descendant groups, spec 25.2) has a
 * matching server, so search/tag filters never leave empty group headers behind.
 */
export function flattenServerRows(input: {
  servers: readonly SshServerInfo[];
  groups: readonly SshGroup[];
  collapsedGroupIds: ReadonlySet<string>;
  serverFilter?: (server: SshServerInfo) => boolean;
}): SshServerListRow[] {
  const serversByGroup = new Map<string, SshServerInfo[]>();
  const ungrouped: SshServerInfo[] = [];
  const groupIds = new Set(input.groups.map((group) => group.id));
  for (const server of input.servers) {
    const groupId = server.groupId && groupIds.has(server.groupId) ? server.groupId : null;
    if (groupId) {
      const bucket = serversByGroup.get(groupId);
      if (bucket) bucket.push(server);
      else serversByGroup.set(groupId, [server]);
    } else {
      ungrouped.push(server);
    }
  }
  const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label);
  ungrouped.sort(byLabel);
  for (const bucket of serversByGroup.values()) bucket.sort(byLabel);

  const filtering = input.serverFilter != null;
  const rows: SshServerListRow[] = [];

  const subtreeHasMatch = (node: SshGroupNode): boolean => {
    const direct = serversByGroup.get(node.group.id) ?? [];
    if (!input.serverFilter) return true;
    if (direct.some(input.serverFilter)) return true;
    return node.children.some(subtreeHasMatch);
  };

  for (const server of ungrouped) {
    if (input.serverFilter && !input.serverFilter(server)) continue;
    rows.push({ kind: "server", server, depth: 0 });
  }

  const walk = (node: SshGroupNode, depth: number) => {
    if (filtering && !subtreeHasMatch(node)) return;
    rows.push({ kind: "group", group: node.group, depth });
    if (input.collapsedGroupIds.has(node.group.id)) return;
    for (const server of serversByGroup.get(node.group.id) ?? []) {
      if (input.serverFilter && !input.serverFilter(server)) continue;
      rows.push({ kind: "server", server, depth: depth + 1 });
    }
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  };
  for (const root of buildGroupTree(input.groups)) {
    walk(root, 0);
  }
  return rows;
}

export interface SshEffectiveFields {
  username: string;
  port: number;
  authMethods: SshAuthMethod[];
  identityId: string | null;
}

/**
 * Group inheritance (spec 25.2): the effective value of each inheritable field is the
 * nearest ancestor (server first, then each group up the parent chain) that sets it.
 * Mirrors the daemon's resolution so list rows display what connect will use.
 */
export function resolveEffectiveFields(
  server: {
    username?: string;
    port?: number;
    identityId?: string;
    authMethods?: SshAuthMethod[];
    groupId?: string;
  },
  groups: readonly SshGroup[],
  identities: readonly SshIdentity[] = [],
): SshEffectiveFields {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const chain: SshGroup[] = [];
  let cursor = server.groupId ? byId.get(server.groupId) : undefined;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  const firstDefined = <T>(pick: (source: SshGroup) => T | undefined): T | undefined => {
    for (const group of chain) {
      const value = pick(group);
      if (value !== undefined) return value;
    }
    return undefined;
  };
  const identityId = server.identityId ?? firstDefined((group) => group.identityId) ?? null;
  const identity = identityId
    ? identities.find((candidate) => candidate.id === identityId)
    : undefined;
  const authMethods = server.authMethods ??
    firstDefined((group) => group.authMethods) ?? ["password", "key"];
  return {
    username:
      server.username ?? firstDefined((group) => group.username) ?? identity?.username ?? "",
    port: server.port ?? firstDefined((group) => group.port) ?? 22,
    authMethods,
    identityId,
  };
}

/** `user@address:port` with the group-inherited username/port applied (spec 25.2). */
export function formatServerTarget(
  server: SshServerInfo,
  groups: readonly SshGroup[],
  identities: readonly SshIdentity[] = [],
): string {
  const effective = resolveEffectiveFields(server, groups, identities);
  const user = effective.username ? `${effective.username}@` : "";
  return `${user}${server.address}:${effective.port}`;
}
