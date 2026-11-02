import { memo, useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  Server as ServerIcon,
} from "lucide-react-native";
import { router, useGlobalSearchParams } from "expo-router";
import type {
  SshGroup,
  SshServerInfo,
  SshServerState,
  SshSessionInfo,
} from "@jagentdesk/client/internal/daemon-client";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { flattenServerRows, formatServerTarget } from "@/ssh/group-tree";
import type { SshTabStatusState } from "@/ssh/tab-status/tab-status-state";
import { sshTabDotTone, useSshTabStatuses } from "@/ssh/tab-status/use-ssh-tab-status";
import { serverMatchesQuery } from "@/ssh/tag-filter";
import { useServersData } from "@/ssh/use-servers-data";
import type { SshDotTone } from "@/ssh/use-ssh-connect-events";

// The left column while the Servers section is open (spec 25.13.1): open sessions with their
// tab dots, then the server tree with a status dot per server and a search box. Selecting a
// server or a session drives the Servers screen through its route params.

const ThemedSearch = withUnistyles(Search);
const ThemedServer = withUnistyles(ServerIcon);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedTextInput = withUnistyles(TextInput);
const mutedTint = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const placeholderTint = (theme: Theme) => ({ placeholderTextColor: theme.colors.foregroundMuted });

function serverTone(state: SshServerState): SshDotTone | "off" {
  if (state === "connected") return "green";
  if (state === "error" || state === "reconnecting") return "red";
  if (state === "disconnected") return "off";
  return "yellow";
}

const DOT_STYLES = {
  green: "dotGreen",
  yellow: "dotYellow",
  red: "dotRed",
  muted: "dotOff",
  off: "dotOff",
} as const;

