import type {
  ArgoCdManagedResource,
  ArgoCdResourceKey,
  ArgoCdResourceTree,
  ArgoCdTreeNode,
} from "@jagentdesk/protocol/argocd/rpc-schemas";

// The resource model behind the app detail views (spec 30.3): one item per live tree node plus
// every managed resource that has no live object yet, joined to its parents. The Tree graph, the
// mobile indented tree, List and Pods all derive from it.

/** The synthetic root: the application itself. Top-level managed resources hang off it. */
export const APP_NODE_ID = "__app__";

export interface ArgoCdResourceItem {
  id: string;
  group: string;
  version: string;
  kind: string;
  namespace: string;
  name: string;
  uid: string | null;
  health: string | null;
  healthMessage: string | null;
  /** Sync status from `app.resources`; null for resources Argo CD does not manage (pods, …). */
  sync: string | null;
  requiresPruning: boolean;
  node: ArgoCdTreeNode | null;
}

export interface ArgoCdResourceEdge {
  from: string;
  to: string;
}

export interface ArgoCdResourceModel {
  items: ReadonlyMap<string, ArgoCdResourceItem>;
  /** Spanning tree: each resource sits under its first owner. `APP_NODE_ID` holds the top level. */
  children: ReadonlyMap<string, readonly string[]>;
  /** Every owner → resource link, including second owners the spanning tree leaves out. */
  edges: readonly ArgoCdResourceEdge[];
}

export function resourceKeyId(key: ArgoCdResourceKey): string {
  return `${key.group}/${key.kind}/${key.namespace}/${key.name}`;
}

// Argo CD's web UI orders siblings by kind like `kubectl apply` would create them.
const KIND_ORDER = [
  "Namespace",
  "NetworkPolicy",
  "ResourceQuota",
  "LimitRange",
  "PodSecurityPolicy",
  "PodDisruptionBudget",
  "ServiceAccount",
  "Secret",
  "SecretList",
  "ConfigMap",
  "StorageClass",
  "PersistentVolume",
  "PersistentVolumeClaim",
  "CustomResourceDefinition",
  "ClusterRole",
  "ClusterRoleList",
  "ClusterRoleBinding",
  "ClusterRoleBindingList",
  "Role",
  "RoleList",
  "RoleBinding",
  "RoleBindingList",
  "Service",
  "Endpoints",
  "EndpointSlice",
  "DaemonSet",
  "Pod",
  "ReplicationController",
  "ReplicaSet",
  "Deployment",
  "HorizontalPodAutoscaler",
  "StatefulSet",
  "Job",
  "CronJob",
  "Ingress",
  "APIService",
];

function kindRank(kind: string): number {
  const index = KIND_ORDER.indexOf(kind);
  return index === -1 ? KIND_ORDER.length : index;
}

function compareItems(a: ArgoCdResourceItem, b: ArgoCdResourceItem): number {
  const byKind = kindRank(a.kind) - kindRank(b.kind);
  if (byKind !== 0) return byKind;
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
  if (a.namespace !== b.namespace) return a.namespace.localeCompare(b.namespace);
  return a.name.localeCompare(b.name);
}

function itemFromNode(
  node: ArgoCdTreeNode,
  managed: ArgoCdManagedResource | undefined,
): ArgoCdResourceItem {
  return {
    id: resourceKeyId(node),
    group: node.group,
    version: node.version,
    kind: node.kind,
    namespace: node.namespace,
    name: node.name,
    uid: node.uid,
    health: node.health?.status ?? managed?.health?.status ?? null,
    healthMessage: node.health?.message ?? managed?.health?.message ?? null,
    sync: managed?.sync ?? null,
    requiresPruning: managed?.requiresPruning ?? false,
    node,
  };
}

