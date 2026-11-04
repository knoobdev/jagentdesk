import { useCallback, useMemo, useState } from "react";
import { ScrollView, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Plus } from "lucide-react-native";
import type { JiraIssueCard, JiraSprint } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Button } from "@/components/ui/button";
import type { Theme } from "@/styles/theme";
import { useJiraCall } from "../api";
import { useJiraBacklog, useJiraBoardConfig, useJiraInvalidate } from "../queries";
import { useBoardWatch } from "../use-view-watch";
import { Chip, EmptyState, ErrorBanner } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";
import { DndProvider } from "../board/dnd";
import { Spinner } from "../board/spinner";
import { useAction } from "../board/use-action";
import { BacklogBlock, parseBlockDropId } from "./backlog-block";
import { BacklogDialogs, type BacklogDialog } from "./backlog-dialogs";
import { EpicPanel, VersionPanel, type BacklogPanel } from "./backlog-panels";
import { BulkBar } from "./bulk-bar";
import type { BlockId } from "./move-sheet";
import { formatSprintDates } from "./sprint-dialogs";

// The backlog (spec 29.3): sprints on top, Backlog below; create/start/complete sprints; drag to
// rank and to move between sprints (web) or "Move to…"; multi-select for bulk changes; epic and
// version panels. Polled like the board while open.

export interface BacklogViewProps {
  serverId: string;
  connectionId: string;
  boardId: number;
  active: boolean;
  onOpenIssue: (issueKey: string) => void;
}

interface Block {
  id: BlockId;
  sprint: JiraSprint | null;
  issues: JiraIssueCard[];
}

function blockOf(blocks: Block[], issueKey: string): Block | null {
  return blocks.find((block) => block.issues.some((issue) => issue.key === issueKey)) ?? null;
}

function sprintMeta(sprint: JiraSprint | null): string | null {
  if (!sprint) return null;
  const state = sprint.state === "active" ? "Active" : "Future";
  const dates = formatSprintDates(sprint);
  return dates ? `${state} · ${dates}` : state;
}

type BacklogData = NonNullable<ReturnType<typeof useJiraBacklog>["data"]>;

function useBlocks(data: BacklogData | undefined, epicKey: string | null) {
  const blocks = useMemo<Block[]>(() => {
    if (!data) return [];
    const keep = (issues: JiraIssueCard[]) =>
      epicKey ? issues.filter((issue) => issue.parent?.key === epicKey) : issues;
    return [
      ...data.sprints.map((entry) => ({
        id: entry.sprint.id,
        sprint: entry.sprint,
        issues: keep(entry.issues),
      })),
      { id: "backlog" as const, sprint: null, issues: keep(data.backlog) },
    ];
  }, [data, epicKey]);
  const openSprints = useMemo(
    () =>
      (data?.sprints ?? [])
        .map((entry) => entry.sprint)
        .filter((sprint) => sprint.state !== "closed"),
    [data],
  );
  const allIssues = useMemo(() => blocks.flatMap((block) => block.issues), [blocks]);
  return { blocks, openSprints, allIssues };
}

function BacklogToolbar({
  panel,
  pending,
  sprintsEnabled,
  onPanel,
  onCreateSprint,
}: {
  panel: BacklogPanel;
  pending: boolean;
  sprintsEnabled: boolean;
  onPanel: (panel: BacklogPanel) => void;
  onCreateSprint: () => void;
}) {
  const toggleEpics = useCallback(
    () => onPanel(panel === "epics" ? "none" : "epics"),
    [onPanel, panel],
  );
  const toggleVersions = useCallback(
    () => onPanel(panel === "versions" ? "none" : "versions"),
    [onPanel, panel],
  );
  return (
    <View style={styles.toolbar}>
      <Chip
        label="Epics"
        active={panel === "epics"}
        onPress={toggleEpics}
        testID="jira-backlog-epics"
      />
      <Chip
        label="Versions"
        active={panel === "versions"}
        onPress={toggleVersions}
        testID="jira-backlog-versions"
      />
      <View style={jiraStyles.spacer} />
      {pending ? <Spinner size="small" /> : null}
      {sprintsEnabled ? (
        <Button
          variant="secondary"
          size="sm"
          leftIcon={Plus}
          onPress={onCreateSprint}
          testID="jira-create-sprint"
        >
          Create sprint
        </Button>
      ) : null}
    </View>
  );
}

function useBacklogMoves(input: {
  serverId: string;
  connectionId: string;
  boardId: number;
  rankFieldId: number | null;
}) {
  const { serverId, connectionId, boardId, rankFieldId } = input;
  const call = useJiraCall(serverId);
  const invalidate = useJiraInvalidate(serverId, connectionId);
  const action = useAction();
  const { run } = action;
  const move = useCallback(
    (issueKeys: string[], target: BlockId, rankBeforeKey: string | null) =>
      void run(async () => {
        await call("jira.sprints.move_issues.request", {
          connectionId,
          issueKeys,
          target:
            target === "backlog"
              ? { kind: "backlog", boardId }
              : { kind: "sprint", sprintId: target },
        });
        if (rankBeforeKey) {
          await call("jira.issue.rank.request", { connectionId, issueKeys, rankBeforeKey });
        }
        await invalidate();
      }),
    [boardId, call, connectionId, invalidate, run],
  );
  const rank = useCallback(
    (issueKey: string, rankBeforeKey: string) =>
      void run(async () => {
        await call("jira.issue.rank.request", {
          connectionId,
          issueKeys: [issueKey],
          rankBeforeKey,
          ...(rankFieldId ? { rankFieldId } : {}),
        });
        await invalidate();
      }),
    [call, connectionId, invalidate, rankFieldId, run],
  );
  return { move, rank, pending: action.pending, error: action.error };
}