function Dot({ tone }: { tone: SshDotTone | "off" }) {
  return <View style={[styles.dot, styles[DOT_STYLES[tone]]]} />;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const SessionRow = memo(function SessionRow({
  session,
  label,
  status,
  active,
}: {
  session: SshSessionInfo;
  label: string;
  status: SshTabStatusState | undefined;
  active: boolean;
}) {
  const handlePress = useCallback(
    () => router.setParams({ sshTerminal: session.terminalId, connect: undefined }),
    [session.terminalId],
  );
  return (
    <Pressable
      style={active ? styles.rowActive : styles.row}
      onPress={handlePress}
      testID={`sidebar-ssh-session-${session.terminalId}`}
    >
      <Dot tone={sshTabDotTone(status)} />
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});

const ServerRow = memo(function ServerRow({
  server,
  groups,
  depth,
  active,
}: {
  server: SshServerInfo;
  groups: SshGroup[];
  depth: number;
  active: boolean;
}) {
  const handlePress = useCallback(
    () => router.setParams({ connect: server.id, sshTerminal: undefined }),
    [server.id],
  );
  return (
    <Pressable
      style={[active ? styles.rowActive : styles.row, { paddingLeft: 12 + depth * 12 }]}
      onPress={handlePress}
      testID={`sidebar-ssh-server-${server.id}`}
    >
      <Dot tone={serverTone(server.state)} />
      <View style={styles.rowText}>
        <Text style={styles.rowLabel} numberOfLines={1}>
          {server.label}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {formatServerTarget(server, groups)}
        </Text>
      </View>
    </Pressable>
  );
});

const GroupRow = memo(function GroupRow({
  group,
  depth,
  collapsed,
  onToggle,
}: {
  group: SshGroup;
  depth: number;
  collapsed: boolean;
  onToggle: (groupId: string) => void;
}) {
  const handlePress = useCallback(() => onToggle(group.id), [group.id, onToggle]);
  return (
    <Pressable style={[styles.groupRow, { paddingLeft: 8 + depth * 12 }]} onPress={handlePress}>
      {collapsed ? (
        <ThemedChevronRight size={12} uniProps={mutedTint} />
      ) : (
        <ThemedChevronDown size={12} uniProps={mutedTint} />
      )}
      <Text style={styles.groupLabel} numberOfLines={1}>
        {group.label}
      </Text>
    </Pressable>
  );
});

export function SidebarServersNav({ serverId }: { serverId: string }) {
  const client = useHostRuntimeClient(serverId);
  const { data } = useServersData(client);
  const params = useGlobalSearchParams<{ sshTerminal?: string | string[] }>();
  const activeTerminal = firstParam(params.sshTerminal) ?? null;
  const statuses = useSshTabStatuses({
    client,
    sessions: data.sessions,
    focusedTerminalId: activeTerminal,
  });
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const activeServerId = data.sessions.find((s) => s.terminalId === activeTerminal)?.serverId;
  const rows = useMemo(
    () =>
      flattenServerRows({
        servers: data.servers,
        groups: data.groups,
        collapsedGroupIds: collapsed,
        serverFilter: (candidate) =>
          serverMatchesQuery(candidate, query, formatServerTarget(candidate, data.groups)),
      }),
    [collapsed, data.groups, data.servers, query],
  );
  const labelOf = useCallback(
    (sshServerId: string) =>
      data.servers.find((server) => server.id === sshServerId)?.label ?? sshServerId,
    [data.servers],
  );
  const toggleGroup = useCallback((groupId: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  const showAll = useCallback(
    () => router.setParams({ sshTerminal: undefined, connect: undefined }),
    [],
  );
  // The section owns the column, so leaving it is explicit (like the cluster/database navs).
  const leave = useCallback(() => router.push("/"), []);

  return (
    <View style={styles.root} testID="sidebar-servers-nav-panel">
      <View style={styles.header}>
        <Pressable
          style={styles.back}
          onPress={leave}
          accessibilityRole="button"
          accessibilityLabel="Leave Servers"
          testID="sidebar-servers-leave"
        >
          <ThemedChevronLeft size={16} uniProps={mutedTint} />
        </Pressable>
        <Pressable
          style={styles.headerTitleRow}
          onPress={showAll}
          accessibilityRole="button"
          accessibilityLabel="All servers"
        >
          <ThemedServer size={14} uniProps={mutedTint} />
          <Text style={styles.headerTitle}>Servers</Text>
        </Pressable>
      </View>
      <View style={styles.search}>
        <ThemedSearch size={13} uniProps={mutedTint} />
        <ThemedTextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Search servers"
          uniProps={placeholderTint}
          autoCapitalize="none"
          autoCorrect={false}
          testID="sidebar-servers-search"
        />
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {data.sessions.length > 0 ? (
          <>
            <Text style={styles.sectionLabel}>Open sessions</Text>
            {data.sessions.map((session) => (
              <SessionRow
                key={session.terminalId}
                session={session}
                label={labelOf(session.serverId)}
                status={statuses[session.terminalId]}
                active={session.terminalId === activeTerminal}
              />
            ))}
            <Text style={styles.sectionLabel}>All servers</Text>
          </>
        ) : null}
        {rows.map((row) =>
          row.kind === "group" ? (
            <GroupRow
              key={`g:${row.group.id}`}
              group={row.group}
              depth={row.depth}
              collapsed={collapsed.has(row.group.id)}
              onToggle={toggleGroup}
            />
          ) : (
            <ServerRow
              key={`s:${row.server.id}`}
              server={row.server}
              groups={data.groups}
              depth={row.depth}
              active={row.server.id === activeServerId}
            />
          ),
        )}
        {!data.loading && data.servers.length === 0 ? (
          <Text style={styles.empty}>No servers yet. Add one on the Servers screen.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

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
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    marginHorizontal: theme.spacing[3],
    marginBottom: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    height: 30,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  searchInput: { flex: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingBottom: theme.spacing[3] },
  sectionLabel: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    marginHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  rowActive: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    marginHorizontal: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surfaceSidebarHover ?? theme.colors.surface2,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowLabel: { flexShrink: 1, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  rowSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  groupRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    paddingRight: theme.spacing[3],
  },
  groupLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  dot: { width: 8, height: 8, borderRadius: theme.borderRadius.full },
  dotGreen: { backgroundColor: theme.colors.palette.green[500] },
  dotYellow: { backgroundColor: theme.colors.palette.amber[500] },
  dotRed: { backgroundColor: theme.colors.palette.red[500] },
  dotOff: { backgroundColor: theme.colors.foregroundExtraMuted },
  empty: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