function itemFromManaged(resource: ArgoCdManagedResource): ArgoCdResourceItem {
  return {
    id: resourceKeyId(resource),
    group: resource.group,
    version: resource.version,
    kind: resource.kind,
    namespace: resource.namespace,
    name: resource.name,
    uid: null,
    health: resource.health?.status ?? null,
    healthMessage: resource.health?.message ?? null,
    sync: resource.sync,
    requiresPruning: resource.requiresPruning,
    node: null,
  };
}

function collectItems(
  resources: readonly ArgoCdManagedResource[],
  tree: ArgoCdResourceTree | null,
): Map<string, ArgoCdResourceItem> {
  const managed = new Map(resources.map((resource) => [resourceKeyId(resource), resource]));
  const items = new Map<string, ArgoCdResourceItem>();
  for (const node of tree?.nodes ?? []) {
    const id = resourceKeyId(node);
    items.set(id, itemFromNode(node, managed.get(id)));
  }
  for (const [id, resource] of managed) {
    if (!items.has(id)) items.set(id, itemFromManaged(resource));
  }
  return items;
}

function resolveParents(
  items: ReadonlyMap<string, ArgoCdResourceItem>,
): Map<string, readonly string[]> {
  const byUid = new Map<string, string>();
  for (const item of items.values()) {
    if (item.uid) byUid.set(item.uid, item.id);
  }
  const parents = new Map<string, readonly string[]>();
  for (const item of items.values()) {
    const resolved: string[] = [];
    for (const ref of item.node?.parentRefs ?? []) {
      const byUidId = ref.uid ? byUid.get(ref.uid) : undefined;
      const id = byUidId ?? resourceKeyId(ref);
      const isKnownOther = items.has(id) && id !== item.id;
      if (isKnownOther && !resolved.includes(id)) resolved.push(id);
    }
    parents.set(item.id, resolved);
  }
  return parents;
}

function sortIds(ids: string[], items: ReadonlyMap<string, ArgoCdResourceItem>): string[] {
  return ids.sort((a, b) => {
    const left = items.get(a);
    const right = items.get(b);
    if (!left || !right) return a.localeCompare(b);
    return compareItems(left, right);
  });
}

export function buildResourceModel(input: {
  resources: readonly ArgoCdManagedResource[];
  tree: ArgoCdResourceTree | null;
}): ArgoCdResourceModel {
  const items = collectItems(input.resources, input.tree);
  const parents = resolveParents(items);

  const ownedBy = new Map<string, string[]>();
  const edges: ArgoCdResourceEdge[] = [];
  const topLevel: string[] = [];
  for (const [id, owners] of parents) {
    if (owners.length === 0) {
      topLevel.push(id);
      edges.push({ from: APP_NODE_ID, to: id });
      continue;
    }
    for (const owner of owners) {
      const list = ownedBy.get(owner) ?? [];
      list.push(id);
      ownedBy.set(owner, list);
      edges.push({ from: owner, to: id });
    }
  }

  // Breadth-first from the app so each resource lands under the owner nearest the root. Owner
  // cycles (Kubernetes never produces them, but a broken tree must still render) join the top level.
  const children = new Map<string, string[]>([[APP_NODE_ID, []]]);
  const placed = new Set<string>();
  const queue: string[] = [];
  function attach(parent: string, id: string): void {
    placed.add(id);
    const own = children.get(parent) ?? [];
    own.push(id);
    children.set(parent, own);
    queue.push(id);
  }
  function drain(): void {
    while (queue.length > 0) {
      const parent = queue.shift() ?? APP_NODE_ID;
      for (const id of sortIds([...(ownedBy.get(parent) ?? [])], items)) {
        if (!placed.has(id)) attach(parent, id);
      }
    }
  }
  for (const id of sortIds(topLevel, items)) attach(APP_NODE_ID, id);
  drain();
  for (const id of sortIds([...items.keys()], items)) {
    if (placed.has(id)) continue;
    attach(APP_NODE_ID, id);
    drain();
  }

  return { items, children, edges };
}

