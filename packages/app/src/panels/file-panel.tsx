import { useOpenOutsideWorkspaceFolder } from "@/workspace/open-in-file-manager/outside-folder";
import { Text, View } from "react-native";
import { useMemo, useEffect } from "react";
import invariant from "tiny-invariant";
import { useTranslation } from "react-i18next";
import { FilePanelView } from "@/file-panels/view";
import {
  AssistantFileLinkResolverProvider,
  createInlinePathOpener,
  type InlinePathTarget,
} from "@/assistant-file-links";
import { useFileExplorerActions } from "@/hooks/use-file-explorer-actions";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { OpenFileDisposition, WorkspaceFileLocation } from "@/workspace/file-open";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { createMaterialFileIcon } from "@/components/material-file-icon";

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function useFilePanelDescriptor(target: { kind: "file"; path: string }) {
  const fileName = target.path.split("/").findLast(Boolean) ?? target.path;
  const icon = useMemo(() => createMaterialFileIcon(fileName), [fileName]);
  return {
    label: fileName,
    subtitle: target.path,
    tooltip: target.path,
    titleState: "ready" as const,
    icon,
    statusBucket: null,
  };
}

function FilePanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target, fileNavigationRevision, openFileInWorkspace } =
    usePaneContext();
  const workspaceDirectory = useWorkspaceDirectory(serverId, workspaceId);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const isActive = useRetainedPanelActive();
  const isCompact = useIsCompactFormFactor();
  const { revealDirectory } = useFileExplorerActions({
    serverId,
    workspaceId,
    workspaceRoot: workspaceDirectory,
  });
  const openFile = useStableEvent(
    (location: WorkspaceFileLocation, disposition: OpenFileDisposition) =>
      openFileInWorkspace({ location, disposition }),
  );
  const openDirectory = useStableEvent((directoryPath: string) => {
    if (!workspaceDirectory) return;
    void revealDirectory(directoryPath);
    const panel = usePanelStore.getState();
    const checkout = { serverId, cwd: workspaceDirectory, isGit: true };
    panel.setExplorerTabForCheckout({ ...checkout, tab: "files" });
    panel.openFileExplorerForCheckout({ isCompact, checkout });
  });
  const openOutsideDirectory = useOpenOutsideWorkspaceFolder(serverId);
  const opener = useMemo(
    () =>
      createInlinePathOpener({
        workspaceRoot: workspaceDirectory ?? "",
        client,
        openFile,
        openDirectory,
        openOutsideDirectory,
      }),
    [workspaceDirectory, client, openFile, openDirectory, openOutsideDirectory],
  );
  useEffect(() => {
    if (!isActive) opener.cancel();
    return () => opener.cancel();
  }, [opener, isActive, target]);
  const openPath = useStableEvent((path: InlinePathTarget, disposition: OpenFileDisposition) => {
    if (isActive) void opener.open(path, disposition);
  });
  invariant(target.kind === "file", "FilePanel requires file target");
  if (!workspaceDirectory) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return (
    <AssistantFileLinkResolverProvider
      client={client}
      serverId={serverId}
      workspaceRoot={workspaceDirectory}
      onOpenWorkspaceFile={openPath}
    >
      <FilePanelView
        workspaceId={workspaceId}
        serverId={serverId}
        workspaceRoot={workspaceDirectory}
        location={target}
        navigationRevision={fileNavigationRevision ?? 0}
      />
    </AssistantFileLinkResolverProvider>
  );
}

export const filePanelRegistration: PanelRegistration<"file"> = {
  kind: "file",
  component: FilePanel,
  useDescriptor: useFilePanelDescriptor,
};
