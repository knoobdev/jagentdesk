import { describe, expect, it } from "vitest";
import type {
  ArgoCdManagedResource,
  ArgoCdTreeNode,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import {
  APP_NODE_ID,
  EMPTY_RESOURCE_FILTER,
  buildResourceModel,
  filterResources,
  flattenResourceTree,
  groupPodsByParent,
  listResources,
  visibleChildren,
} from "./resources";

interface NodeInput {
  group?: string;
  kind: string;
  name: string;
  uid: string;
  parents?: Array<{ group?: string; kind: string; name: string; uid: string | null }>;
  health?: string;
}

function treeNode(input: NodeInput): ArgoCdTreeNode {
  return {
    group: input.group ?? "",
    version: "v1",
    kind: input.kind,
    namespace: "web",
    name: input.name,
    uid: input.uid,
    parentRefs: (input.parents ?? []).map((parent) => ({
      group: parent.group ?? "",
      kind: parent.kind,
      namespace: "web",
      name: parent.name,
      uid: parent.uid,
    })),
    health: input.health ? { status: input.health, message: null } : null,
    info: [],
    images: [],
    createdAt_ms: null,
  };
}

function managed(input: {
  group?: string;
  kind: string;
  name: string;
  sync: string;
  health?: string;
  requiresPruning?: boolean;
}): ArgoCdManagedResource {
  return {
    group: input.group ?? "",
    version: "v1",
    kind: input.kind,
    namespace: "web",
    name: input.name,
    sync: input.sync,
    health: input.health ? { status: input.health, message: null } : null,
    hook: false,
    requiresPruning: input.requiresPruning ?? false,
    requiresDeletionConfirmation: false,
  };
}

// A guestbook-shaped app: Deployment → ReplicaSet → two Pods, a Service → EndpointSlice, and a
// ConfigMap that is managed but not yet created.
const resources = [
  managed({ group: "apps", kind: "Deployment", name: "ui", sync: "OutOfSync", health: "Degraded" }),
  managed({ kind: "Service", name: "ui", sync: "Synced", health: "Healthy" }),
  managed({ kind: "ConfigMap", name: "ui-config", sync: "OutOfSync", health: "Missing" }),
];
const tree = {
  nodes: [
    treeNode({ group: "apps", kind: "Deployment", name: "ui", uid: "d1", health: "Degraded" }),
    treeNode({
      group: "apps",
      kind: "ReplicaSet",
      name: "ui-7c9",
      uid: "rs1",
      parents: [{ group: "apps", kind: "Deployment", name: "ui", uid: "d1" }],
      health: "Degraded",
    }),
    treeNode({
      kind: "Pod",
      name: "ui-7c9-b",
      uid: "p2",
      parents: [{ group: "apps", kind: "ReplicaSet", name: "ui-7c9", uid: "rs1" }],
      health: "Degraded",
    }),
    treeNode({
      kind: "Pod",
      name: "ui-7c9-a",
      uid: "p1",
      parents: [{ group: "apps", kind: "ReplicaSet", name: "ui-7c9", uid: "rs1" }],
      health: "Healthy",
    }),
    treeNode({ kind: "Service", name: "ui", uid: "s1", health: "Healthy" }),
    treeNode({
      group: "discovery.k8s.io",
      kind: "EndpointSlice",
      name: "ui-x",
      uid: "e1",
      parents: [{ kind: "Service", name: "ui", uid: null }],
    }),
  ],
  orphanedNodes: [],
};

describe("buildResourceModel", () => {
  const model = buildResourceModel({ resources, tree });

  it("hangs top-level managed resources off the app in kind order", () => {
    expect(model.children.get(APP_NODE_ID)).toEqual([
      "/ConfigMap/web/ui-config",
      "/Service/web/ui",
      "apps/Deployment/web/ui",
    ]);
  });

  it("nests children by parentRefs uid, falling back to the key when uid is null", () => {
    expect(model.children.get("apps/Deployment/web/ui")).toEqual(["apps/ReplicaSet/web/ui-7c9"]);
    expect(model.children.get("apps/ReplicaSet/web/ui-7c9")).toEqual([
      "/Pod/web/ui-7c9-a",
      "/Pod/web/ui-7c9-b",
    ]);
    expect(model.children.get("/Service/web/ui")).toEqual([
      "discovery.k8s.io/EndpointSlice/web/ui-x",
    ]);
  });

  it("joins sync status from app.resources and keeps missing managed resources", () => {
    expect(model.items.get("apps/Deployment/web/ui")).toMatchObject({
      sync: "OutOfSync",
      health: "Degraded",
      uid: "d1",
    });
    expect(model.items.get("/Pod/web/ui-7c9-a")).toMatchObject({ sync: null, health: "Healthy" });
    expect(model.items.get("/ConfigMap/web/ui-config")).toMatchObject({
      sync: "OutOfSync",
      health: "Missing",
      node: null,
    });
  });

  it("records every owner edge", () => {
    expect(model.edges).toHaveLength(7);
    expect(model.edges).toContainEqual({ from: APP_NODE_ID, to: "/Service/web/ui" });
    expect(model.edges).toContainEqual({
      from: "apps/ReplicaSet/web/ui-7c9",
      to: "/Pod/web/ui-7c9-b",
    });
  });

  it("places resources caught in an owner cycle at the top level instead of dropping them", () => {
    const cyclic = buildResourceModel({
      resources: [],
      tree: {
        nodes: [
          treeNode({
            kind: "Pod",
            name: "a",
            uid: "a",
            parents: [{ kind: "Pod", name: "b", uid: "b" }],
          }),
          treeNode({
            kind: "Pod",
            name: "b",
            uid: "b",
            parents: [{ kind: "Pod", name: "a", uid: "a" }],
          }),
        ],
        orphanedNodes: [],
      },
    });
    expect(cyclic.children.get(APP_NODE_ID)).toEqual(["/Pod/web/a"]);
    expect(cyclic.children.get("/Pod/web/a")).toEqual(["/Pod/web/b"]);
  });
});

describe("filterResources", () => {
  const model = buildResourceModel({ resources, tree });

  it("matches everything when no filter is set", () => {
    const result = filterResources(model, EMPTY_RESOURCE_FILTER);
    expect(result.matched.size).toBe(model.items.size);
    expect(result.visible.size).toBe(model.items.size + 1);
  });

  it("keeps the owners of a match visible so the tree keeps its shape", () => {
    const result = filterResources(model, { ...EMPTY_RESOURCE_FILTER, name: "7C9-B" });
    expect([...result.matched]).toEqual(["/Pod/web/ui-7c9-b"]);
    expect([...result.visible].sort()).toEqual(
      [
        APP_NODE_ID,
        "apps/Deployment/web/ui",
        "apps/ReplicaSet/web/ui-7c9",
        "/Pod/web/ui-7c9-b",
      ].sort(),
    );
    expect(visibleChildren(model, result.visible).get("apps/ReplicaSet/web/ui-7c9")).toEqual([
      "/Pod/web/ui-7c9-b",
    ]);
  });

  it("combines facets with AND and skips resources without a sync status", () => {
    const result = filterResources(model, {
      ...EMPTY_RESOURCE_FILTER,
      syncs: ["OutOfSync"],
      kinds: ["Deployment", "Pod"],
    });
    expect([...result.matched]).toEqual(["apps/Deployment/web/ui"]);
  });
});

describe("tree views", () => {
  const model = buildResourceModel({ resources, tree });

  it("flattens depth-first with guides and honours collapsed owners", () => {
    const rows = flattenResourceTree({
      children: model.children,
      items: model.items,
      collapsed: new Set(["/Service/web/ui"]),
    });
    const guides = (row: (typeof rows)[number]) => row.guides.map((guide) => guide.continues);
    expect(rows.map((row) => [row.item.name, row.depth, guides(row), row.isLast])).toEqual([
      ["ui-config", 0, [], false],
      ["ui", 0, [], false],
      ["ui", 0, [], true],
      ["ui-7c9", 1, [false], true],
      ["ui-7c9-a", 2, [false, false], false],
      ["ui-7c9-b", 2, [false, false], true],
    ]);
    expect(rows[4]?.guides.map((guide) => guide.ancestorId)).toEqual([
      "apps/Deployment/web/ui",
      "apps/ReplicaSet/web/ui-7c9",
    ]);
    expect(rows[1]).toMatchObject({ hasChildren: true });
  });

  it("groups pods under their owner", () => {
    const groups = groupPodsByParent({ children: model.children, items: model.items });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.parent?.name).toBe("ui-7c9");
    expect(groups[0]?.pods.map((pod) => pod.name)).toEqual(["ui-7c9-a", "ui-7c9-b"]);
  });

  it("lists visible resources in kind order", () => {
    const { visible } = filterResources(model, {
      ...EMPTY_RESOURCE_FILTER,
      kinds: ["Pod", "Service"],
    });
    expect(listResources(model, visible).map((item) => `${item.kind}/${item.name}`)).toEqual([
      "Service/ui",
      "Pod/ui-7c9-a",
      "Pod/ui-7c9-b",
      "ReplicaSet/ui-7c9",
      "Deployment/ui",
    ]);
  });
});
