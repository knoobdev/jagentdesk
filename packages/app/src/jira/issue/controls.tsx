import { useCallback, type ReactNode } from "react";
import { Pressable } from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";
import { Chip } from "../ui/primitives";
import { jiraStyles } from "../ui/styles";

// List controls that pass their value to one shared handler, so rows rendered in a map need no
// per-row closures.

export function ValueChip<T>({
  label,
  value,
  active,
  onSelect,
  testID,
}: {
  label: string;
  value: T;
  active: boolean;
  onSelect: (value: T) => void;
  testID?: string;
}) {
  const press = useCallback(() => onSelect(value), [onSelect, value]);
  return <Chip label={label} active={active} onPress={press} testID={testID} />;
}

export function ValueRow<T>({
  value,
  onSelect,
  children,
  testID,
  accessibilityLabel,
  disabled,
}: {
  value: T;
  onSelect: (value: T) => void;
  children: ReactNode;
  testID?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
}) {
  const press = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      style={jiraStyles.listRowLast}
      onPress={press}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerTint = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function Spinner() {
  return <ThemedSpinner size="small" uniProps={spinnerTint} />;
}
