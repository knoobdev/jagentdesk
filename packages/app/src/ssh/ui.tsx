import type { ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import { CircleAlert, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

// Small pieces shared by the SSH module screens (SFTP, port forwarding).

export type ThemedIcon = ComponentType<{ size?: number; uniProps?: (theme: Theme) => object }>;

export const mutedTint = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
export const foregroundTint = (theme: Theme) => ({ color: theme.colors.foreground });
export const destructiveTint = (theme: Theme) => ({ color: theme.colors.destructive });
export const accentTint = (theme: Theme) => ({ color: theme.colors.accent });

const ThemedAlert = withUnistyles(CircleAlert);
const ThemedSpinner = withUnistyles(LoadingSpinner);

export function Spinner() {
  return <ThemedSpinner size="small" uniProps={mutedTint} />;
}
const ThemedX = withUnistyles(X);

export function IconButton({
  icon: Icon,
  label,
  onPress,
  disabled = false,
  tint = mutedTint,
  testID,
}: {
  icon: ThemedIcon;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tint?: (theme: Theme) => object;
  testID?: string;
}) {
  return (
    <Pressable
      style={[styles.iconButton, disabled ? styles.disabled : null]}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={testID}
    >
      <Icon size={16} uniProps={tint} />
    </Pressable>
  );
}

/** A failure that stays visible in context until the user dismisses it or retries. */
export function ErrorBanner({
  message,
  dismissLabel,
  onDismiss,
  testID,
}: {
  message: string;
  dismissLabel: string;
  onDismiss: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.errorBanner} testID={testID} accessibilityRole="alert">
      <ThemedAlert size={14} uniProps={destructiveTint} />
      <Text style={styles.errorText}>{message}</Text>
      <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel={dismissLabel}>
        <ThemedX size={14} uniProps={mutedTint} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  disabled: {
    opacity: 0.4,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.destructive,
    backgroundColor: theme.colors.surface1,
  },
  errorText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
