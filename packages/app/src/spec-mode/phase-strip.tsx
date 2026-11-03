import type { ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  SPEC_MODE_PHASES,
  specModePhaseLabel,
  type SpecModePhase,
  type SpecModePhaseStatus,
} from "@jagentdesk/protocol/spec-mode";
import { useSpecModeState } from "@/spec-mode/use-spec-mode";

const STATUS_LABEL: Record<SpecModePhaseStatus, string> = {
  pending: "pending",
  running: "running",
  awaiting_review: "awaiting review",
  done: "done",
  skipped: "skipped",
};

/**
 * The enabled phases above the composer with their status (spec 28.5): pending, running,
 * awaiting review or done. Hidden while Spec mode is off.
 */
export function SpecModePhaseStrip({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { state } = useSpecModeState(serverId, agentId);
  if (!state?.enabled) return null;
  const phases = SPEC_MODE_PHASES.filter((phase) => state.phaseStatus[phase] !== "skipped");
  return (
    <View style={styles.strip} testID="spec-mode-phase-strip">
      {phases.map((phase) => (
        <PhaseChip
          key={phase}
          phase={phase}
          status={state.phaseStatus[phase]}
          current={phase === state.phase}
        />
      ))}
      {state.converged ? <Text style={styles.converged}>Converged</Text> : null}
    </View>
  );
}

function PhaseChip({
  phase,
  status,
  current,
}: {
  phase: SpecModePhase;
  status: SpecModePhaseStatus;
  current: boolean;
}): ReactElement {
  const label = specModePhaseLabel(phase);
  return (
    <View
      style={styles.chip}
      accessibilityLabel={`${label}: ${STATUS_LABEL[status]}`}
      testID={`spec-mode-phase-chip-${phase}`}
    >
      <View style={[styles.dot, dotStyle(status)]} />
      <Text style={current ? styles.labelCurrent : styles.label}>{label}</Text>
    </View>
  );
}

function dotStyle(status: SpecModePhaseStatus) {
  switch (status) {
    case "running":
      return styles.dotRunning;
    case "awaiting_review":
      return styles.dotAwaiting;
    case "done":
      return styles.dotDone;
    default:
      return styles.dotPending;
  }
}

const styles = StyleSheet.create((theme) => ({
  strip: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  dotPending: { backgroundColor: theme.colors.border },
  dotRunning: { backgroundColor: theme.colors.palette.blue[500] },
  dotAwaiting: { backgroundColor: theme.colors.palette.amber[500] },
  dotDone: { backgroundColor: theme.colors.palette.green[500] },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  labelCurrent: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  converged: {
    color: theme.colors.palette.green[500],
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    marginLeft: theme.spacing[1],
  },
}));
