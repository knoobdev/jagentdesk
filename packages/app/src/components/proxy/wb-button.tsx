import { useMemo } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { WB_ORANGE, WB_ORANGE_DIM } from "./workbench-constants";

// The Workbench's primary action button, styled like Burp's orange "Send" / "Start attack" buttons
// (the app's default button is violet, which clashes with the tool's orange accent). Variant
// "primary" is the filled orange; "ghost" is a bordered neutral for secondary actions.

export function WbButton({
  label,
  onPress,
  variant = "primary",
  loading = false,
  disabled = false,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "ghost";
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}) {
  const isPrimary = variant === "primary";
  const isDisabled = disabled || loading;
  const pressedStyle = isPrimary ? styles.primaryPressed : styles.ghostPressed;
  const style = useMemo(
    () => (state: { pressed: boolean }) => [
      styles.base,
      isPrimary ? styles.primary : styles.ghost,
      state.pressed && !isDisabled ? pressedStyle : null,
      isDisabled ? styles.disabled : null,
    ],
    [isPrimary, isDisabled, pressedStyle],
  );
  return (
    <Pressable onPress={onPress} disabled={isDisabled} style={style} testID={testID}>
      <View style={styles.content}>
        {loading ? <ActivityIndicator size="small" color={isPrimary ? "#fff" : WB_ORANGE} /> : null}
        <Text style={isPrimary ? styles.primaryText : styles.ghostText}>{label}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  base: {
    height: 30,
    paddingHorizontal: theme.spacing[4],
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  content: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  primary: { backgroundColor: WB_ORANGE },
  primaryPressed: { backgroundColor: WB_ORANGE_DIM },
  ghost: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  ghostPressed: { backgroundColor: theme.colors.surface1 },
  disabled: { opacity: 0.5 },
  primaryText: {
    color: "#ffffff",
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  ghostText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
}));
