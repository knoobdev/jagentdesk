import { Pressable, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SettingsRow } from "@/components/settings";
import type { Theme } from "@/styles/theme";
const ThemedChevron = withUnistyles(ChevronRight);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
export function SettingsDetailRow({
  label,
  summary,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  summary?: string;
  onPress: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={summary ? `${label}, ${summary}` : label}
    >
      <SettingsRow label={label}>
        <View style={styles.trailing}>
          <Text style={styles.summary}>{summary}</Text>
          {!disabled ? <ThemedChevron size={14} uniProps={muted} /> : null}
        </View>
      </SettingsRow>
    </Pressable>
  );
}
const styles = StyleSheet.create((theme) => ({
  trailing: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  summary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
