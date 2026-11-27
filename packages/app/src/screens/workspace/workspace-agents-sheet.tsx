import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import {
  OrchestrationAgentsColumn,
  useWorkspaceAgentsRoster,
  useWorkspaceOrchestrationRosterCount,
  WorkspaceAgentsList,
} from "./orchestration-agents-column";

/**
 * The roster on compact layouts: phones get the sheet (opened from the header's Workspace agents
 * button), a single-pane desktop keeps the inline column above the tab switcher.
 */
export function CompactWorkspaceAgents({
  serverId,
  workspaceId,
  isMobile,
  sheetVisible,
  onCloseSheet,
}: {
  serverId: string;
  workspaceId: string;
  isMobile: boolean;
  sheetVisible: boolean;
  onCloseSheet: () => void;
}) {
  const rosterCount = useWorkspaceOrchestrationRosterCount(serverId, workspaceId);
  if (rosterCount === 0) return null;
  if (!isMobile) {
    return <OrchestrationAgentsColumn serverId={serverId} workspaceId={workspaceId} compact />;
  }
  return (
    <WorkspaceAgentsSheet
      serverId={serverId}
      workspaceId={workspaceId}
      visible={sheetVisible}
      onClose={onCloseSheet}
    />
  );
}

/**
 * The phone's Workspace agents (spec 37.4.2): the desktop's left column — Supervisor → Lead →
 * Peer, with the bot chat that started a worker — in a sheet opened from the workspace header.
 */
export function WorkspaceAgentsSheet({
  serverId,
  workspaceId,
  visible,
  onClose,
}: {
  serverId: string;
  workspaceId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const roster = useWorkspaceAgentsRoster(serverId, workspaceId);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("bots.jad.panels.workspaceAgents.title"),
      subtitle: t("bots.jad.panels.workspaceAgents.subtitle"),
    }),
    [t],
  );
  return (
    <AdaptiveModalSheet
      visible={visible}
      header={header}
      onClose={onClose}
      snapPoints={SNAP_POINTS}
      testID="workspace-agents-sheet"
    >
      <View style={styles.list}>
        <WorkspaceAgentsList
          serverId={serverId}
          workspaceId={workspaceId}
          roster={roster}
          onOpen={onClose}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

const SNAP_POINTS = ["45%", "85%"];

const styles = StyleSheet.create((theme) => ({
  list: { gap: theme.spacing[2] },
}));
