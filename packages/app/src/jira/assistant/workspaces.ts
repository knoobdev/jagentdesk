import type { WorkspaceDescriptor } from "@/stores/session-store";

// Workspaces on the host an agent can run in, most recent first by the store's order.

export function usableWorkspaces(
  workspaces: Map<string, WorkspaceDescriptor> | undefined,
): WorkspaceDescriptor[] {
  return [...(workspaces?.values() ?? [])].filter(
    (workspace) =>
      !workspace.archivingAt && (workspace.workspaceDirectory || workspace.projectRootPath),
  );
}

export function workspaceDirectory(workspace: WorkspaceDescriptor): string {
  return workspace.workspaceDirectory || workspace.projectRootPath;
}

export function firstWorkspaceDirectory(
  workspaces: Map<string, WorkspaceDescriptor> | undefined,
): string | null {
  const first = usableWorkspaces(workspaces)[0];
  return first ? workspaceDirectory(first) : null;
}
