import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useLocalSearchParams } from "expo-router";
import { StyleSheet } from "react-native-unistyles";
import { KanbanSquare, MessageSquare, Settings2 } from "lucide-react-native";
import type { JiraConnection } from "@jagentdesk/protocol/jira/rpc-schemas";
import { PageHeader } from "@/components/headers/page-header";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { errorMessage } from "./api";
import { JiraAssistantPanel } from "./assistant/assistant-panel";
import type { JiraAssistantContext } from "./assistant/context";
import { WorkOnIssueSheet } from "./assistant/work-on-issue-sheet";
import { BacklogView } from "./backlog/backlog-view";
import { BoardView } from "./board/board-view";
import { ConnectionsView } from "./connections/connections-view";
import { FiltersView } from "./home/filters-view";
import { ProjectsView } from "./home/projects-view";
import { SearchView } from "./home/search-view";
import { YourWorkView } from "./home/your-work-view";
import { IssueView } from "./issue/issue-view";
import { useJiraNav, type JiraLocation, type JiraLocationPatch } from "./nav";
import { useJiraBoardConfig, useJiraConnections } from "./queries";
import { Chip, EmptyState, ErrorBanner, Tabs } from "./ui/primitives";
import { jiraStyles } from "./ui/styles";

// The Jira surface (spec 29.3): Projects → Boards, Your work, Search, Filters; a board or backlog;
// an issue beside it (desktop) or over it (phone); "Ask AI" docked the same way.

type HomeTab = "projects" | "work" | "search" | "filters";
type Go = (patch: JiraLocationPatch) => void;

const HOME_TABS: ReadonlyArray<{ id: HomeTab; label: string }> = [
  { id: "projects", label: "Projects" },
  { id: "work", label: "Your work" },
  { id: "search", label: "Search" },
  { id: "filters", label: "Filters" },
];
const BOARD_TABS: ReadonlyArray<{ id: "backlog" | "board"; label: string }> = [
  { id: "backlog", label: "Backlog" },
  { id: "board", label: "Board" },
];

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function selectConnection(list: JiraConnection[], id: string | null): JiraConnection | null {
  return list.find((candidate) => candidate.id === id) ?? list[0] ?? null;
}

function screenDescription(connection: JiraConnection | null): string {
  if (!connection) return "Boards, backlogs and issues from your Jira sites";
  return `${connection.label} · ${connection.account.displayName}`;
}

function homeTab(view: JiraLocation["view"]): HomeTab {
  return HOME_TABS.find((tab) => tab.id === view)?.id ?? "projects";
}

function BoardHeader({
  serverId,
  connectionId,
  location,
  go,
}: {
  serverId: string;
  connectionId: string;
  location: JiraLocation;
  go: Go;
}) {
  const config = useJiraBoardConfig(serverId, connectionId, location.boardId ?? 0);
  const backToProjects = useCallback(() => go({ view: "projects", boardId: null }), [go]);
  const switchMode = useCallback((view: "backlog" | "board") => go({ view }), [go]);
  return (
    <View style={styles.subHeader}>
      <View style={jiraStyles.rowWrap}>
        <Button size="sm" variant="ghost" onPress={backToProjects} testID="jira-back-projects">
          ← Projects
        </Button>
        <Text style={jiraStyles.textStrong} numberOfLines={1}>
          {config.data?.name ?? "Board"}
        </Text>
        <View style={jiraStyles.spacer} />
        {config.data?.backlogEnabled === true ? (
          <Tabs
            tabs={BOARD_TABS}
            value={location.view === "backlog" ? "backlog" : "board"}
            onChange={switchMode}
            testIDPrefix="jira-board-mode"
          />
        ) : null}
      </View>
    </View>
  );
}

function ConnectionChip({
  connection,
  active,
  onPick,
}: {
  connection: JiraConnection;
  active: boolean;
  onPick: (connectionId: string) => void;
}) {
  const pick = useCallback(() => onPick(connection.id), [connection.id, onPick]);
  return (
    <Chip
      label={connection.label}
      active={active}
      onPress={pick}
      testID={`jira-connection-chip-${connection.id}`}
    />
  );
}