export interface ArgoCdResourceFilter {
  name: string;
  kinds: readonly string[];
  syncs: readonly string[];
  healths: readonly string[];
  namespaces: readonly string[];
}

export const EMPTY_RESOURCE_FILTER: ArgoCdResourceFilter = {
  name: "",
  kinds: [],
  syncs: [],
  healths: [],
  namespaces: [],
};

export function isFilterActive(filter: ArgoCdResourceFilter): boolean {
  return (
    filter.name.trim().length > 0 ||
    filter.kinds.length > 0 ||
    filter.syncs.length > 0 ||
    filter.healths.length > 0 ||
    filter.namespaces.length > 0
  );
}

function matchesFacet(selected: readonly string[], value: string | null): boolean {
  if (selected.length === 0) return true;
  return value !== null && selected.includes(value);
}

export function matchesFilter(item: ArgoCdResourceItem, filter: ArgoCdResourceFilter): boolean {
  const needle = filter.name.trim().toLowerCase();
  const nameMatches = needle.length === 0 || item.name.toLowerCase().includes(needle);
  return (
    nameMatches &&
    matchesFacet(filter.kinds, item.kind) &&
    matchesFacet(filter.syncs, item.sync) &&
    matchesFacet(filter.healths, item.health) &&
    matchesFacet(filter.namespaces, item.namespace)
  );
}

export interface ArgoCdFilteredResources {
  /** Resources that match the filter. */
  matched: ReadonlySet<string>;
  /** Matched resources plus their owners, so the tree keeps its shape. Always has the app. */
  visible: ReadonlySet<string>;
}

function parentIndex(model: ArgoCdResourceModel): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const [parent, ids] of model.children) {
    for (const id of ids) parentOf.set(id, parent);
  }
  return parentOf;
}

export function filterResources(
  model: ArgoCdResourceModel,
  filter: ArgoCdResourceFilter,
): ArgoCdFilteredResources {
  const matched = new Set<string>();
  for (const item of model.items.values()) {
    if (matchesFilter(item, filter)) matched.add(item.id);
  }
  const parentOf = parentIndex(model);
  const visible = new Set<string>([APP_NODE_ID]);
  for (const id of matched) {
    let current: string | undefined = id;
    while (current && !visible.has(current)) {
      visible.add(current);
      current = parentOf.get(current);
    }
  }
  return { matched, visible };
}

/** The spanning tree restricted to `visible`. */
export function visibleChildren(
  model: ArgoCdResourceModel,
  visible: ReadonlySet<string>,
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [parent, ids] of model.children) {
    if (!visible.has(parent)) continue;
    out.set(
      parent,
      ids.filter((id) => visible.has(id)),
    );
  }
  return out;
}

export interface ArgoCdFilterOptions {
  kinds: string[];
  syncs: string[];
  healths: string[];
  namespaces: string[];
}

