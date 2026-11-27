import { memo, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CircleCheck, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { formatDuration } from "@/utils/time";
import type { BackgroundTimelineEvent } from "./timeline";

const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The compact system row the timeline shows when background work starts or ends
 * (spec 38 §4.4b): 13 px muted text with a 14 px icon, one line.
 */
export const BackgroundTaskTimelineRow = memo(function BackgroundTaskTimelineRow({
  event,
  onOpen,
}: {
  event: BackgroundTimelineEvent;
  /** Opens the agent's background work panel, where each task has its detail (spec 04 §27c). */
  onOpen?: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const parts: string[] = [];
  if (event.kind === "started") {
    parts.push(t("message.backgroundWork.startedRow"), event.label);
  } else {
    parts.push(t("message.backgroundWork.finishedRow"));
    if (event.label) parts.push(event.label);
    if (event.durationMs !== null) parts.push(formatDuration(event.durationMs));
    if (event.exitCode !== null)
      parts.push(t("message.backgroundWork.exitCode", { code: event.exitCode }));
  }
  const content = (
    <View
      style={styles.row}
      testID={event.kind === "started" ? "background-task-started" : "background-task-finished"}
    >
      {event.kind === "started" ? (
        <ThemedSquareTerminal size={14} uniProps={foregroundMutedColorMapping} />
      ) : (
        <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />
      )}
      <Text style={styles.text} numberOfLines={1}>
        {parts.join(" · ")}
      </Text>
    </View>
  );
  if (!onOpen || event.kind !== "started") return content;
  return (
    <Pressable
      onPress={onOpen}
      accessibilityRole="button"
      accessibilityLabel={t("message.backgroundWork.openTrack", { label: event.label })}
    >
      {content}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    minWidth: 0,
  },
  text: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
}));
