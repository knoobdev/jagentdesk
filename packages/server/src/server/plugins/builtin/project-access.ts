import path from "node:path";
import type { ProjectRegistry, WorkspaceRegistry } from "../../workspace-registry.js";
import type { BuiltinProject, BuiltinProjectAccess } from "./host.js";

interface ProjectAccessDeps {
  projectRegistry: Pick<ProjectRegistry, "list" | "get">;
  workspaceRegistry: Pick<WorkspaceRegistry, "get">;
  workspaceIdOf(agentId: string): Promise<string | undefined>;
  cwdOf(agentId: string): Promise<string | undefined>;
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function createBuiltinProjectAccess(deps: ProjectAccessDeps): BuiltinProjectAccess {
  async function activeProjects(): Promise<BuiltinProject[]> {
    return (await deps.projectRegistry.list())
      .filter((project) => !project.archivedAt)
      .map((project) => ({
        projectId: project.projectId,
        name: project.customName ?? project.displayName,
        rootPath: project.rootPath,
      }));
  }
  return {
    list: activeProjects,
    async forAgent(agentId) {
      const workspaceId = await deps.workspaceIdOf(agentId);
      const workspace = workspaceId ? await deps.workspaceRegistry.get(workspaceId) : null;
      const projects = await activeProjects();
      if (workspace) {
        const project = projects.find((entry) => entry.projectId === workspace.projectId);
        if (project) return project;
      }
      // Agents placed before workspaces existed: the deepest project root holding the cwd.
      const cwd = workspace?.cwd ?? (await deps.cwdOf(agentId));
      if (!cwd) return null;
      return (
        projects
          .filter((project) => isWithin(project.rootPath, cwd))
          .sort((left, right) => right.rootPath.length - left.rootPath.length)[0] ?? null
      );
    },
  };
}