function sortedDistinct(values: Iterable<string | null>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (value) set.add(value);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

export function filterOptions(model: ArgoCdResourceModel): ArgoCdFilterOptions {
  const items = [...model.items.values()];
  return {
    kinds: sortedDistinct(items.map((item) => item.kind)),
    syncs: sortedDistinct(items.map((item) => item.sync)),
    healths: sortedDistinct(items.map((item) => item.health)),
    namespaces: sortedDistinct(items.map((item) => item.namespace)),
  };
}

export interface ArgoCdTreeGuide {
  ancestorId: string;
  continues: boolean;
}

export interface ArgoCdTreeRow {
  id: string;
  item: ArgoCdResourceItem;
  depth: number;
  hasChildren: boolean;
  /** One entry per ancestor column: whether that ancestor's vertical guide continues below. */
  guides: readonly ArgoCdTreeGuide[];
  isLast: boolean;
}

/** Depth-first rows for the indented tree (mobile). The app itself is the screen, not a row. */
export function flattenResourceTree(input: {
  children: ReadonlyMap<string, readonly string[]>;
  items: ReadonlyMap<string, ArgoCdResourceItem>;
  collapsed: ReadonlySet<string>;
}): ArgoCdTreeRow[] {
  const rows: ArgoCdTreeRow[] = [];
  function visit(parent: string, depth: number, guides: readonly ArgoCdTreeGuide[]): void {
    const ids = input.children.get(parent) ?? [];
    ids.forEach((id, index) => {
      const item = input.items.get(id);
      if (!item) return;
      const isLast = index === ids.length - 1;
      const childIds = input.children.get(id) ?? [];
      rows.push({ id, item, depth, hasChildren: childIds.length > 0, guides, isLast });
      const guide = { ancestorId: id, continues: !isLast };
      if (!input.collapsed.has(id)) visit(id, depth + 1, [...guides, guide]);
    });
  }
  visit(APP_NODE_ID, 0, []);
  return rows;
}

export interface ArgoCdPodGroup {
  /** The owner the pods are grouped under; null for pods without an owner in the tree. */
  parent: ArgoCdResourceItem | null;
  pods: ArgoCdResourceItem[];
}

/** Pods view: Pod resources grouped by their owner (ReplicaSet, StatefulSet, Job, …). */
export function groupPodsByParent(input: {
  children: ReadonlyMap<string, readonly string[]>;
  items: ReadonlyMap<string, ArgoCdResourceItem>;
}): ArgoCdPodGroup[] {
  const groups = new Map<string, ArgoCdPodGroup>();
  for (const [parentId, ids] of input.children) {
    const pods = ids
      .map((id) => input.items.get(id))
      .filter((item): item is ArgoCdResourceItem => item?.kind === "Pod" && item.group === "");
    if (pods.length === 0) continue;
    const parent = parentId === APP_NODE_ID ? null : (input.items.get(parentId) ?? null);
    groups.set(parentId, { parent, pods });
  }
  return [...groups.values()].sort((a, b) => {
    const left = a.parent ? `${a.parent.kind}/${a.parent.name}` : "";
    const right = b.parent ? `${b.parent.kind}/${b.parent.name}` : "";
    return left.localeCompare(right);
  });
}

/** Flat rows for the List view, in kind order. */
export function listResources(
  model: ArgoCdResourceModel,
  visible: ReadonlySet<string>,
): ArgoCdResourceItem[] {
  return [...model.items.values()].filter((item) => visible.has(item.id)).sort(compareItems);
}

// Kind badges on graph cards, like the Argo CD web UI's abbreviations.
const KIND_ABBREVIATIONS: Record<string, string> = {
  Deployment: "deploy",
  ReplicaSet: "rs",
  StatefulSet: "sts",
  DaemonSet: "ds",
  Pod: "pod",
  Service: "svc",
  Endpoints: "ep",
  EndpointSlice: "endpointslice",
  ConfigMap: "cm",
  Secret: "secret",
  Ingress: "ing",
  PersistentVolumeClaim: "pvc",
  PersistentVolume: "pv",
  ServiceAccount: "sa",
  HorizontalPodAutoscaler: "hpa",
  CronJob: "cj",
  Job: "job",
  Namespace: "ns",
  NetworkPolicy: "netpol",
  ClusterRole: "clusterrole",
  ClusterRoleBinding: "crb",
  Role: "role",
  RoleBinding: "rb",
  CustomResourceDefinition: "crd",
};

export function kindAbbreviation(kind: string): string {
  return KIND_ABBREVIATIONS[kind] ?? kind.toLowerCase();
}

/** Kinds whose pods' logs Argo CD can stream through the owner (spec 30.3 Logs). */
const LOG_OWNER_KINDS = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "Job",
  "CronJob",
  "Rollout",
]);

export function hasLogs(item: Pick<ArgoCdResourceItem, "kind" | "group">): boolean {
  const isPod = item.kind === "Pod" && item.group === "";
  return isPod || LOG_OWNER_KINDS.has(item.kind);
}
