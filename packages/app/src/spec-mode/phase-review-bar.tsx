import { useCallback, useReducer, type ReactElement } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  specModePhaseLabel,
  type SpecModePhase,
  type SpecModeState,
} from "@jagentdesk/protocol/spec-mode";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { useSpecModeState } from "@/spec-mode/use-spec-mode";

type SpecModeClient = ReturnType<typeof useSpecModeState>["client"];

/** The bar's own interaction state (Approve/Revise are fallible, testing.md). */
type BarState =
  | { kind: "idle" }
  | { kind: "revising"; note: string }
  | { kind: "sending"; decision: "approve" | "revise"; note: string }
  | { kind: "error"; message: string; note: string };

type BarAction =
  | { type: "revise" }
  | { type: "note"; note: string }
  | { type: "send"; decision: "approve" | "revise" }
  | { type: "fail"; message: string }
  | { type: "reset" };

function noteOf(state: BarState): string {
  return state.kind === "idle" ? "" : state.note;
}

function barReducer(state: BarState, action: BarAction): BarState {
  switch (action.type) {
    case "revise":
      return { kind: "revising", note: noteOf(state) };
    case "note":
      return { kind: "revising", note: action.note };
    case "send":
      return { kind: "sending", decision: action.decision, note: noteOf(state) };
    case "fail":
      return { kind: "error", message: action.message, note: noteOf(state) };
    case "reset":
      return { kind: "idle" };
  }
}

function reviewTitle(phase: SpecModePhase): string {
  if (phase === "converge") return "Converge added tasks · review before implementing them";
  return `${specModePhaseLabel(phase)} is ready for review`;
}

/**
 * Shown in the Spec mode dock on top of the composer when a phase finished (spec 28.4 step 3):
 * the phase, the files it created or changed (open in the file viewer) and Approve & continue /
 * Revise. The daemon sends the next phase only from these buttons.
 */
export function PhaseReviewBar({
  agentId,
  state,
  client,
  isConnected,
  cwd,
  onOpenFile,
}: {
  agentId: string;
  state: SpecModeState;
  client: SpecModeClient;
  isConnected: boolean;
  cwd: string;
  onOpenFile: (absolutePath: string) => void;
}): ReactElement | null {
  const [bar, dispatch] = useReducer(barReducer, { kind: "idle" });

  const phase = state.phase;
  const awaiting = Boolean(
    state.enabled && phase && state.phaseStatus[phase] === "awaiting_review",
  );

  const send = useCallback(
    async (decision: "approve" | "revise", note?: string) => {
      if (!client) return;
      dispatch({ type: "send", decision });
      try {
        const result = await client.specModeReview({ agentId, decision, note });
        if (result.error) dispatch({ type: "fail", message: result.error.message });
        else dispatch({ type: "reset" });
      } catch (error) {
        dispatch({ type: "fail", message: error instanceof Error ? error.message : String(error) });
      }
    },
    [agentId, client],
  );
  const handleApprove = useCallback(() => void send("approve"), [send]);
  const handleRevise = useCallback(() => dispatch({ type: "revise" }), []);
  const handleNote = useCallback((note: string) => dispatch({ type: "note", note }), []);
  const handleSendRevision = useCallback(
    () => void send("revise", noteOf(bar).trim()),
    [bar, send],
  );
  const handleCancel = useCallback(() => dispatch({ type: "reset" }), []);

  if (!awaiting || !phase) return null;

  const sending = bar.kind === "sending";
  const disabled = !isConnected || sending;
  const isRevising =
    bar.kind === "revising" || (bar.kind === "sending" && bar.decision === "revise");
  const failedRevision = bar.kind === "error" && bar.note.length > 0;
  const showNote = isRevising || failedRevision;

  return (
    <View style={styles.bar} testID="spec-mode-review-bar">
      <View style={styles.summary}>
        <Text style={styles.title}>{reviewTitle(phase)}</Text>
        {state.reviewFiles.length > 0 ? (
          <View style={styles.files}>
            {state.reviewFiles.map((file) => (
              <ReviewFile key={file} file={file} cwd={cwd} onOpenFile={onOpenFile} />
            ))}
          </View>
        ) : null}
      </View>
      {showNote ? (
        <TextInput
          value={noteOf(bar)}
          onChangeText={handleNote}
          placeholder={`What should ${specModePhaseLabel(phase)} change?`}
          placeholderTextColor={styles.placeholder.color}
          multiline
          editable={!sending}
          style={styles.note}
          testID="spec-mode-revise-note"
        />
      ) : null}
      {bar.kind === "error" ? (
        <View style={styles.fullRow}>
          <Alert variant="error" title="Could not continue" description={bar.message} />
        </View>
      ) : null}
      <View style={styles.actions}>
        {showNote ? (
          <>
            <Button
              size="sm"
              variant="default"
              onPress={handleSendRevision}
              disabled={disabled || noteOf(bar).trim().length === 0}
              loading={sending}
              testID="spec-mode-revise-send"
            >
              Send revision
            </Button>
            <Button size="sm" variant="outline" onPress={handleCancel} disabled={sending}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="default"
              onPress={handleApprove}
              disabled={disabled}
              loading={sending}
              testID="spec-mode-approve"
            >
              Approve & continue
            </Button>
            <Button
              size="sm"
              variant="outline"
              onPress={handleRevise}
              disabled={disabled}
              testID="spec-mode-revise"
            >
              Revise
            </Button>
          </>
        )}
      </View>
    </View>
  );
}

function ReviewFile({
  file,
  cwd,
  onOpenFile,
}: {
  file: string;
  cwd: string;
  onOpenFile: (absolutePath: string) => void;
}): ReactElement {
  const handlePress = useCallback(
    () => onOpenFile(`${cwd.replace(/[\\/]+$/, "")}/${file}`),
    [cwd, file, onOpenFile],
  );
  return (
    <Pressable
      onPress={handlePress}
      accessibilityRole="link"
      testID={`spec-mode-review-file-${file}`}
    >
      <Text style={styles.file} numberOfLines={1}>
        {file}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.borderAccent,
  },
  summary: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  files: {
    gap: theme.spacing[1],
  },
  file: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
  note: {
    width: "100%",
    minHeight: 64,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  fullRow: {
    width: "100%",
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginLeft: "auto",
  },
}));
