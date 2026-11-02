import { useMemo } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { sshStyles as styles } from "./styles";

/** Cancel / Save footer shared by the Servers sheets (memoized: footers are JSX props). */
export function useSheetFooter(input: {
  onClose: () => void;
  onSave: () => void;
  saving: boolean;
  canSubmit: boolean;
  label?: string;
}) {
  const { onClose, onSave, saving, canSubmit, label = "Save" } = input;
  return useMemo(
    () => (
      <View style={styles.footerRow}>
        <Button size="md" variant="ghost" onPress={onClose}>
          Cancel
        </Button>
        <View style={styles.headerSpacer} />
        <Button
          size="md"
          variant="default"
          loading={saving}
          disabled={!canSubmit}
          onPress={onSave}
          testID="ssh-sheet-save"
        >
          {label}
        </Button>
      </View>
    ),
    [canSubmit, label, onClose, onSave, saving],
  );
}
