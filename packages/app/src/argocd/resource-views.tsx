import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { KindIcon } from "@/components/cluster-kind-icon";
import type { Theme } from "@/styles/theme";
import { GRAPH_NODE_HEIGHT, GRAPH_NODE_WIDTH } from "./graph-layout";
import { ResourceNodeCard } from "./resource-node-card";
import { ArgoCdHealthBadge, ArgoCdSyncBadge } from "./status";
import {
  groupPodsByParent,
  listResources,
  visibleChildren,
  type ArgoCdFilteredResources,
  type ArgoCdResourceItem,
  type ArgoCdResourceModel,
} from "./resources";

function ResourceListRow({
  item,
  selected,
  onSelect,
}: {
  item: ArgoCdResourceItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(item.id), [item.id, onSelect]);
  const rowStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      hovered && styles.rowHovered,
      selected && styles.rowSelected,
    ],
    [selected],
  );
  return (
    <Pressable
      style={rowStyle}
      onPress={handlePress}
      testID={`argocd-row-${item.kind}-${item.name}`}
    >
      <View style={styles.kindCell}>
        <KindIcon kind={item.kind} active={selected} />
        <Text style={styles.muted} numberOfLines={1}>
          {item.kind}
        </Text>
      </View>
      <Text style={styles.nameCell} numberOfLines={1}>
        {item.name}
      </Text>
      <Text style={styles.namespaceCell} numberOfLines={1}>
        {item.namespace || "—"}
      </Text>
      <View style={styles.statusCell}>
        {item.sync ? <ArgoCdSyncBadge status={item.sync} /> : null}
      </View>
      <View style={styles.statusCell}>
        {item.health ? <ArgoCdHealthBadge status={item.health} /> : null}
      </View>
    </Pressable>
  );
}

/** List view: every matching resource as a row (kind, name, namespace, sync, health). */
export function ArgoCdResourceList({
  model,
  filtered,
  selectedId,
  onSelect,
  children,
}: {
  model: ArgoCdResourceModel;
  filtered: ArgoCdFilteredResources;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The page header; phones scroll it with the list. */
  children?: ReactNode;
}) {
  const rows = useMemo(() => listResources(model, filtered.matched), [model, filtered.matched]);
  return (
    <ScrollView style={styles.scroll}>
      {children}
      <View style={styles.listContent}>
        {rows.length === 0 ? (
          <Text style={styles.empty}>No resources match the filters</Text>
        ) : null}
        <View style={styles.headerRow}>
          <Text style={[styles.headerText, styles.kindCell]}>Kind</Text>
          <Text style={[styles.headerText, styles.nameCell]}>Name</Text>
          <Text style={[styles.headerText, styles.namespaceCell]}>Namespace</Text>
          <Text style={[styles.headerText, styles.statusCell]}>Sync</Text>
          <Text style={[styles.headerText, styles.statusCell]}>Health</Text>
        </View>
        {rows.map((item) => (
          <ResourceListRow
            key={item.id}
            item={item}
            selected={selectedId === item.id}
            onSelect={onSelect}
          />
        ))}
      </View>
    </ScrollView>
  );
}

/** Pods view: pods grouped under the resource that owns them. */
export function ArgoCdPodsView({
  model,
  filtered,
  selectedId,
  onSelect,
  children,
}: {
  model: ArgoCdResourceModel;
  filtered: ArgoCdFilteredResources;
  selectedId: string | null;
  onSelect: (id: string) => void;
  children?: ReactNode;
}) {
  const groups = useMemo(
    () =>
      groupPodsByParent({ children: visibleChildren(model, filtered.visible), items: model.items }),
    [model, filtered.visible],
  );
  return (
    <ScrollView style={styles.scroll}>
      {children}
      <View style={styles.podsContent}>
        {groups.length === 0 ? <Text style={styles.empty}>No pods</Text> : null}
        {groups.map((group) => (
          <View key={group.parent?.id ?? "top-level"} style={styles.group}>
            <View style={styles.groupHeader}>
              {group.parent ? <KindIcon kind={group.parent.kind} /> : null}
              <Text style={styles.groupTitle} numberOfLines={1}>
                {group.parent ? `${group.parent.kind} ${group.parent.name}` : "Top-level pods"}
              </Text>
              <Text style={styles.muted}>{`${group.pods.length} pods`}</Text>
            </View>
            <View style={styles.podGrid}>
              {group.pods.map((pod) => (
                <View key={pod.id} style={styles.podCell}>
                  <ResourceNodeCard
                    item={pod}
                    selected={selectedId === pod.id}
                    dimmed={!filtered.matched.has(pod.id)}
                    onSelect={onSelect}
                  />
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  scroll: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  podsContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[6],
  },
  empty: {
    padding: theme.spacing[6],
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  headerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowSelected: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  kindCell: {
    width: 180,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  nameCell: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  namespaceCell: {
    width: 140,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  statusCell: {
    width: 120,
  },
  muted: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  group: {
    gap: theme.spacing[3],
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  groupTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  podGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  podCell: {
    width: GRAPH_NODE_WIDTH,
    height: GRAPH_NODE_HEIGHT,
  },
}));
