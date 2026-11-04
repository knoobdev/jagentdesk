import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight, KanbanSquare, ListOrdered } from "lucide-react-native";
import type { JiraBoard, JiraProject } from "@jagentdesk/protocol/jira/rpc-schemas";
import { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
import { errorMessage } from "../api";
import { useJiraBoards, useJiraProjects } from "../queries";
import { EmptyState, ErrorBanner, Input, tint, UserAvatar } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";

// Projects → Boards (spec 29.3). The first few projects open with their boards.

const AUTO_EXPANDED_PROJECTS = 5;
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedKanban = withUnistyles(KanbanSquare);
const ThemedList = withUnistyles(ListOrdered);

type OpenBoard = (boardId: number, view: "board" | "backlog") => void;

function BoardRow({ board, onOpenBoard }: { board: JiraBoard; onOpenBoard: OpenBoard }) {
  const openBoard = useCallback(() => onOpenBoard(board.id, "board"), [board.id, onOpenBoard]);
  const openBacklog = useCallback(() => onOpenBoard(board.id, "backlog"), [board.id, onOpenBoard]);
  return (
    <View style={jiraStyles.listRowLast}>
      <ThemedKanban size={14} uniProps={tint.muted} />
      <Pressable style={jiraStyles.main} onPress={openBoard} testID={`jira-board-${board.id}`}>
        <Text style={jiraStyles.text}>{board.name}</Text>
        <Text style={jiraStyles.textSmall}>
          {board.type === "scrum" ? "Scrum board" : "Kanban board"}
        </Text>
      </Pressable>
      {board.type === "scrum" ? (
        <Pressable
          style={jiraStyles.row}
          onPress={openBacklog}
          testID={`jira-backlog-link-${board.id}`}
        >
          <ThemedList size={14} uniProps={tint.muted} />
          <Text style={jiraStyles.textMuted}>Backlog</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ProjectBoards({
  serverId,
  connectionId,
  projectKey,
  onOpenBoard,
}: {
  serverId: string;
  connectionId: string;
  projectKey: string;
  onOpenBoard: OpenBoard;
}) {
  const boards = useJiraBoards(serverId, connectionId, projectKey);
  if (boards.error) return <ErrorBanner message={errorMessage(boards.error)} />;
  if (boards.isLoading) return <Text style={jiraStyles.textMuted}>Loading boards…</Text>;
  const list = boards.data ?? [];
  if (list.length === 0)
    return <Text style={jiraStyles.textMuted}>No boards in this project.</Text>;
  return (
    <View>
      {list.map((board) => (
        <BoardRow key={board.id} board={board} onOpenBoard={onOpenBoard} />
      ))}
    </View>
  );
}

function ProjectRow({
  project,
  expanded,
  onToggle,
  children,
}: {
  project: JiraProject;
  expanded: boolean;
  onToggle: (projectKey: string) => void;
  children: ReactNode;
}) {
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  const toggle = useCallback(() => onToggle(project.key), [onToggle, project.key]);
  return (
    <View testID={`jira-project-${project.key}`}>
      <Pressable style={jiraStyles.listRow} onPress={toggle} accessibilityRole="button">
        <Chevron size={14} uniProps={tint.muted} />
        <Text style={jiraStyles.mono}>{project.key}</Text>
        <Text style={jiraStyles.mainText} numberOfLines={1}>
          {project.name}
        </Text>
        {project.lead ? <UserAvatar user={project.lead} size={20} /> : null}
      </Pressable>
      {expanded ? <View style={jiraStyles.scrollContent}>{children}</View> : null}
    </View>
  );
}

export function ProjectsView({
  serverId,
  connectionId,
  onOpenBoard,
}: {
  serverId: string;
  connectionId: string;
  onOpenBoard: OpenBoard;
}) {
  const projects = useJiraProjects(serverId, connectionId);
  const pulse = useSkeletonPulse();
  const [query, setQuery] = useState("");
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (projects.data ?? []).filter(
      (project) =>
        !needle ||
        project.name.toLowerCase().includes(needle) ||
        project.key.toLowerCase().includes(needle),
    );
  }, [projects.data, query]);
  const autoOpen = useMemo(
    () => new Set(visible.slice(0, AUTO_EXPANDED_PROJECTS).map((project) => project.key)),
    [visible],
  );
  const toggle = useCallback((key: string) => {
    setToggled((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const empty = !projects.isLoading && visible.length === 0 && !projects.error;
  return (
    <ScrollView
      style={jiraStyles.scroll}
      contentContainerStyle={jiraStyles.scrollContent}
      testID="jira-projects"
    >
      <Input
        value={query}
        onChangeText={setQuery}
        placeholder="Filter projects"
        testID="jira-projects-filter"
      />
      {projects.error ? <ErrorBanner message={errorMessage(projects.error)} /> : null}
      {projects.isLoading ? <Skeleton width="100%" height={44} pulse={pulse} radius={8} /> : null}
      {empty ? (
        <EmptyState
          title="No projects"
          body="This account sees no Jira project matching the filter."
        />
      ) : null}
      {visible.length > 0 ? (
        <View style={jiraStyles.card}>
          {visible.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              expanded={autoOpen.has(project.key) !== toggled.has(project.key)}
              onToggle={toggle}
            >
              <ProjectBoards
                serverId={serverId}
                connectionId={connectionId}
                projectKey={project.key}
                onOpenBoard={onOpenBoard}
              />
            </ProjectRow>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}
