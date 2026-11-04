import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";
import type { JiraIssueCard, JiraUser } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import { useJiraCall } from "../api";
import { useJiraBoardConfig, useJiraBoardIssues, useJiraInvalidate } from "../queries";
import { useBoardWatch } from "../use-view-watch";
import { EmptyState, ErrorBanner } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { BoardBanners, BoardOverlays, type BoardOverlay } from "./board-overlays";
import { BoardGrid, columnIndexOf, parseColumnDropId } from "./columns";
import { DndProvider } from "./dnd";
import { QuickCreate } from "./quick-create";
import { Spinner } from "./spinner";
import { BoardToolbar, type BoardFilterState } from "./toolbar";
import { TransitionDialogs } from "./transition-dialog";
import { busyIssueKey, useTransitionFlow } from "./transition-flow";
import { useAction } from "./use-action";

// The board (spec 29.3): Kanban, or the active sprint of a Scrum board. Dropping a card in another
// column (or "Move to…") transitions it; dropping it on a card of the same column ranks it before
// that card. While open, the daemon polls Jira every 15 s for changes (useBoardWatch).

export interface BoardViewProps {
  serverId: string;
  connectionId: string;
  boardId: number;
  active: boolean;
  onOpenIssue: (issueKey: string) => void;
  onOpenBacklog: () => void;
}

const EMPTY_FILTER: BoardFilterState = { quickFilterIds: [], text: "", assigneeRefs: [] };

function matchesLocalFilter(issue: JiraIssueCard, filter: BoardFilterState): boolean {
  const text = filter.text.trim().toLowerCase();
  const textOk =
    text.length === 0 ||
    issue.key.toLowerCase().includes(text) ||
    issue.summary.toLowerCase().includes(text);
  const assigneeOk =
    filter.assigneeRefs.length === 0 ||
    (issue.assignee !== null && filter.assigneeRefs.includes(issue.assignee.ref));
  return textOk && assigneeOk;
}

