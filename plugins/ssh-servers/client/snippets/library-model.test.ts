import { describe, expect, it } from "vitest";
import type { SshSnippet, SshSnippetPackage } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { darkMidnightTheme } from "@/styles/theme";
import { terminalAppearanceOverride } from "./appearance";
import {
  buildSnippetPackageGroups,
  filterHistory,
  serverIdsInGroup,
  toggleGroupSelection,
} from "./library-model";

function snippet(id: string, label: string, script: string, packageId?: string): SshSnippet {
  return {
    id,
    label,
    script,
    defaultTargets: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...(packageId ? { packageId } : {}),
  };
}

const packages: SshSnippetPackage[] = [
  { id: "pkg_deploy", label: "Deploy" },
  { id: "pkg_db", label: "Database" },
  { id: "pkg_empty", label: "Empty" },
];
const snippets = [
  snippet("snp_uname", "Kernel", "uname -a"),
  snippet("snp_pull", "Pull", "git pull", "pkg_deploy"),
  snippet("snp_restart", "Restart app", "systemctl restart app", "pkg_deploy"),
  snippet("snp_vacuum", "Vacuum", "psql -c 'vacuum'", "pkg_db"),
];

function summary(groups: ReturnType<typeof buildSnippetPackageGroups>) {
  return groups.map((group) => [group.key, group.snippets.map((s) => s.id)]);
}

describe("buildSnippetPackageGroups", () => {
  it("lists loose snippets first, then every package, empty ones included", () => {
    expect(summary(buildSnippetPackageGroups({ packages, snippets, query: "" }))).toEqual([
      ["none", ["snp_uname"]],
      ["pkg_deploy", ["snp_pull", "snp_restart"]],
      ["pkg_db", ["snp_vacuum"]],
      ["pkg_empty", []],
    ]);
  });

  it("matches labels and scripts, hiding packages with nothing to show", () => {
    expect(summary(buildSnippetPackageGroups({ packages, snippets, query: "RESTART" }))).toEqual([
      ["pkg_deploy", ["snp_restart"]],
    ]);
  });

  it("shows a whole package when its name matches", () => {
    expect(summary(buildSnippetPackageGroups({ packages, snippets, query: "data" }))).toEqual([
      ["pkg_db", ["snp_vacuum"]],
    ]);
  });

  it("treats a snippet of an unknown package as loose", () => {
    const orphan = snippet("snp_orphan", "Orphan", "true", "pkg_gone");
    expect(
      summary(buildSnippetPackageGroups({ packages: [], snippets: [orphan], query: "" })),
    ).toEqual([["none", ["snp_orphan"]]]);
  });
});

describe("server selection by group", () => {
  const groups = [
    { id: "grp_prod", label: "Production" },
    { id: "grp_prod_eu", label: "EU", parentId: "grp_prod" },
    { id: "grp_dev", label: "Dev" },
  ];
  const servers = [
    { id: "srv_a", groupId: "grp_prod" },
    { id: "srv_b", groupId: "grp_prod_eu" },
    { id: "srv_c", groupId: "grp_dev" },
    { id: "srv_d" },
  ];

  it("includes the servers of sub-groups", () => {
    expect(serverIdsInGroup("grp_prod", servers, groups)).toEqual(["srv_a", "srv_b"]);
    expect(serverIdsInGroup("grp_prod_eu", servers, groups)).toEqual(["srv_b"]);
  });

  it("adds a group's servers, and removes them once all are selected", () => {
    const added = toggleGroupSelection(["srv_c", "srv_a"], ["srv_a", "srv_b"]);
    expect(added).toEqual(["srv_c", "srv_a", "srv_b"]);
    expect(toggleGroupSelection(added, ["srv_a", "srv_b"])).toEqual(["srv_c"]);
  });
});

describe("filterHistory", () => {
  it("keeps entries whose command contains the query, case-insensitively", () => {
    const entries = [
      { command: "docker ps", source: "input" as const, atMs: 2 },
      { command: "uname -a", source: "snippet" as const, atMs: 1 },
    ];
    expect(filterHistory(entries, " DOCKER ")).toEqual([entries[0]]);
    expect(filterHistory(entries, "")).toEqual(entries);
  });
});

describe("terminalAppearanceOverride", () => {
  it("gives the nearest group's palette and font size to an SSH tab", () => {
    const groups = [
      { id: "grp_prod", theme: "midnight", fontSize: 15 },
      { id: "grp_prod_eu", parentId: "grp_prod", fontSize: 12 },
    ];

    expect(terminalAppearanceOverride({ groupId: "grp_prod_eu" }, groups)).toEqual({
      palette: darkMidnightTheme.colors.terminal,
      fontSize: 12,
    });
    expect(terminalAppearanceOverride({}, groups)).toEqual({ palette: null, fontSize: null });
  });
});
