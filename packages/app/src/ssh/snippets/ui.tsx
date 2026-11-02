import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

// Small form/list primitives shared by the SSH S5 (snippets) and S6 (logs-import)
// surfaces. Values come from the app theme tokens (docs/design.md).

const ThemedTextInput = withUnistyles(TextInput);
const placeholderColor = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});

export interface SshFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  mono?: boolean;
  secureTextEntry?: boolean;
  testID?: string;
}

export function SshField({
  label,
  value,
  onChangeText,
  placeholder,
  multiline = false,
  mono = false,
  secureTextEntry = false,
  testID,
}: SshFieldProps) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <ThemedTextInput
        style={[styles.input, multiline ? styles.multiline : null, mono ? styles.mono : null]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        multiline={multiline}
        secureTextEntry={secureTextEntry}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        textAlignVertical={multiline ? "top" : "center"}
        accessibilityLabel={label}
        testID={testID}
        uniProps={placeholderColor}
      />
    </View>
  );
}

export interface SshSearchInputProps {
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  testID?: string;
}

export function SshSearchInput({ value, onChangeText, placeholder, testID }: SshSearchInputProps) {
  return (
    <ThemedTextInput
      style={styles.input}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      accessibilityLabel={placeholder}
      testID={testID}
      uniProps={placeholderColor}
    />
  );
}

export interface SshSectionProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  testID?: string;
}

export function SshSection({ title, actions, children, testID }: SshSectionProps) {
  return (
    <View style={styles.section} testID={testID}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {actions ? <View style={styles.sectionActions}>{actions}</View> : null}
      </View>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

export function SshEmpty({ text }: { text: string }) {
  return <Text style={styles.empty}>{text}</Text>;
}

export interface SshChipProps<T> {
  value: T;
  label: string;
  active: boolean;
  /** Receives `value`, so a list can pass one stable callback to every chip. */
  onSelect: (value: T) => void;
  testID?: string;
}

export function SshChip<T>({ value, label, active, onSelect, testID }: SshChipProps<T>) {
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  const accessibilityState = useMemo(() => ({ checked: active }), [active]);
  return (
    <Pressable
      onPress={select}
      style={[styles.chip, active ? styles.chipActive : null]}
      accessibilityRole="checkbox"
      accessibilityState={accessibilityState}
      accessibilityLabel={label}
      testID={testID}
    >
      <Text style={[styles.chipText, active ? styles.chipTextActive : null]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SshRow({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.row} testID={testID}>
      {children}
    </View>
  );
}

export const sshStyles = StyleSheet.create((theme) => ({
  rowTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  rowMeta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
  rowActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  stack: {
    gap: theme.spacing[3],
  },
  inlineRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  grow: {
    flex: 1,
    minWidth: 0,
  },
  padded: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  successText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusSuccess,
  },
  dangerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  warningText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusWarning,
  },
}));

const styles = StyleSheet.create((theme) => ({
  field: {
    gap: theme.spacing[1],
  },
  fieldLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  input: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  multiline: {
    minHeight: 120,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  section: {
    gap: theme.spacing[2],
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  sectionActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  sectionCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    padding: theme.spacing[3],
  },
  chip: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface0,
    maxWidth: 240,
  },
  chipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  chipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  chipTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  row: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
}));
