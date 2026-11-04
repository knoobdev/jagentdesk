import { useCallback, useState, type ReactElement } from "react";
import { Pressable, ScrollView, Text, View, type StyleProp, type TextStyle } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import {
  specModeApprovalLine,
  specModePhaseLabel,
  type SpecModeMessage,
} from "@jagentdesk/protocol/spec-mode";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** What the bubble says for a Spec mode phase message: the user's words, or the Approve line. */
export function specModeBubbleText(parsed: SpecModeMessage): string {
  if (parsed.userText === null) return "";
  return parsed.userText || specModeApprovalLine(parsed.phase);
}

/**
 * A user message that carries a Spec mode phase command (spec 28.4 step 2): the
 * "Spec mode · Plan" label and exactly what the user wrote (request, Revise note, or
 * "Approved — continue to Plan"). The command the daemon really sent — `/speckit-…` or the whole
 * rendered template for prompt providers — stays behind a collapsed "Show command" toggle.
 */
export function SpecModeMessageBody({
  message,
  parsed,
  textStyle,
  textDataSet,
}: {
  message: string;
  parsed: SpecModeMessage;
  textStyle: StyleProp<TextStyle>;
  textDataSet?: Record<string, string>;
}): ReactElement {
  const [showCommand, setShowCommand] = useState(false);
  const toggleCommand = useCallback(() => setShowCommand((shown) => !shown), []);
  const userWrote = Boolean(parsed.userText);
  const bubbleText = specModeBubbleText(parsed);
  const Chevron = showCommand ? ThemedChevronDown : ThemedChevronRight;

  return (
    <View style={styles.body} testID="user-message-spec-mode">
      <View style={styles.label} testID="user-message-spec-mode-label">
        <StatusBadge label={`Spec mode · ${specModePhaseLabel(parsed.phase)}`} />
      </View>
      {bubbleText ? (
        <Text
          selectable
          style={userWrote ? textStyle : [textStyle, styles.approval]}
          dataSet={textDataSet}
          testID="user-message-spec-mode-text"
        >
          {bubbleText}
        </Text>
      ) : null}
      <Pressable
        onPress={toggleCommand}
        style={styles.toggle}
        accessibilityRole="button"
        aria-expanded={showCommand}
        testID="user-message-spec-mode-command-toggle"
      >
        <Chevron size={12} uniProps={mutedColor} />
        <Text style={styles.toggleText}>{showCommand ? "Hide command" : "Show command"}</Text>
      </Pressable>
      {showCommand ? (
        <ScrollView
          style={styles.command}
          contentContainerStyle={styles.commandContent}
          nestedScrollEnabled
          testID="user-message-spec-mode-command"
        >
          <Text selectable style={styles.commandText}>
            {message}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[2],
    minWidth: 0,
  },
  label: {
    flexDirection: "row",
  },
  approval: {
    color: theme.colors.foregroundMuted,
  },
  toggle: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1],
  },
  toggleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  command: {
    maxHeight: 320,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  commandContent: {
    padding: theme.spacing[3],
  },
  commandText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
  },
}));
