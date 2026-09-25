import { useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { CompactBackButton } from "./compact-back-button";

const iconColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });

interface PageHeaderProps {
  /** The section's icon — the same one the rail / sidebar uses for it. */
  icon: LucideIcon;
  title: string;
  /** One line (or two on phones) saying what the page is for. */
  description: string;
  /** Right-side buttons: use `<Button size="sm" leftIcon={…}>`, so every page matches. */
  actions?: ReactNode;
  /** Small status next to the actions (e.g. Docker's "Live"). */
  accessory?: ReactNode;
  testID?: string;
}

/**
 * The one page header every full-screen page uses (History, Docker, Skills, Databases, …):
 * back arrow on phones, the section icon and a bold title on one row with same-size action
 * buttons on the right, and a one-line description below — at the same offset on every page.
 */
export function PageHeader({
  icon,
  title,
  description,
  actions,
  accessory,
  testID,
}: PageHeaderProps) {
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const ThemedIcon = useMemo(() => withUnistyles(icon), [icon]);
  const containerStyle = useMemo(
    () => [styles.container, isCompact ? { paddingTop: insets.top + 12 } : null],
    [insets.top, isCompact],
  );
  return (
    <View style={containerStyle} testID={testID}>
      <View style={styles.row}>
        <View style={styles.titleGroup}>
          <CompactBackButton />
          <ThemedIcon size={20} uniProps={iconColorMapping} />
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
        </View>
        {accessory || actions ? (
          <View style={styles.actions}>
            {accessory}
            {actions}
          </View>
        ) : null}
      </View>
      <Text style={styles.description}>{description}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    rowGap: theme.spacing[2],
    columnGap: theme.spacing[3],
  },
  titleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 1,
    minWidth: 0,
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  description: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
