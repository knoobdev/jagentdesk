import { useCallback } from "react";
import type { JiraIssueCard, JiraSprint } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import { CompleteSprintDialog } from "../board/complete-sprint-dialog";
import { MoveToSprintSheet, type BlockId } from "./move-sheet";
import { CreateSprintDialog, StartSprintDialog } from "./sprint-dialogs";

// The sheets the backlog opens, and the sprint buttons that open them.

export type BacklogDialog =
  | { kind: "start"; sprint: JiraSprint }
  | { kind: "complete"; sprint: JiraSprint; openIssues: number }
  | { kind: "create" }
  | { kind: "move"; issue: JiraIssueCard; current: BlockId | null }
  | null;

export function SprintActions({
  sprint,
  issues,
  onDialog,
}: {
  sprint: JiraSprint | null;
  issues: JiraIssueCard[];
  onDialog: (dialog: BacklogDialog) => void;
}) {
  const start = useCallback(() => {
    if (sprint) onDialog({ kind: "start", sprint });
  }, [onDialog, sprint]);
  const complete = useCallback(() => {
    if (!sprint) return;
    const openIssues = issues.filter((issue) => issue.status.category !== "done").length;
    onDialog({ kind: "complete", sprint, openIssues });
  }, [issues, onDialog, sprint]);
  if (sprint?.state === "future") {
    return (
      <Button size="sm" variant="outline" onPress={start} testID={`jira-start-sprint-${sprint.id}`}>
        Start sprint
      </Button>
    );
  }
  if (sprint?.state === "active") {
    return (
      <Button
        size="sm"
        variant="outline"
        onPress={complete}
        testID={`jira-complete-sprint-${sprint.id}`}
      >
        Complete sprint
      </Button>
    );
  }
  return null;
}

export function BacklogDialogs({
  dialog,
  serverId,
  connectionId,
  boardId,
  sprints,
  suggestedSprintName,
  onClose,
  onMove,
}: {
  dialog: BacklogDialog;
  serverId: string;
  connectionId: string;
  boardId: number;
  sprints: JiraSprint[];
  suggestedSprintName: string;
  onClose: () => void;
  onMove: (issueKeys: string[], target: BlockId) => void;
}) {
  const movingKey = dialog?.kind === "move" ? dialog.issue.key : null;
  const pickTarget = useCallback(
    (target: BlockId) => {
      onClose();
      if (movingKey) onMove([movingKey], target);
    },
    [movingKey, onClose, onMove],
  );
  switch (dialog?.kind) {
    case "move":
      return (
        <MoveToSprintSheet
          title={`Move ${dialog.issue.key} to…`}
          sprints={sprints}
          current={dialog.current}
          onClose={onClose}
          onPick={pickTarget}
        />
      );
    case "start":
      return (
        <StartSprintDialog
          serverId={serverId}
          connectionId={connectionId}
          sprint={dialog.sprint}
          onClose={onClose}
        />
      );
    case "complete":
      return (
        <CompleteSprintDialog
          serverId={serverId}
          connectionId={connectionId}
          boardId={boardId}
          sprint={dialog.sprint}
          openIssueCount={dialog.openIssues}
          onClose={onClose}
        />
      );
    case "create":
      return (
        <CreateSprintDialog
          serverId={serverId}
          connectionId={connectionId}
          boardId={boardId}
          suggestedName={suggestedSprintName}
          onClose={onClose}
        />
      );
    default:
      return null;
  }
}