function uniqueAssignees(issues: JiraIssueCard[]): JiraUser[] {
  const byRef = new Map<string, JiraUser>();
  for (const issue of issues) if (issue.assignee) byRef.set(issue.assignee.ref, issue.assignee);
  return [...byRef.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function Loading() {
  return (
    <View style={jiraStyles.empty}>
      <Spinner size="small" />
    </View>
  );
}

function NoActiveSprint({ onOpenBacklog }: { onOpenBacklog: () => void }) {
  const action = useMemo(
    () => (
      <Button variant="outline" onPress={onOpenBacklog}>
        Open backlog
      </Button>
    ),
    [onOpenBacklog],
  );
  return (
    <EmptyState
      title="No active sprint"
      body="Start a sprint from the backlog to see it here."
      action={action}
    />
  );
}

type BoardConfigData = ReturnType<typeof useJiraBoardConfig>["data"];
type BoardIssuesData = ReturnType<typeof useJiraBoardIssues>["data"];

function useBoardData(
  configuration: BoardConfigData,
  data: BoardIssuesData,
  filter: BoardFilterState,
) {
  const allIssues = useMemo(() => data?.issues ?? [], [data]);
  const visibleIssues = useMemo(
    () => allIssues.filter((issue) => matchesLocalFilter(issue, filter)),
    [allIssues, filter],
  );
  const assignees = useMemo(() => uniqueAssignees(allIssues), [allIssues]);
  const columns = useMemo(() => configuration?.columns ?? [], [configuration]);
  const openIssueCount = useMemo(
    () => allIssues.filter((issue) => issue.status.category !== "done").length,
    [allIssues],
  );
  return {
    allIssues,
    visibleIssues,
    assignees,
    columns,
    rankFieldId: configuration?.rankFieldId ?? null,
    sprint: data?.sprint ?? null,
    openIssueCount,
  };
}

export function BoardView({
  serverId,
  connectionId,
  boardId,
  active,
  onOpenIssue,
  onOpenBacklog,
}: BoardViewProps) {
  useBoardWatch({ serverId, connectionId, boardId, active });
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const [filter, setFilter] = useState<BoardFilterState>(EMPTY_FILTER);
  const serverFilter = useMemo(
    () => ({ quickFilterIds: filter.quickFilterIds }),
    [filter.quickFilterIds],
  );
  const config = useJiraBoardConfig(serverId, connectionId, boardId);
  const board = useJiraBoardIssues(serverId, connectionId, boardId, serverFilter);
  const flow = useTransitionFlow({ serverId, connectionId });
  const { start: startTransition, cancel: cancelFlow } = flow;
  const rank = useAction();
  const { run: runRank } = rank;
  const [overlay, setOverlay] = useState<BoardOverlay>(null);

  const { allIssues, visibleIssues, assignees, columns, rankFieldId, sprint, openIssueCount } =
    useBoardData(config.data, board.data, filter);
  const sprintId = sprint?.id ?? null;

  const moveToColumn = useCallback(
    (issue: JiraIssueCard, columnIndex: number) => {
      const column = columns[columnIndex];
      if (!column || column.statusIds.includes(issue.status.id)) return;
      void startTransition({ issue, column });
    },
    [columns, startTransition],
  );

  const rankBefore = useCallback(
    (issueKey: string, beforeKey: string) =>
      void runRank(async () => {
        await call("jira.issue.rank.request", {
          connectionId,
          issueKeys: [issueKey],
          rankBeforeKey: beforeKey,
          ...(rankFieldId ? { rankFieldId } : {}),
        });
        await invalidate();
      }),
    [call, connectionId, invalidate, rankFieldId, runRank],
  );

  const handleDrop = useCallback(
    (dragKey: string, dropId: string) => {
      const dragged = allIssues.find((issue) => issue.key === dragKey);
      if (!dragged) return;
      const columnIndex = parseColumnDropId(dropId);
      if (columnIndex !== null) {
        moveToColumn(dragged, columnIndex);
        return;
      }
      const target = allIssues.find((issue) => issue.key === dropId);
      if (!target) return;
      const targetColumn = columnIndexOf(columns, target.status.id);
      if (targetColumn !== columnIndexOf(columns, dragged.status.id)) {
        moveToColumn(dragged, targetColumn);
        return;
      }
      rankBefore(dragged.key, target.key);
    },
    [allIssues, columns, moveToColumn, rankBefore],
  );

  const renderColumnFooter = useCallback(
    (columnIndex: number) => (
      <QuickCreate
        serverId={serverId}
        connectionId={connectionId}
        boardId={boardId}
        sprintId={sprintId}
        columnIndex={columnIndex}
        onCreated={moveToColumn}
      />
    ),
    [boardId, connectionId, moveToColumn, serverId, sprintId],
  );
  const openMove = useCallback((issue: JiraIssueCard) => setOverlay({ kind: "move", issue }), []);
  const openComplete = useCallback(() => setOverlay({ kind: "complete" }), []);
  const openLanes = useCallback(() => setOverlay({ kind: "lanes" }), []);
  const closeOverlay = useCallback(() => setOverlay(null), []);

  if (config.error) return <ErrorBanner message={config.error.message} />;
  if (!config.data) return <Loading />;
  const configuration = config.data;
  const noActiveSprint =
    configuration.type === "scrum" && board.data !== undefined && sprint === null;

  return (
    <View style={jiraStyles.main}>
      <BoardToolbar
        configuration={configuration}
        sprint={sprint}
        assignees={assignees}
        filter={filter}
        swimlaneMode={board.data?.swimlanes.mode ?? "none"}
        onFilterChange={setFilter}
        onCompleteSprint={openComplete}
        onSwimlanes={openLanes}
      />
      <BoardBanners
        loadError={board.error?.message ?? null}
        flowState={flow.state}
        rankError={rank.error}
        truncated={board.data?.truncated === true}
        onDismissFlow={cancelFlow}
      />
      {noActiveSprint ? <NoActiveSprint onOpenBacklog={onOpenBacklog} /> : null}
      {!noActiveSprint ? (
        <DndProvider onDrop={handleDrop}>
          <BoardGrid
            configuration={configuration}
            issues={visibleIssues}
            lanes={board.data?.lanes ?? []}
            busyKey={busyIssueKey(flow.state)}
            onOpenIssue={onOpenIssue}
            onMoveIssue={openMove}
            renderColumnFooter={renderColumnFooter}
          />
        </DndProvider>
      ) : null}
      {board.isLoading ? <Loading /> : null}
      <TransitionDialogs flow={flow} />
      <BoardOverlays
        overlay={overlay}
        serverId={serverId}
        connectionId={connectionId}
        boardId={boardId}
        columns={columns}
        sprint={sprint}
        swimlanes={board.data?.swimlanes ?? null}
        openIssueCount={openIssueCount}
        onClose={closeOverlay}
        onMoveToColumn={moveToColumn}
      />
    </View>
  );
}
