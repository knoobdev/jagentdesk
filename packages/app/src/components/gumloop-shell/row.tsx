import { useMemo, useCallback, type ComponentType, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { usePanelStore } from "@/stores/panel-store";
import type { Theme } from "@/styles/theme";
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
export function GumloopRow({
  icon,
  label,
  onPress,
  selected = false,
  leading,
  testID,
  children,
  secondLine,
}: {
  icon?: ComponentType<{ size: number; color: string }>;
  label: string;
  onPress: () => void;
  selected?: boolean;
  testID?: string;
  children?: ReactNode;
  leading?: ReactNode;
  /** A muted line under the label; the row grows by 16 px (spec 38 §4.4b). */
  secondLine?: ReactNode;
}) {
  const Icon = useMemo(() => (icon ? withUnistyles(icon) : null), [icon]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const select = useCallback(() => {
    usePanelStore.getState().showMobileAgent();
    onPress();
  }, [onPress]);
  const rowStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      secondLine ? styles.rowTwoLine : null,
      selected && styles.selected,
      (hovered || pressed) && !selected && styles.hovered,
    ],
    [selected, secondLine],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      onPress={select}
      style={rowStyle}
      testID={testID}
    >
      {leading}
      {Icon ? <Icon size={16} uniProps={foreground} /> : null}
      {secondLine ? (
        <View style={styles.labelColumn}>
          <Text numberOfLines={1} style={styles.labelInColumn}>
            {label}
          </Text>
          {secondLine}
        </View>
      ) : (
        <Text numberOfLines={1} style={styles.label}>
          {label}
        </Text>
      )}
      {children}
    </Pressable>
  );
}

// Spec 38 §4.2 "Nav chính": 32 px rows, a 16 px icon at x = 20 and a 14/500 label at x = 44 (the
// sidebar puts the row at x = 10, so 10 px padding + 16 px icon + 8 px gap).
const styles = StyleSheet.create((theme: Theme) => ({
  row: {
    height: { xs: 44, md: 32 },
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  rowTwoLine: { height: { xs: 60, md: 48 } },
  label: { flex: 1, fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  labelColumn: { flex: 1, minWidth: 0 },
  labelInColumn: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  selected: { backgroundColor: theme.chrome.selectedRow },
  hovered: { backgroundColor: theme.colors.surfaceSidebarHover },
}));
