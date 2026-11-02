import { memo, useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { Plus } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import type {
  SshGroup,
  SshServerInfo,
  SshSessionInfo,
} from "@jagentdesk/client/internal/daemon-client";
import { formatServerTarget, type SshServerListRow } from "@/ssh/group-tree";
import { sshStateTone } from "@/ssh/use-ssh-connect-events";
import {
  Chip,
  fgTint,
  IconBtn,
  mutedTint,
  redTint,
  StateDot,
  ThemedChevronDown,
  ThemedChevronRight,
  ThemedCopy,
  ThemedPencil,
  ThemedPlay,
  ThemedSearch,
  ThemedTextInput,
  ThemedTrash,
} from "./primitives";
import { sshStyles as styles } from "./styles";

// Servers tab (spec 25.13): group tree, search by name/address/tag, tag AND filter,
// per-server connect / edit / duplicate / delete, per-group edit / connect all / delete.

export interface ServerListActions {
  onConnect: (server: SshServerInfo) => void;
  onEdit: (server: SshServerInfo) => void;
  onDuplicate: (server: SshServerInfo) => void;
  onDelete: (server: SshServerInfo) => void;
  onEditGroup: (group: SshGroup) => void;
  onDeleteGroup: (group: SshGroup) => void;
  onConnectGroup: (group: SshGroup) => void;
  onToggleGroup: (groupId: string) => void;
  onAddServer: () => void;
}

function rowIndentStyle(depth: number) {
  if (depth <= 0) return null;
  if (depth === 1) return styles.rowIndent1;
  if (depth === 2) return styles.rowIndent2;
  if (depth === 3) return styles.rowIndent3;
  if (depth === 4) return styles.rowIndent4;
  return styles.rowIndent5;
}

const GroupRow = memo(function GroupRow({
  group,
  depth,
  collapsed,
  actions,
}: {
  group: SshGroup;
  depth: number;
  collapsed: boolean;
  actions: ServerListActions;
}) {
  const handleToggle = useCallback(() => actions.onToggleGroup(group.id), [actions, group.id]);
  const handleEdit = useCallback(() => actions.onEditGroup(group), [actions, group]);
  const handleDelete = useCallback(() => actions.onDeleteGroup(group), [actions, group]);
  const handleConnectAll = useCallback(() => actions.onConnectGroup(group), [actions, group]);
  return (
    <View style={[styles.trow, rowIndentStyle(depth)]} testID={`servers-group-${group.id}`}>
      <Pressable style={styles.groupTitleBtn} onPress={handleToggle}>
        {collapsed ? (
          <ThemedChevronRight size={15} uniProps={mutedTint} />
        ) : (
          <ThemedChevronDown size={15} uniProps={mutedTint} />
        )}
        <Text style={styles.groupTitle} numberOfLines={1}>
          {group.label}
        </Text>
      </Pressable>
      <View style={styles.rowActions}>
        <IconBtn
          icon={ThemedPlay}
          tint={mutedTint}
          label="Connect all"
          onPress={handleConnectAll}
          testID={`servers-connect-group-${group.id}`}
        />
        <IconBtn icon={ThemedPencil} tint={mutedTint} label="Edit group" onPress={handleEdit} />
        <IconBtn icon={ThemedTrash} tint={redTint} label="Delete group" onPress={handleDelete} />
      </View>
    </View>
  );
});

const ServerRow = memo(function ServerRow({
  server,
  groups,
  depth,
  isCompact,
  busy,
  hasSession,
  actions,
}: {
  server: SshServerInfo;
  groups: SshGroup[];
  depth: number;
  isCompact: boolean;
  busy: boolean;
  hasSession: boolean;
  actions: ServerListActions;
}) {
  const handleConnect = useCallback(() => actions.onConnect(server), [actions, server]);
  const handleEdit = useCallback(() => actions.onEdit(server), [actions, server]);
  const handleDuplicate = useCallback(() => actions.onDuplicate(server), [actions, server]);
  const handleDelete = useCallback(() => actions.onDelete(server), [actions, server]);
  const tags = server.tags?.length ? ` · ${server.tags.join(", ")}` : "";
  return (
    <Pressable
      style={[styles.trow, rowIndentStyle(depth)]}
      onPress={handleConnect}
      disabled={busy}
      testID={`servers-row-${server.id}`}
    >
      <StateDot tone={sshStateTone(server.state)} />
      <View style={styles.colName}>
        <Text style={styles.cellStrong} numberOfLines={1}>
          {server.label}
          {server.protocol === "telnet" ? " (Telnet, not encrypted)" : ""}
        </Text>
        <Text style={styles.cellSub} numberOfLines={1}>
          {formatServerTarget(server, groups)}
          {tags}
          {server.lastError && server.state === "error" ? ` · ${server.lastError}` : ""}
        </Text>
      </View>
      <View style={styles.rowActions}>
        <IconBtn
          icon={ThemedPlay}
          tint={fgTint}
          label={hasSession ? "Open terminal" : "Connect"}
          onPress={handleConnect}
          disabled={busy}
          testID={`servers-connect-${server.id}`}
        />
        <IconBtn icon={ThemedPencil} tint={mutedTint} label="Edit" onPress={handleEdit} />
        {isCompact ? null : (
          <IconBtn icon={ThemedCopy} tint={mutedTint} label="Duplicate" onPress={handleDuplicate} />
        )}
        <IconBtn icon={ThemedTrash} tint={redTint} label="Delete" onPress={handleDelete} />
      </View>
    </Pressable>
  );
});

export function ServersListTab({
  rows,
  groups,
  tags,
  query,
  onQueryChange,
  selectedTags,
  onToggleTag,
  collapsedGroupIds,
  busyId,
  sessions,
  isCompact,
  actions,
}: {
  rows: SshServerListRow[];
  groups: SshGroup[];
  tags: string[];
  query: string;
  onQueryChange: (value: string) => void;
  selectedTags: ReadonlySet<string>;
  onToggleTag: (tag: string) => void;
  collapsedGroupIds: ReadonlySet<string>;
  busyId: string | null;
  sessions: SshSessionInfo[];
  isCompact: boolean;
  actions: ServerListActions;
}) {
  const filtered = query.trim() !== "" || selectedTags.size > 0;
  return (
    <>
      <View style={styles.toolbar}>
        <View style={styles.searchBox}>
          <ThemedSearch size={14} uniProps={mutedTint} />
          <ThemedTextInput
            style={styles.searchInput}
            value={query}
            onChangeText={onQueryChange}
            placeholder="Search name, address or tag"
            autoCapitalize="none"
            autoCorrect={false}
            testID="servers-search"
          />
        </View>
      </View>
      {tags.length > 0 ? (
        <View style={styles.tagRow}>
          {tags.map((tag) => (
            <Chip
              key={tag}
              label={tag}
              value={tag}
              active={selectedTags.has(tag)}
              onToggle={onToggleTag}
              testID={`servers-tag-${tag}`}
            />
          ))}
        </View>
      ) : null}
      <View style={styles.sectionCard}>
        {rows.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.noticeTitle}>
              {filtered ? "No servers match" : "No SSH servers yet"}
            </Text>
            <Text style={styles.noticeBody}>
              {filtered
                ? "Clear the search or tag filters to see every server."
                : "Add a server to connect and open a terminal on it."}
            </Text>
            {filtered ? null : (
              <View style={styles.emptyAction}>
                <Button size="sm" leftIcon={Plus} onPress={actions.onAddServer}>
                  Add server
                </Button>
              </View>
            )}
          </View>
        ) : (
          rows.map((row) =>
            row.kind === "group" ? (
              <GroupRow
                key={`group:${row.group.id}`}
                group={row.group}
                depth={row.depth}
                collapsed={collapsedGroupIds.has(row.group.id)}
                actions={actions}
              />
            ) : (
              <ServerRow
                key={`server:${row.server.id}`}
                server={row.server}
                groups={groups}
                depth={row.depth}
                isCompact={isCompact}
                busy={busyId === row.server.id}
                hasSession={sessions.some((session) => session.serverId === row.server.id)}
                actions={actions}
              />
            ),
          )
        )}
      </View>
    </>
  );
}
