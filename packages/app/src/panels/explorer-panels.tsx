import { useCallback } from "react";
import { View } from "react-native";
import { FolderTree, GitPullRequest, ListTree } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { FilesPane, ChangedFilesPane, PrTabContent } from "@/components/explorer-sidebar";
import { usePrPaneData } from "@/git/pull-request-panel";
import { useCheckoutGitActionsStore } from "@/git/actions-store";
import { buildWorkspaceAttachmentScopeKey } from "@/attachments/workspace-attachments-store";
import { useToast } from "@/contexts/toast-context";

function FilesPanel() {
  const { serverId, workspaceId, openFileInWorkspace } = usePaneContext();
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const openFile = useCallback(
    (path: string) => openFileInWorkspace({ location: { path }, disposition: "main" }),
    [openFileInWorkspace],
  );
  return workspaceRoot ? (
    <FilesPane
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      onOpenFile={openFile}
    />
  ) : (
    <View />
  );
}
function ChangesTreePanel() {
  const { serverId, workspaceId, openFileInWorkspace } = usePaneContext();
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const openFile = useCallback(
    (path: string) => openFileInWorkspace({ location: { path }, disposition: "main" }),
    [openFileInWorkspace],
  );
  return workspaceRoot ? (
    <ChangedFilesPane
      serverId={serverId}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      isOpen
      onOpenFile={openFile}
    />
  ) : (
    <View />
  );
}
function PullRequestPanel() {
  const { serverId, workspaceId } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  const prPane = usePrPaneData({
    serverId,
    cwd,
    enabled: Boolean(cwd),
    timelineEnabled: Boolean(cwd),
  });
  const refresh = useCheckoutGitActionsStore((s) => s.refresh);
  const toast = useToast();
  const retry = useCallback(() => {
    void refresh({ serverId, cwd }).catch((error) => toast.error(String(error)));
  }, [refresh, serverId, cwd, toast]);
  return (
    <PrTabContent
      serverId={serverId}
      cwd={cwd}
      prPane={prPane}
      workspaceAttachmentScopeKey={buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd })}
      onRetry={retry}
    />
  );
}
function useFilesDescriptor() {
  const { t } = useTranslation();
  const label = t("workspace.tabs.explorer.files");
  return {
    label,
    subtitle: label,
    tooltip: label,
    titleState: "ready" as const,
    icon: FolderTree,
    statusBucket: null,
  };
}
function useChangesDescriptor() {
  const { t } = useTranslation();
  const label = t("workspace.tabs.explorer.changes");
  return {
    label,
    subtitle: label,
    tooltip: label,
    titleState: "ready" as const,
    icon: ListTree,
    statusBucket: null,
  };
}
function usePrDescriptor() {
  const { t } = useTranslation();
  const label = t("panels.pullRequest.label");
  return {
    label,
    subtitle: label,
    tooltip: label,
    titleState: "ready" as const,
    icon: GitPullRequest,
    statusBucket: null,
  };
}
export const filesPanelRegistration: PanelRegistration<"files"> = {
  kind: "files",
  component: FilesPanel,
  useDescriptor: useFilesDescriptor,
};
export const changesTreePanelRegistration: PanelRegistration<"changes_tree"> = {
  kind: "changes_tree",
  component: ChangesTreePanel,
  useDescriptor: useChangesDescriptor,
};
export const pullRequestPanelRegistration: PanelRegistration<"pull_request"> = {
  kind: "pull_request",
  component: PullRequestPanel,
  useDescriptor: usePrDescriptor,
};
