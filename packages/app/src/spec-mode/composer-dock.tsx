import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PhaseReviewBar } from "@/spec-mode/phase-review-bar";
import { SpecModePhaseStrip } from "@/spec-mode/phase-strip";
import { useSpecModeState } from "@/spec-mode/use-spec-mode";

/**
 * Spec mode chrome on top of the composer (spec 28.4 step 3, 28.5): the phase strip and, when a
 * phase is ready, the Phase review bar, in one tray as wide as the composer box. The tray tucks
 * under the box so strip, review bar and composer read as one unit. Hidden while Spec mode is off.
 */
export function SpecModeComposerDock({
  serverId,
  agentId,
  cwd,
  onOpenFile,
}: {
  serverId: string;
  agentId: string;
  cwd: string;
  onOpenFile: (absolutePath: string) => void;
}): ReactElement | null {
  const { state, client, isConnected } = useSpecModeState(serverId, agentId);
  if (!state?.enabled) return null;
  return (
    <View style={styles.dock} testID="spec-mode-composer-dock">
      <SpecModePhaseStrip state={state} />
      <PhaseReviewBar
        agentId={agentId}
        state={state}
        client={client}
        isConnected={isConnected}
        cwd={cwd}
        onOpenFile={onOpenFile}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  dock: {
    gap: theme.spacing[2],
    // Run under the composer box by its corner radius, so the box's rounded top sits on the tray.
    marginBottom: -theme.borderRadius["2xl"],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2] + theme.borderRadius["2xl"],
    paddingHorizontal: theme.spacing[3],
    borderTopLeftRadius: theme.borderRadius["2xl"],
    borderTopRightRadius: theme.borderRadius["2xl"],
    borderWidth: theme.borderWidth[1],
    borderBottomWidth: 0,
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
}));
