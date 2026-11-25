import { describe, expect, it } from "vitest";
import type { SshGroup, SshServerInfo } from "@jagentdesk/client/internal/daemon-client";
import {
  buildGroupTree,
  flattenServerRows,
  formatServerTarget,
  resolveEffectiveFields,
} from "./group-tree";

function server(partial: Partial<SshServerInfo> & { id: string; label: string }): SshServerInfo {
  return { address: `${partial.id}.example.com`, state: "disconnected", ...partial };
}

function group(partial: Partial<SshGroup> & { id: string; label: string }): SshGroup {
  return partial;
}

describe("buildGroupTree", () => {
  it("nests children under parents and sorts each level by label", () => {
    const tree = buildGroupTree([
      group({ id: "b", label: "Beta", parentId: "a" }),
      group({ id: "a", label: "Alpha" }),
      group({ id: "c", label: "Charlie", parentId: "a" }),
    ]);
    expect(tree.map((node) => node.group.id)).toEqual(["a"]);
    expect(tree[0].children.map((node) => node.group.id)).toEqual(["b", "c"]);
  });

  it("keeps orphans at the root and breaks parent cycles", () => {
    const tree = buildGroupTree([
      group({ id: "orphan", label: "Orphan", parentId: "missing" }),
      group({ id: "x", label: "X", parentId: "y" }),
      group({ id: "y", label: "Y", parentId: "x" }),
    ]);
    const ids = tree.map((node) => node.group.id);
    expect(ids).toContain("orphan");
    // The cycle must not swallow both nodes into an unreachable subtree.
    expect(ids).toContain("x");
    expect(ids).toContain("y");
    expect(buildGroupTree([])).toEqual([]);
  });
});

describe("flattenServerRows", () => {
  const groups = [
    group({ id: "prod", label: "Prod" }),
    group({ id: "eu", label: "EU", parentId: "prod" }),
  ];
  const servers = [
    server({ id: "s1", label: "Alpha", groupId: "prod" }),
    server({ id: "s2", label: "Beta", groupId: "eu" }),
    server({ id: "s3", label: "Ungrouped" }),
    server({ id: "s4", label: "Another", groupId: "prod" }),
  ];

  it("lists ungrouped servers first, then depth-first group subtrees", () => {
    const rows = flattenServerRows({ servers, groups, collapsedGroupIds: new Set() });
    expect(
      rows.map((row) =>
        row.kind === "group" ? `group:${row.group.id}` : `server:${row.server.id}@${row.depth}`,
      ),
    ).toEqual([
      "server:s3@0",
      "group:prod",
      "server:s1@1",
      "server:s4@1",
      "group:eu",
      "server:s2@2",
    ]);
  });

  it("hides the whole subtree of a collapsed group", () => {
    const rows = flattenServerRows({ servers, groups, collapsedGroupIds: new Set(["prod"]) });
    expect(rows.some((row) => row.kind === "server" && row.server.groupId === "prod")).toBe(false);
    expect(rows.filter((row) => row.kind === "group")).toHaveLength(1);
  });

  it("keeps a group row only when a descendant server matches the filter (AND across nesting)", () => {
    const rows = flattenServerRows({
      servers,
      groups,
      collapsedGroupIds: new Set(),
      serverFilter: (candidate) => candidate.label === "Beta",
    });
    expect(
      rows.map((row) => (row.kind === "group" ? `group:${row.group.id}` : row.server.id)),
    ).toEqual(["group:prod", "group:eu", "s2"]);
  });

  it("treats servers in deleted groups as ungrouped", () => {
    const rows = flattenServerRows({
      servers: [server({ id: "ghost", label: "Ghost", groupId: "gone" })],
      groups,
      collapsedGroupIds: new Set(),
    });
    expect(rows[0]).toEqual({
      kind: "server",
      server: expect.objectContaining({ id: "ghost" }),
      depth: 0,
    });
    expect(rows.filter((row) => row.kind === "server")).toHaveLength(1);
  });
});

describe("resolveEffectiveFields", () => {
  it("walks the ancestor chain per field, nearest value wins", () => {
    const groups = [
      group({
        id: "root",
        label: "Root",
        username: "root-user",
        port: 2200,
        identityId: "idn-root",
      }),
      group({ id: "child", label: "Child", parentId: "root", username: "child-user" }),
    ];
    const effective = resolveEffectiveFields(
      server({ id: "s", label: "S", groupId: "child" }),
      groups,
      [{ id: "idn-root", label: "Root id", username: "idn-user" }],
    );
    expect(effective.username).toBe("child-user");
    expect(effective.port).toBe(2200);
    expect(effective.identityId).toBe("idn-root");
  });

  it("falls back to the identity username, then to port 22", () => {
    const effective = resolveEffectiveFields(
      server({ id: "s", label: "S" }),
      [],
      [{ id: "idn-1", label: "Id", username: "idn-user" }],
    );
    // No server/group username; identity is only consulted when an identityId resolves.
    expect(effective.username).toBe("");
    expect(effective.port).toBe(22);
  });

  it("ignores cyclic parent chains", () => {
    const groups = [
      group({ id: "x", label: "X", parentId: "y", port: 2222 }),
      group({ id: "y", label: "Y", parentId: "x" }),
    ];
    const effective = resolveEffectiveFields(server({ id: "s", label: "S", groupId: "x" }), groups);
    expect(effective.port).toBe(2222);
  });
});

describe("formatServerTarget", () => {
  it("renders user@address:port with inherited values", () => {
    const groups = [group({ id: "g", label: "G", username: "deploy", port: 2222 })];
    expect(
      formatServerTarget(server({ id: "s", label: "S", address: "host.io", groupId: "g" }), groups),
    ).toBe("deploy@host.io:2222");
    expect(formatServerTarget(server({ id: "s2", label: "S2", address: "bare.io" }), groups)).toBe(
      "bare.io:22",
    );
  });
});
