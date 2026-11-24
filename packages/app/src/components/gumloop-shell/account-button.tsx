import { useCallback, useMemo } from "react";
import { Text, type PressableStateCallbackType } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Theme } from "@/styles/theme";

const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function AccountButton({
  icon,
  label,
  onPress,
  selected = false,
  testID,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  selected?: boolean;
  testID: string;
}) {
  const Icon = useMemo(() => withUnistyles(icon), [icon]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const style = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      selected && styles.selected,
      !selected && (hovered || pressed) && styles.hovered,
    ],
    [selected],
  );
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={accessibilityState}
        onPress={onPress}
        style={style}
        testID={testID}
      >
        <Icon size={18} uniProps={muted} />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltip}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}
const styles = StyleSheet.create((theme: Theme) => ({
  button: {
    width: 32,
    height: 32,
    flexShrink: 0,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  selected: { backgroundColor: theme.chrome.selectedRow },
  hovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  tooltip: { fontSize: theme.fontSize.sm, color: theme.colors.popoverForeground },
}));
