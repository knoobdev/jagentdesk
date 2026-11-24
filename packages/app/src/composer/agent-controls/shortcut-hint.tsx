import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";

export function AgentControlShortcutHint({ label, actionId }: { label: string; actionId: string }) {
  const keys = useShortcutKeys(actionId);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      {keys ? <Shortcut chord={keys} /> : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));