function MainContent({
  serverId,
  connectionId,
  location,
  go,
  active,
}: {
  serverId: string;
  connectionId: string;
  location: JiraLocation;
  go: Go;
  active: boolean;
}) {
  const openIssue = useCallback((issueKey: string) => go({ issueKey }), [go]);
  const openBacklog = useCallback(() => go({ view: "backlog" }), [go]);
  const openFilter = useCallback((jql: string) => go({ view: "search", jql }), [go]);
  const openBoard = useCallback(
    (boardId: number, view: "board" | "backlog") => go({ view, boardId, issueKey: null }),
    [go],
  );
  const boardId = location.boardId;
  if (location.view === "board" && boardId !== null) {
    return (
      <BoardView
        serverId={serverId}
        connectionId={connectionId}
        boardId={boardId}
        active={active}
        onOpenIssue={openIssue}
        onOpenBacklog={openBacklog}
      />
    );
  }
  if (location.view === "backlog" && boardId !== null) {
    return (
      <BacklogView
        serverId={serverId}
        connectionId={connectionId}
        boardId={boardId}
        active={active}
        onOpenIssue={openIssue}
      />
    );
  }
  switch (location.view) {
    case "work":
      return (
        <YourWorkView serverId={serverId} connectionId={connectionId} onOpenIssue={openIssue} />
      );
    case "search":
      return (
        <SearchView
          key={location.jql ?? ""}
          serverId={serverId}
          connectionId={connectionId}
          initialJql={location.jql}
          onOpenIssue={openIssue}
        />
      );
    case "filters":
      return (
        <FiltersView serverId={serverId} connectionId={connectionId} onOpenFilter={openFilter} />
      );
    default:
      return (
        <ProjectsView serverId={serverId} connectionId={connectionId} onOpenBoard={openBoard} />
      );
  }
}

function ConnectedSurface({
  serverId,
  connectionId,
  connections,
  location,
  go,
  active,
}: {
  serverId: string;
  connectionId: string;
  connections: JiraConnection[];
  location: JiraLocation;
  go: Go;
  active: boolean;
}) {
  const pickConnection = useCallback(
    (id: string) => go({ connectionId: id, view: "projects", boardId: null, issueKey: null }),
    [go],
  );
  const pickTab = useCallback((view: HomeTab) => go({ view, jql: null }), [go]);
  const inBoard = location.view === "board" || location.view === "backlog";
  return (
    <View style={jiraStyles.main}>
      {connections.length > 1 ? (
        <View style={styles.subHeader}>
          <View style={jiraStyles.rowWrap}>
            {connections.map((candidate) => (
              <ConnectionChip
                key={candidate.id}
                connection={candidate}
                active={candidate.id === connectionId}
                onPick={pickConnection}
              />
            ))}
          </View>
        </View>
      ) : null}
      {inBoard ? (
        <BoardHeader serverId={serverId} connectionId={connectionId} location={location} go={go} />
      ) : (
        <View style={styles.subHeader}>
          <Tabs
            tabs={HOME_TABS}
            value={homeTab(location.view)}
            onChange={pickTab}
            testIDPrefix="jira-tab"
          />
        </View>
      )}
      <MainContent
        serverId={serverId}
        connectionId={connectionId}
        location={location}
        go={go}
        active={active}
      />
    </View>
  );
}

