import { useCallback } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { GitBranch } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { KindIcon } from "@/components/cluster-kind-icon";
import type { Theme } from "@/styles/theme";
import { ArgoCdHealthBadge, ArgoCdSyncBadge } from "./status";
import { kindAbbreviation, type ArgoCdResourceItem } from "./resources";

const ThemedGitBranch = withUnistyles(GitBranch);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });

/** A resource card in the Tree graph and the Pods view. Fills the box its parent gives it. */
export function ResourceNodeCard({
  item,
  selected,
  dimmed,
  onSelect,
}: {
  item: ArgoCdResourceItem;
  selected: boolean;
  dimmed: boolean;
  onSelect: (id: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(item.id), [item.id, onSelect]);
  const cardStyle = useCallback(
    ({ hovered = false }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.card,
      hovered && styles.cardHovered,
      selected && styles.cardSelected,
      dimmed && styles.cardDimmed,
    ],
    [dimmed, selected],
  );
  return (
    <Pressable
      style={cardStyle}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${item.kind} ${item.name}`}
      testID={`argocd-node-${item.kind}-${item.name}`}
    >
      <View style={styles.kindColumn}>
        <KindIcon kind={item.kind} active={selected} />
        <Text style={styles.kindAbbrev} numberOfLines={1}>
          {kindAbbreviation(item.kind)}
        </Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {item.name}
        </Text>
        <View style={styles.badges}>
          {item.health ? <ArgoCdHealthBadge status={item.health} /> : null}
          {item.sync ? <ArgoCdSyncBadge status={item.sync} /> : null}
          {!item.health && !item.sync ? (
            <Text style={styles.kindText} numberOfLines={1}>
              {item.kind}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

/** The application card at the root of the Tree graph. */
export function AppNodeCard({
  name,
  health,
  sync,
}: {
  name: string;
  health: string;
  sync: string;
}) {
  return (
    <View style={[styles.card, styles.appCard]} testID="argocd-node-app">
      <View style={styles.kindColumn}>
        <ThemedGitBranch size={16} uniProps={accentColor} />
        <Text style={styles.kindAbbrev}>app</Text>
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <View style={styles.badges}>
          <ArgoCdHealthBadge status={health} />
          <ArgoCdSyncBadge status={sync} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  card: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cardHovered: {
    backgroundColor: theme.colors.surface2,
  },
  cardSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  cardDimmed: {
    opacity: theme.opacity[50],
  },
  appCard: {
    borderColor: theme.colors.accent,
  },
  kindColumn: {
    width: 40,
    alignItems: "center",
    gap: 2,
  },
  kindAbbrev: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  name: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  badges: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  kindText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
