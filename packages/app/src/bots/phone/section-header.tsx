// A folding group header in the phone's Items tab: "Name N", a chevron, and an action on the right
// (Stale's "Cancel all", a folded group's "{{count}} new"). Orca dfdb4fda (MIT)
// mobile/src/components/list/ListGroup.tsx `SectionHeader`, as MobileBotItemsTab.tsx:300-326 uses it.
import { useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

const ThemedDown = withUnistyles(ChevronDown);
const ThemedRight = withUnistyles(ChevronRight);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function PhoneSectionHeader({
  title,
  expanded,
  onToggle,
  trailing,
  testID,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  trailing?: ReactNode;
  testID?: string;
}) {
  const state = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View style={styles.header}>
      <Pressable
        onPress={onToggle}
        style={styles.toggle}
        accessibilityRole="button"
        accessibilityState={state}
        aria-expanded={expanded}
        testID={testID}
      >
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {expanded ? (
          <ThemedDown size={14} uniProps={muted} />
        ) : (
          <ThemedRight size={14} uniProps={muted} />
        )}
      </Pressable>
      {trailing}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  header: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 8,
    marginTop: 8,
  },
  toggle: { flex: 1, minHeight: 40, flexDirection: "row", alignItems: "center", gap: 6 },
  title: { fontSize: 13, fontWeight: "600", color: theme.colors.foregroundMuted },
}));
