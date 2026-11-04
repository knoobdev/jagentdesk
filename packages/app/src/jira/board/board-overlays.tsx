import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  JIRA_BOARD_MAX_ISSUES,
  type JiraBoardColumn,
  type JiraIssueCard,
  type JiraSprint,
  type JiraSwimlaneConfig,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { ErrorBanner } from "../ui/primitives";
import { CompleteSprintDialog } from "./complete-sprint-dialog";
import { MoveToColumnSheet } from "./move-to-sheet";
import { SwimlaneSheet } from "./swimlane-sheet";
import type { TransitionFlowState } from "./transition-flow";

// What the board shows on top of the grid: error banners and its sheets.

export type BoardOverlay =
  | { kind: "move"; issue: JiraIssueCard }
  | { kind: "complete" }
  | { kind: "lanes" }
  | null;

export function BoardBanners({
  loadError,
  flowState,
  rankError,
  truncated,
  onDismissFlow,
}: {
  loadError: string | null;
  flowState: TransitionFlowState;
  rankError: string | null;
  truncated: boolean;
  onDismissFlow: () => void;
}) {
  const dismiss = useMemo(
    () => (
      <Button variant="ghost" size="sm" onPress={onDismissFlow}>
        Dismiss
      </Button>
    ),
    [onDismissFlow],
  );
  return (
    <View style={styles.banners}>
      {loadError ? <ErrorBanner message={loadError} /> : null}
      {flowState.kind === "failed" ? (
        <ErrorBanner message={flowState.message} action={dismiss} />
      ) : null}
      {rankError ? <ErrorBanner message={rankError} /> : null}
      {truncated ? (
        // Informational, not an error: the board is past the safety ceiling.
        <View style={styles.notice} testID="jira-board-truncated">
          <Text style={styles.noticeText}>
            {`Showing the first ${JIRA_BOARD_MAX_ISSUES.toLocaleString("en-US")} issues of this board. Use a quick filter to narrow it.`}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function BoardOverlays({
  overlay,
  serverId,
  connectionId,
  boardId,
  columns,
  sprint,
  swimlanes,
  openIssueCount,
  onClose,
  onMoveToColumn,
}: {
  overlay: BoardOverlay;
  serverId: string;
  connectionId: string;
  boardId: number;
  columns: JiraBoardColumn[];
  sprint: JiraSprint | null;
  swimlanes: JiraSwimlaneConfig | null;
  openIssueCount: number;
  onClose: () => void;
  onMoveToColumn: (issue: JiraIssueCard, columnIndex: number) => void;
}) {
  const movingIssue = overlay?.kind === "move" ? overlay.issue : null;
  const pickColumn = useCallback(
    (columnIndex: number) => {
      onClose();
      if (movingIssue) onMoveToColumn(movingIssue, columnIndex);
    },
    [movingIssue, onClose, onMoveToColumn],
  );
  if (movingIssue) {
    return (
      <MoveToColumnSheet
        issue={movingIssue}
        columns={columns}
        onClose={onClose}
        onPick={pickColumn}
      />
    );
  }
  if (overlay?.kind === "complete" && sprint) {
    return (
      <CompleteSprintDialog
        serverId={serverId}
        connectionId={connectionId}
        boardId={boardId}
        sprint={sprint}
        openIssueCount={openIssueCount}
        onClose={onClose}
      />
    );
  }
  if (overlay?.kind === "lanes" && swimlanes) {
    return (
      <SwimlaneSheet
        serverId={serverId}
        connectionId={connectionId}
        boardId={boardId}
        current={swimlanes}
        onClose={onClose}
      />
    );
  }
  return null;
}

const styles = StyleSheet.create((theme: Theme) => ({
  banners: { paddingHorizontal: theme.spacing[4], gap: theme.spacing[2] },
  notice: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  noticeText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
}));