export function BacklogView({
  serverId,
  connectionId,
  boardId,
  active,
  onOpenIssue,
}: BacklogViewProps) {
  useBoardWatch({ serverId, connectionId, boardId, active });
  const backlog = useJiraBacklog(serverId, connectionId, boardId);
  const config = useJiraBoardConfig(serverId, connectionId, boardId);
  const moves = useBacklogMoves({
    serverId,
    connectionId,
    boardId,
    rankFieldId: config.data?.rankFieldId ?? null,
  });
  const { move, rank } = moves;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [epicKey, setEpicKey] = useState<string | null>(null);
  const [panel, setPanel] = useState<BacklogPanel>("none");
  const [dialog, setDialog] = useState<BacklogDialog>(null);
  const { blocks, openSprints, allIssues } = useBlocks(backlog.data, epicKey);
  const selectedIssues = useMemo(
    () => allIssues.filter((issue) => selected.has(issue.key)),
    [allIssues, selected],
  );

  const toggle = useCallback((issueKey: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(issueKey)) next.delete(issueKey);
      else next.add(issueKey);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const openCreate = useCallback(() => setDialog({ kind: "create" }), []);
  const openMove = useCallback(
    (issue: JiraIssueCard) =>
      setDialog({ kind: "move", issue, current: blockOf(blocks, issue.key)?.id ?? null }),
    [blocks],
  );
  const moveFromSheet = useCallback(
    (issueKeys: string[], target: BlockId) => move(issueKeys, target, null),
    [move],
  );

  const handleDrop = useCallback(
    (dragKey: string, dropId: string) => {
      const source = blockOf(blocks, dragKey);
      if (!source) return;
      const zone = parseBlockDropId(dropId);
      const targetBlock = zone ?? blockOf(blocks, dropId)?.id ?? null;
      if (targetBlock === null) return;
      const before = zone === null ? dropId : null;
      if (targetBlock !== source.id) {
        move([dragKey], targetBlock, before);
        return;
      }
      if (before) rank(dragKey, before);
    },
    [blocks, move, rank],
  );

  if (backlog.error) return <ErrorBanner message={backlog.error.message} />;
  if (!backlog.data) {
    return (
      <View style={jiraStyles.empty}>
        <Spinner size="small" />
      </View>
    );
  }
  const data = backlog.data;
  const sprintCount = data.sprints.length;

  return (
    <View style={jiraStyles.main} testID="jira-backlog">
      <BacklogToolbar
        panel={panel}
        pending={moves.pending}
        sprintsEnabled={config.data?.sprintsEnabled !== false}
        onPanel={setPanel}
        onCreateSprint={openCreate}
      />
      <ScrollView style={jiraStyles.scroll} contentContainerStyle={jiraStyles.scrollContent}>
        {moves.error ? <ErrorBanner message={moves.error} /> : null}
        {panel === "epics" ? (
          <EpicPanel epics={data.epics} selectedKey={epicKey} onSelect={setEpicKey} />
        ) : null}
        {panel === "versions" ? <VersionPanel versions={data.versions} /> : null}
        {selectedIssues.length > 0 ? (
          <BulkBar
            serverId={serverId}
            connectionId={connectionId}
            boardId={boardId}
            selected={selectedIssues}
            sprints={openSprints}
            onClear={clearSelection}
          />
        ) : null}
        {allIssues.length === 0 && sprintCount === 0 ? (
          <EmptyState
            title="Nothing in the backlog"
            body="Create issues from the board or in Jira."
          />
        ) : null}
        <DndProvider onDrop={handleDrop}>
          <View style={styles.blocks}>
            {blocks.map((block) => (
              <BacklogBlock
                key={String(block.id)}
                id={block.id}
                sprint={block.sprint}
                meta={sprintMeta(block.sprint)}
                issues={block.issues}
                selected={selected}
                testID={block.sprint ? `jira-sprint-${block.sprint.id}` : "jira-backlog-block"}
                onToggle={toggle}
                onOpen={onOpenIssue}
                onMove={openMove}
                onDialog={setDialog}
              />
            ))}
          </View>
        </DndProvider>
      </ScrollView>
      <BacklogDialogs
        dialog={dialog}
        serverId={serverId}
        connectionId={connectionId}
        boardId={boardId}
        sprints={openSprints}
        suggestedSprintName={`${config.data?.name ?? "Board"} Sprint ${sprintCount + 1}`}
        onClose={closeDialog}
        onMove={moveFromSheet}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[3],
  },
  blocks: { gap: theme.spacing[3] },
}));
