import { useMemo, useCallback, type ComponentType, type ReactNode } from "react";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
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
}: {
  icon?: ComponentType<{ size: number; color: string }>;
  label: string;
  onPress: () => void;
  selected?: boolean;
  testID?: string;
  children?: ReactNode;
  leading?: ReactNode;
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
      selected && styles.selected,
      (hovered || pressed) && !selected && styles.hovered,
    ],
    [selected],
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
      {Icon ? <Icon size={18} uniProps={foreground} /> : null}
      <Text numberOfLines={1} style={styles.label}>
        {label}
      </Text>
      {children}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  row: {
    height: { xs: 44, md: 34 },
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  label: { flex: 1, fontSize: 16, fontWeight: "500", color: theme.colors.foreground },
  selected: { backgroundColor: theme.chrome.selectedRow },
  hovered: { backgroundColor: theme.colors.surfaceSidebarHover },
}));
