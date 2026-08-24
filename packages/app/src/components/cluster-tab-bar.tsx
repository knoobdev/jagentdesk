import { useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { useClusterNavStore } from "@/stores/cluster-nav-store";
import { useClusterViewStore } from "@/stores/cluster-view-store";
import type { Theme } from "@/styles/theme";

const ThemedX = withUnistyles(X);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function Tab({
  label,
  active,
  onPress,
  onClose,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  onClose?: () => void;
}) {
  return (
    <Pressable style={[styles.tab, active && styles.tabActive]} onPress={onPress}>
      <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>
        {label}
      </Text>
      {onClose ? (
        <Pressable
          style={styles.tabClose}
          onPress={onClose}
          accessibilityLabel="Close tab"
          hitSlop={6}
        >
          <ThemedX size={12} uniProps={mutedColor} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

/**
 * Tab strip for the cluster content area. Shown only once at least one resource
 * detail is open: the first tab returns to the resource list, the rest are open
 * detail views. Mirrors k8slens — details open as tabs, never as modal popups.
 */
export function ClusterTabBar() {
  const tabs = useClusterViewStore((s) => s.tabs);
  const activeTabId = useClusterViewStore((s) => s.activeTabId);
  const setActive = useClusterViewStore((s) => s.setActive);
  const closeTab = useClusterViewStore((s) => s.closeTab);
  const selectedKind = useClusterNavStore((s) => s.selectedKind);
  const showingHelm = useClusterNavStore((s) => s.showingHelm);

  const showList = useCallback(() => setActive(null), [setActive]);

  if (tabs.length === 0) return null;

  const listLabel = showingHelm ? "Releases" : (selectedKind ?? "Resources");

  return (
    <View style={styles.bar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.barContent}
      >
        <Tab label={listLabel} active={activeTabId === null} onPress={showList} />
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            id={tab.id}
            label={tab.name}
            active={activeTabId === tab.id}
            setActive={setActive}
            closeTab={closeTab}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function TabItem({
  id,
  label,
  active,
  setActive,
  closeTab,
}: {
  id: string;
  label: string;
  active: boolean;
  setActive: (id: string | null) => void;
  closeTab: (id: string) => void;
}) {
  const onPress = useCallback(() => setActive(id), [setActive, id]);
  const onClose = useCallback(() => closeTab(id), [closeTab, id]);
  return <Tab label={label} active={active} onPress={onPress} onClose={onClose} />;
}

const styles = StyleSheet.create((theme: Theme) => ({
  bar: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  barContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    maxWidth: 200,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    backgroundColor: theme.colors.surface0,
  },
  tabLabel: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  tabClose: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
}));