function HeaderActions({
  hasConnection,
  onAskAi,
  onConnections,
}: {
  hasConnection: boolean;
  onAskAi: () => void;
  onConnections: () => void;
}) {
  return (
    <>
      {hasConnection ? (
        <Button
          size="sm"
          variant="outline"
          leftIcon={MessageSquare}
          onPress={onAskAi}
          testID="jira-ask-ai"
        >
          Ask AI
        </Button>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Settings2}
        onPress={onConnections}
        testID="jira-open-connections"
      >
        Connections
      </Button>
    </>
  );
}

function JiraMain({
  serverId,
  supportsJira,
  error,
  loading,
  connectionId,
  connections,
  location,
  go,
  active,
  onOpenConnection,
}: {
  serverId: string;
  supportsJira: boolean;
  error: Error | null;
  loading: boolean;
  connectionId: string | null;
  connections: JiraConnection[];
  location: JiraLocation;
  go: Go;
  active: boolean;
  onOpenConnection: (connectionId: string) => void;
}) {
  if (!supportsJira) {
    return (
      <EmptyState
        title="Update the host"
        body="This host does not offer Jira yet. Update JAgentDesk on the host."
      />
    );
  }
  if (error) return <ErrorBanner message={errorMessage(error)} />;
  if (location.view === "connections" || (!loading && !connectionId)) {
    return <ConnectionsView serverId={serverId} onOpen={onOpenConnection} />;
  }
  if (!connectionId) return <Text style={jiraStyles.textMuted}>Loading…</Text>;
  return (
    <ConnectedSurface
      serverId={serverId}
      connectionId={connectionId}
      connections={connections}
      location={location}
      go={go}
      active={active}
    />
  );
}

function useAssistantContext(
  connection: JiraConnection | null,
  location: JiraLocation,
): JiraAssistantContext | null {
  return useMemo(() => {
    if (!connection) return null;
    const projectKey = location.projectKey ?? location.issueKey?.split("-")[0] ?? null;
    return {
      connectionId: connection.id,
      siteLabel: connection.label,
      projectKey,
      boardId: location.boardId,
      issueKey: location.issueKey,
    };
  }, [connection, location.boardId, location.issueKey, location.projectKey]);
}

export function JiraScreen() {
  const params = useLocalSearchParams<{ serverId?: string | string[] }>();
  const hosts = useHosts();
  const serverId = firstParam(params.serverId) ?? hosts[0]?.serverId ?? "";
  const supportsJira = useHostFeature(serverId, "jira");
  const isCompact = useIsCompactFormFactor();
  const isFocused = useIsFocused();
  const { location, go } = useJiraNav();
  const connections = useJiraConnections(serverId);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [workOnKey, setWorkOnKey] = useState<string | null>(null);

  const list = useMemo(() => connections.data ?? [], [connections.data]);
  const connection = selectConnection(list, location.connectionId);
  const connectionId = connection?.id ?? null;
  const assistantContext = useAssistantContext(connection, location);

  const openAssistant = useCallback(() => setAssistantOpen(true), []);
  const closeAssistant = useCallback(() => setAssistantOpen(false), []);
  const askAiOnIssue = useCallback(
    (issueKey: string) => {
      go({ issueKey });
      setAssistantOpen(true);
    },
    [go],
  );
  const openConnections = useCallback(() => go({ view: "connections", issueKey: null }), [go]);
  const openConnection = useCallback(
    (id: string) => go({ connectionId: id, view: "projects" }),
    [go],
  );
  const closeIssue = useCallback(() => go({ issueKey: null }), [go]);
  const openIssue = useCallback((issueKey: string) => go({ issueKey }), [go]);
  const closeWorkOn = useCallback(() => setWorkOnKey(null), []);

  const main = (
    <JiraMain
      serverId={serverId}
      supportsJira={supportsJira}
      error={connections.error}
      loading={connections.isLoading}
      connectionId={connectionId}
      connections={list}
      location={location}
      go={go}
      active={isFocused}
      onOpenConnection={openConnection}
    />
  );

  const issuePanel =
    connectionId && location.issueKey ? (
      <IssueView
        key={location.issueKey}
        serverId={serverId}
        connectionId={connectionId}
        issueKey={location.issueKey}
        active={isFocused}
        isCompact={isCompact}
        onClose={closeIssue}
        onOpenIssue={openIssue}
        onAskAi={askAiOnIssue}
        onWorkOn={setWorkOnKey}
      />
    ) : null;
  const assistantPanel =
    assistantOpen && assistantContext ? (
      <JiraAssistantPanel
        serverId={serverId}
        context={assistantContext}
        isCompact={isCompact}
        onClose={closeAssistant}
      />
    ) : null;

  const overlay = assistantPanel ?? issuePanel;
  const hasConnection = connection !== null;
  const headerActions = useMemo(
    () => (
      <HeaderActions
        hasConnection={hasConnection}
        onAskAi={openAssistant}
        onConnections={openConnections}
      />
    ),
    [hasConnection, openAssistant, openConnections],
  );
  const description = screenDescription(connection);
  return (
    <View style={jiraStyles.screen} testID="jira-screen">
      {isCompact && overlay ? null : (
        <PageHeader
          icon={KanbanSquare}
          title="Jira"
          description={description}
          actions={headerActions}
          testID="jira-header"
        />
      )}
      {isCompact ? (
        (overlay ?? main)
      ) : (
        <View style={jiraStyles.body}>
          <View style={jiraStyles.main}>{main}</View>
          {issuePanel ? <View style={styles.issueDock}>{issuePanel}</View> : null}
          {assistantPanel ? <View style={styles.assistantDock}>{assistantPanel}</View> : null}
        </View>
      )}
      {connectionId && workOnKey ? (
        <WorkOnIssueSheet
          serverId={serverId}
          connectionId={connectionId}
          issueKey={workOnKey}
          visible
          onClose={closeWorkOn}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  subHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  issueDock: {
    width: 560,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    minHeight: 0,
  },
  assistantDock: {
    width: 420,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    minHeight: 0,
  },
}));
