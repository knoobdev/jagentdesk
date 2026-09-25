import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { normalizeWorkspaceDescriptor, useSessionStore } from "@/stores/session-store";

function normalizePath(path: string | null | undefined): string {
  return (path ?? "").replace(/\/+$/, "");
}

/** The project a dock chat runs in, found from its working directory in the host's session. */
function findProjectIdForDirectory(serverId: string, cwd: string): string | undefined {
  const session = useSessionStore.getState().sessions[serverId];
  const target = normalizePath(cwd);
  for (const workspace of session?.workspaces?.values() ?? []) {
    if (
      workspace.projectId &&
      (normalizePath(workspace.workspaceDirectory) === target ||
        normalizePath(workspace.projectRootPath) === target)
    ) {
      return workspace.projectId;
    }
  }
  for (const project of session?.projects?.values() ?? []) {
    if (project.projectId && normalizePath(project.projectRootPath) === target) {
      return project.projectId;
    }
  }
  return undefined;
}

/**
 * A screen dock chat (SimFleet, database, cluster) gets its own workspace in the chosen project,
 * the way "+ New" does, so it is listed under the project in the sidebar. Without it the daemon
 * files the agent into whichever workspace already uses that directory — another conversation's.
 * A dock chat must always belong to a workspace in a project: when the workspace cannot be
 * created this throws, and the draft composer shows the error instead of creating an agent.
 */
export async function createDockWorkspace(input: {
  client: DaemonClient;
  serverId: string;
  cwd: string;
  title?: string;
}): Promise<{ workspaceId: string; cwd: string }> {
  const projectId = findProjectIdForDirectory(input.serverId, input.cwd);
  if (!projectId) {
    throw new Error(
      `Open a project for ${input.cwd} first — the chat runs in a project workspace.`,
    );
  }
  const payload = await input.client.createWorkspace({
    source: { kind: "directory", path: input.cwd, projectId },
    ...(input.title ? { title: input.title } : {}),
  });
  if (payload.error || !payload.workspace) {
    throw new Error(payload.error ?? "Could not create a workspace for this chat.");
  }
  const workspace = normalizeWorkspaceDescriptor(payload.workspace);
  useSessionStore.getState().mergeWorkspaces(input.serverId, [workspace]);
  return { workspaceId: workspace.id, cwd: workspace.workspaceDirectory || input.cwd };
}
