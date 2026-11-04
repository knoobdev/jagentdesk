import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Check } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

const ThemedCheck = withUnistyles(Check);
const checkColor = (theme: Theme) => ({ color: theme.colors.accentForeground });

interface ArgoCdCheckboxProps {
  label: string;
  /** Inline adornments after the label (badges, tags). */
  children?: ReactNode;
  value: boolean;
  onValueChange: (value: boolean) => void;
  description?: string;
  disabled?: boolean;
  testID?: string;
}

/** A labelled checkbox row for the Argo CD dialogs (sync options, resource selection, …). */
export function ArgoCdCheckbox({
  label,
  children,
  value,
  onValueChange,
  description,
  disabled = false,
  testID,
}: ArgoCdCheckboxProps) {
  const handlePress = useCallback(() => onValueChange(!value), [onValueChange, value]);
  const accessibilityState = useMemo(() => ({ checked: value, disabled }), [disabled, value]);
  return (
    <Pressable
      style={disabled ? [styles.row, styles.disabled] : styles.row}
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      testID={testID}
    >
      <View style={value ? [styles.box, styles.boxChecked] : styles.box}>
        {value ? <ThemedCheck size={12} strokeWidth={3} uniProps={checkColor} /> : null}
      </View>
      <View style={styles.text}>
        <View style={styles.labelRow}>
          <Text style={styles.label}>{label}</Text>
          {children}
        </View>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  box: {
    width: 16,
    height: 16,
    marginTop: 2,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  boxChecked: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  labelRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  description: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
