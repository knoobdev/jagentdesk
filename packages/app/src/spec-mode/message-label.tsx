import { useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { specModePhaseLabel, specModePhaseOfMessage } from "@jagentdesk/protocol/spec-mode";
import { StatusBadge } from "@/components/ui/status-badge";

/** "Spec mode · Specify" over a user message that carries a spec-kit phase command (spec 28.4). */
export function SpecModeMessageLabel({ message }: { message: string }): ReactElement | null {
  const phase = useMemo(() => specModePhaseOfMessage(message), [message]);
  if (!phase) return null;
  return (
    <View style={styles.label} testID="user-message-spec-mode-label">
      <StatusBadge label={`Spec mode · ${specModePhaseLabel(phase)}`} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  label: {
    flexDirection: "row",
    marginBottom: theme.spacing[2],
  },
}));
