import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { WorkspaceTitleSource } from "@/hooks/use-settings";
import { STATUS_BUCKET_LABELS } from "@/hooks/sidebar-status-view-model";

export function resolveSidebarWorkspacePrimaryLabel(input: {
  workspace: Pick<SidebarWorkspaceEntry, "name" | "currentBranch"> & { title?: string | null };
  workspaceTitleSource: WorkspaceTitleSource;
  /**
   * Distinct label to use when the workspace has no custom title — its active
   * chat's title. Keeps otherwise-identical untitled workspaces (e.g. several
   * local checkouts on the same branch) tellable apart instead of all showing
   * the bare branch name.
   */
  fallbackTitle?: string | null;
}): string {
  const title = input.workspace.title?.trim();
  if (input.workspaceTitleSource === "branch") {
    return input.workspace.currentBranch ?? title ?? input.workspace.name;
  }
  return title || input.fallbackTitle?.trim() || input.workspace.name;
}

export function resolveSidebarWorkspaceAccessibilityLabel(input: {
  workspace: Pick<SidebarWorkspaceEntry, "name" | "currentBranch" | "statusBucket">;
  workspaceTitleSource: WorkspaceTitleSource;
  leadingProjectName?: string | null;
  hostBadgeLabel?: string | null;
  pullRequestLabel?: string | null;
  scriptLabel?: string | null;
}): string {
  return [
    input.leadingProjectName,
    resolveSidebarWorkspacePrimaryLabel(input),
    input.hostBadgeLabel,
    input.pullRequestLabel,
    input.scriptLabel,
    input.workspace.statusBucket === "done"
      ? null
      : STATUS_BUCKET_LABELS[input.workspace.statusBucket],
  ]
    .filter((label): label is string => Boolean(label))
    .join(", ");
}
