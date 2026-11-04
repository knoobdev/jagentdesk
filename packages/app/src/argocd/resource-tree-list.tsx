import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { KindIcon } from "@/components/cluster-kind-icon";
import type { Theme } from "@/styles/theme";
import { ArgoCdHealthBadge, ArgoCdSyncBadge } from "./status";
import {
  flattenResourceTree,
  visibleChildren,
  type ArgoCdFilteredResources,
  type ArgoCdResourceModel,
  type ArgoCdTreeRow,
} from "./resources";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function TreeGuides({ row }: { row: ArgoCdTreeRow }) {
  return (
    <>
      {row.guides.map((guide) => (
        <View key={guide.ancestorId} style={styles.guideColumn}>
          {guide.continues ? <View style={styles.guideLine} /> : null}
        </View>
      ))}
      {row.depth > 0 ? (
        <View style={styles.guideColumn}>
          <View style={row.isLast ? styles.elbowUpper : styles.guideLine} />
          <View style={styles.elbowStub} />
        </View>
      ) : null}
    </>
  );
}

function TreeRowView({
  row,
  collapsed,
  dimmed,
  onToggle,
  onSelect,
}: {
  row: ArgoCdTreeRow;
  collapsed: boolean;
  dimmed: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const handleToggle = useCallback(() => onToggle(row.id), [onToggle, row.id]);
  const handleSelect = useCallback(() => onSelect(row.id), [onSelect, row.id]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;
  return (
    <View style={dimmed ? [styles.row, styles.rowDimmed] : styles.row}>
      <TreeGuides row={row} />
      {row.hasChildren ? (
        <Pressable
          style={styles.toggle}
          onPress={handleToggle}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={collapsed ? `Expand ${row.item.name}` : `Collapse ${row.item.name}`}
        >
          <Chevron size={14} uniProps={mutedColor} />
        </Pressable>
      ) : (
        <View style={styles.toggle} />
      )}
      <Pressable
        style={styles.rowBody}
        onPress={handleSelect}
        accessibilityRole="button"
        accessibilityLabel={`${row.item.kind} ${row.item.name}`}
        testID={`argocd-tree-${row.item.kind}-${row.item.name}`}
      >
        <KindIcon kind={row.item.kind} />
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={1}>
            {row.item.name}
          </Text>
          <View style={styles.badges}>
            <Text style={styles.kind} numberOfLines={1}>
              {row.item.kind}
            </Text>
            {row.item.health ? <ArgoCdHealthBadge status={row.item.health} /> : null}
            {row.item.sync ? <ArgoCdSyncBadge status={row.item.sync} /> : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}

/** Mobile Tree view: owners above their resources, indented with guide lines. */
export function ArgoCdResourceTreeList({
  model,
  filtered,
  onSelect,
  children,
}: {
  model: ArgoCdResourceModel;
  filtered: ArgoCdFilteredResources;
  onSelect: (id: string) => void;
  /** The page header; phones scroll it with the tree. */
  children?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(
    () =>
      flattenResourceTree({
        children: visibleChildren(model, filtered.visible),
        items: model.items,
        collapsed,
      }),
    [model, filtered.visible, collapsed],
  );
  const handleToggle = useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <ScrollView style={styles.scroll} testID="argocd-resource-tree">
      {children}
      <View style={styles.content}>
        {rows.length === 0 ? (
          <Text style={styles.empty}>No resources match the filters</Text>
        ) : null}
        {rows.map((row) => (
          <TreeRowView
            key={row.id}
            row={row}
            collapsed={collapsed.has(row.id)}
            dimmed={!filtered.matched.has(row.id)}
            onToggle={handleToggle}
            onSelect={onSelect}
          />
        ))}
      </View>
    </ScrollView>
  );
}

const GUIDE_WIDTH = 16;

const styles = StyleSheet.create((theme: Theme) => ({
  scroll: {
    flex: 1,
  },
  content: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[6],
  },
  empty: {
    padding: theme.spacing[6],
    textAlign: "center",
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    minHeight: 48,
  },
  rowDimmed: {
    opacity: theme.opacity[50],
  },
  guideColumn: {
    width: GUIDE_WIDTH,
    alignItems: "center",
  },
  guideLine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: GUIDE_WIDTH / 2,
    width: 1,
    backgroundColor: theme.colors.border,
  },
  elbowUpper: {
    position: "absolute",
    top: 0,
    height: "50%",
    left: GUIDE_WIDTH / 2,
    width: 1,
    backgroundColor: theme.colors.border,
  },
  elbowStub: {
    position: "absolute",
    top: "50%",
    left: GUIDE_WIDTH / 2,
    right: 0,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  toggle: {
    width: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  name: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  badges: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  kind: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
