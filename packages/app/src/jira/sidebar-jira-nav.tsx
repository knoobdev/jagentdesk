import { useCallback, useMemo, useState, type ComponentType } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  Briefcase,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  KanbanSquare,
  ListOrdered,
  Search,
  Settings2,
} from "lucide-react-native";
import type {
  JiraAuthState,
  JiraBoard,
  JiraConnection,
  JiraProject,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import type { Theme } from "@/styles/theme";
import { useJiraGlobalNav, type JiraLocation, type JiraLocationPatch, type JiraView } from "./nav";
import { useJiraBoards, useJiraConnections, useJiraProjects } from "./queries";

// The left column while the Jira section is open (spec 29.3), owned the way the Servers section
// owns it: connections with their auth state; under the selected connection its projects, under
// a project its boards; Your work / Search / Filters. Rows drive the Jira screen's route params.

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedKanban = withUnistyles(KanbanSquare);
const ThemedList = withUnistyles(ListOrdered);
const mutedTint = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type Go = (patch: JiraLocationPatch) => void;
type ThemedIcon = ComponentType<{ size?: number; uniProps?: (theme: Theme) => object }>;

const AUTO_EXPANDED_PROJECTS = 3;

const DOT_STYLE: Record<JiraAuthState, "dotGreen" | "dotYellow" | "dotRed"> = {
  connected: "dotGreen",
  needs_reauth: "dotYellow",
  error: "dotRed",
};

const SECTIONS: ReadonlyArray<{ view: JiraView; label: string; icon: ThemedIcon; testID: string }> =
  [
    { view: "work", label: "Your work", icon: withUnistyles(Briefcase), testID: "jira-nav-work" },
    { view: "search", label: "Search", icon: withUnistyles(Search), testID: "jira-nav-search" },
    { view: "filters", label: "Filters", icon: withUnistyles(Filter), testID: "jira-nav-filters" },
  ];
const ThemedSettings = withUnistyles(Settings2);

function NavRow({
  label,
  icon: Icon,
  active,
  onPress,
  indent,
  testID,
}: {
  label: string;
  icon: ThemedIcon;
  active: boolean;
  onPress: () => void;
  indent: 0 | 1 | 2;
  testID?: string;
}) {
  const state = useMemo(() => ({ selected: active }), [active]);
  // data-active marks the current route for tests (RN-web drops aria-selected on buttons).
  const dataSet = useMemo(() => ({ active: String(active) }), [active]);
  const rowStyle = active ? styles.rowActive : styles.row;
  return (
    <Pressable
      style={[rowStyle, styles[`indent${indent}`]]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={state}
      dataSet={dataSet}
      testID={testID}
    >
      <Icon size={14} uniProps={mutedTint} />
      <Text style={active ? styles.rowLabelActive : styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function SectionRow({
  section,
  location,
  go,
}: {
  section: (typeof SECTIONS)[number];
  location: JiraLocation;
  go: Go;
}) {
  const open = useCallback(
    () => go({ view: section.view, boardId: null, issueKey: null, jql: null }),
    [go, section.view],
  );
  return (
    <NavRow
      label={section.label}
      icon={section.icon}
      active={location.view === section.view}
      onPress={open}
      indent={0}
      testID={section.testID}
    />
  );
}

function BoardRow({ board, location, go }: { board: JiraBoard; location: JiraLocation; go: Go }) {
  const inBoard = location.view === "board" || location.view === "backlog";
  const active = inBoard && location.boardId === board.id;
  const open = useCallback(
    () => go({ view: "board", boardId: board.id, issueKey: null }),
    [board.id, go],
  );
  return (
    <NavRow
      label={board.name}
      icon={board.type === "scrum" ? ThemedList : ThemedKanban}
      active={active}
      onPress={open}
      indent={2}
      testID={`jira-nav-board-${board.id}`}
    />
  );
}

function ProjectBoards({
  serverId,
  connectionId,
  projectKey,
  location,
  go,
}: {
  serverId: string;
  connectionId: string;
  projectKey: string;
  location: JiraLocation;
  go: Go;
}) {
  const boards = useJiraBoards(serverId, connectionId, projectKey);
  if (boards.isLoading) return <Text style={styles.empty}>Loading boards…</Text>;
  if (boards.error) return <Text style={styles.empty}>{boards.error.message}</Text>;
  const list = boards.data ?? [];
  if (list.length === 0) return <Text style={styles.empty}>No boards</Text>;
  return (
    <>
      {list.map((board) => (
        <BoardRow key={board.id} board={board} location={location} go={go} />
      ))}
    </>
  );
}

function ProjectRow({
  project,
  expanded,
  onToggle,
}: {
  project: JiraProject;
  expanded: boolean;
  onToggle: (projectKey: string) => void;
}) {
  const toggle = useCallback(() => onToggle(project.key), [onToggle, project.key]);
  const Chevron = expanded ? ThemedChevronDown : ThemedChevronRight;
  return (
    <Pressable
      style={[styles.row, styles.indent1]}
      onPress={toggle}
      accessibilityRole="button"
      testID={`jira-nav-project-${project.key}`}
    >
      <Chevron size={13} uniProps={mutedTint} />
      <Text style={styles.projectKey}>{project.key}</Text>
      <Text style={styles.rowLabel} numberOfLines={1}>
        {project.name}
      </Text>
    </Pressable>
  );
}

function ConnectionProjects({
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
  const projects = useJiraProjects(serverId, connectionId);
  const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
  const list = useMemo(() => projects.data ?? [], [projects.data]);
  const autoOpen = useMemo(
    () => new Set(list.slice(0, AUTO_EXPANDED_PROJECTS).map((project) => project.key)),
    [list],
  );
  const toggle = useCallback((key: string) => {
    setToggled((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  if (projects.isLoading) return <Text style={styles.empty}>Loading projects…</Text>;
  if (projects.error) return <Text style={styles.empty}>{projects.error.message}</Text>;
  return (
    <>
      {list.map((project) => {
        const expanded = autoOpen.has(project.key) !== toggled.has(project.key);
        return (
          <View key={project.id}>
            <ProjectRow project={project} expanded={expanded} onToggle={toggle} />
            {expanded ? (
              <ProjectBoards
                serverId={serverId}
                connectionId={connectionId}
                projectKey={project.key}
                location={location}
                go={go}
              />
            ) : null}
          </View>
        );
      })}
    </>
  );
}

function ConnectionRow({
  connection,
  selected,
  go,
}: {
  connection: JiraConnection;
  selected: boolean;
  go: Go;
}) {
  const open = useCallback(
    () =>
      go({
        connectionId: connection.id,
        view: "projects",
        boardId: null,
        issueKey: null,
        jql: null,
      }),
    [connection.id, go],
  );
  const state = useMemo(() => ({ selected }), [selected]);
  return (
    <Pressable
      style={selected ? styles.rowActive : styles.row}
      onPress={open}
      accessibilityRole="button"
      accessibilityState={state}
      testID={`jira-nav-connection-${connection.id}`}
    >
      <View style={styles[DOT_STYLE[connection.authState]]} />
      <View style={styles.rowText}>
        <Text style={selected ? styles.rowLabelActive : styles.rowLabel} numberOfLines={1}>
          {connection.label}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {connection.authState === "connected"
            ? connection.account.displayName
            : (connection.lastError ?? "Sign in again")}
        </Text>
      </View>
    </Pressable>
  );
}

export function SidebarJiraNav({ serverId }: { serverId: string }) {
  const { location, go } = useJiraGlobalNav();
  const connections = useJiraConnections(serverId);
  const list = useMemo(() => connections.data ?? [], [connections.data]);
  const selected = list.find((c) => c.id === location.connectionId) ?? list[0] ?? null;
  const leave = useCallback(() => router.push("/"), []);
  const showProjects = useCallback(
    () => go({ view: "projects", boardId: null, issueKey: null, jql: null }),
    [go],
  );
  const manage = useCallback(() => go({ view: "connections", issueKey: null }), [go]);
  return (
    <View style={styles.root} testID="sidebar-jira-nav-panel">
      <View style={styles.header}>
        <Pressable
          style={styles.back}
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel="Leave Jira"
          testID="sidebar-jira-leave"
        >
          <ThemedChevronLeft size={16} uniProps={mutedTint} />
        </Pressable>
        <Pressable
          style={styles.headerTitleRow}
          onPress={showProjects}
          accessibilityRole="button"
          accessibilityLabel="Jira projects"
        >
          <ThemedKanban size={14} uniProps={mutedTint} />
          <Text style={styles.headerTitle}>Jira</Text>
        </Pressable>
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {selected
          ? SECTIONS.map((section) => (
              <SectionRow key={section.view} section={section} location={location} go={go} />
            ))
          : null}
        <Text style={styles.sectionLabel}>Connections</Text>
        {list.length === 0 && !connections.isLoading ? (
          <Text style={styles.empty}>No connection yet</Text>
        ) : null}
        {list.map((connection) => (
          <View key={connection.id}>
            <ConnectionRow
              connection={connection}
              selected={connection.id === selected?.id}
              go={go}
            />
            {connection.id === selected?.id && connection.authState === "connected" ? (
              <ConnectionProjects
                serverId={serverId}
                connectionId={connection.id}
                location={location}
                go={go}
              />
            ) : null}
          </View>
        ))}
        <NavRow
          label="Manage connections"
          icon={ThemedSettings}
          active={location.view === "connections"}
          onPress={manage}
          indent={0}
          testID="jira-nav-connections"
        />
      </ScrollView>
    </View>
  );
}

const row = (theme: Theme) =>
  ({
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    marginHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  }) as const;

const dot = (theme: Theme) =>
  ({ width: 8, height: 8, borderRadius: theme.borderRadius.full }) as const;

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, minHeight: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  back: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  headerTitleRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  headerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingBottom: theme.spacing[3] },
  sectionLabel: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  row: row(theme),
  rowActive: {
    ...row(theme),
    backgroundColor: theme.colors.surfaceSidebarHover ?? theme.colors.surface2,
  },
  indent0: {},
  indent1: { paddingLeft: theme.spacing[3] + theme.spacing[2] },
  indent2: { paddingLeft: theme.spacing[3] + theme.spacing[6] },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { flexShrink: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  rowLabelActive: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  rowSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  projectKey: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  dotGreen: { ...dot(theme), backgroundColor: theme.colors.palette.green[500] },
  dotYellow: { ...dot(theme), backgroundColor: theme.colors.palette.amber[500] },
  dotRed: { ...dot(theme), backgroundColor: theme.colors.palette.red[500] },
  empty: {
    paddingHorizontal: theme.spacing[3] + theme.spacing[6],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
