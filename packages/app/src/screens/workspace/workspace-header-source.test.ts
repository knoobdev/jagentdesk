import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { formatCompactWorkspaceTitle } from "./workspace-header-source";

function workspace(name: string, projectDisplayName: string): WorkspaceDescriptor {
  return {
    id: "workspace-1",
    projectId: "project-1",
    projectDisplayName,
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "checkout",
    name,
    title: null,
    pinnedAt: null,
    status: "running",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    background: false,
  };
}

describe("formatCompactWorkspaceTitle", () => {
  it("joins project and branch", () => {
    expect(formatCompactWorkspaceTitle(workspace("main", "jagentdesk"))).toBe("jagentdesk · main");
  });

  it("shows one name when project and workspace match", () => {
    expect(formatCompactWorkspaceTitle(workspace("Repo", "repo"))).toBe("Repo");
  });

  it("falls back to the workspace name without a project name", () => {
    expect(formatCompactWorkspaceTitle(workspace("main", "  "))).toBe("main");
  });
});
