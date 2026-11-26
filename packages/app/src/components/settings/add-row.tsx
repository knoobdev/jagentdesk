import { Plus } from "lucide-react-native";
import { useCallback } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE } from "@/styles/theme";

const ThemedPlus = withUnistyles(Plus);

type HoverState = PressableStateCallbackType & { hovered?: boolean };

/**
 * The last row of a card that lists things, adding one more. Quiet, so the list reads first: a
 * muted plus in the rows' leading slot and a muted label on the labels' rail.
 */
export function SettingsAddRow({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const rowStyle = useCallback(
    ({ hovered, pressed }: HoverState) => [
      settingsStyles.row,
      styles.row,
      hovered && styles.hovered,
      pressed && styles.pressed,
    ],
    [],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={rowStyle}
      testID={testID}
    >
      <View style={styles.leading}>
        <ThemedPlus size={ICON_SIZE.md} uniProps={mutedIconColorMapping} />
      </View>
      <Text style={[settingsStyles.rowTitle, styles.label]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { justifyContent: "flex-start" },
  leading: { marginRight: theme.spacing[3], alignItems: "center", justifyContent: "center" },
  label: { color: theme.colors.foregroundMuted },
  hovered: { backgroundColor: theme.colors.surface2 },
  pressed: { backgroundColor: theme.colors.surface3 },
}));
