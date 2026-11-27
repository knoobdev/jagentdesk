import { useCallback, useState, type ReactElement } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { useTranslation } from "react-i18next";
import * as Clipboard from "expo-clipboard";
import { StyleSheet } from "react-native-unistyles";
import { BlockCopyButton } from "@/components/markdown/block-copy-button";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import {
  COMMAND_COLLAPSED_HEIGHT,
  COMMAND_LINE_HEIGHT,
  nextCommandOverflow,
} from "./command-collapse";

/**
 * The full command in a markdown fence with the fence's own copy button (A4.27c.2). Past six lines
 * it collapses behind "Show more"; the clipped text is still the whole command for selection.
 *
 * Whether it collapses is read from a hidden copy of the command laid out beside the shown one,
 * which no clip reaches — see `nextCommandOverflow` for the loop that measuring the shown text
 * caused on iOS.
 */
export function CommandFence({ command }: { command: string }): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // A new command is measured afresh rather than inheriting the last one's answer.
  const [measuredCommand, setMeasuredCommand] = useState(command);
  if (measuredCommand !== command) {
    setMeasuredCommand(command);
    setOverflows(false);
    setExpanded(false);
  }
  const onMeasureLayout = useCallback((event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setOverflows((previous) => nextCommandOverflow(previous, height));
  }, []);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const copy = useCallback(() => Clipboard.setStringAsync(command), [command]);
  const collapsed = overflows && !expanded;
  return (
    <View style={styles.fence} testID="background-work-detail-command-fence">
      <View style={collapsed ? styles.commandClip : null}>
        <Text
          style={styles.command}
          selectable
          dataSet={CODE_SURFACE_DATASET}
          testID="background-work-detail-command"
        >
          {command}
        </Text>
      </View>
      <View
        style={styles.measure}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
      >
        <Text
          style={styles.command}
          selectable={false}
          onLayout={onMeasureLayout}
          testID="background-work-detail-command-measure"
        >
          {command}
        </Text>
      </View>
      {overflows ? (
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          style={styles.moreButton}
          testID="background-work-detail-command-toggle"
        >
          {({ hovered }) => (
            <Text style={hovered ? styles.moreLabelHovered : styles.moreLabel}>
              {expanded
                ? t("message.backgroundWork.detail.showLess")
                : t("message.backgroundWork.detail.showMore")}
            </Text>
          )}
        </Pressable>
      ) : null}
      <BlockCopyButton
        onCopy={copy}
        visible
        label={t("message.backgroundWork.detail.copyCommand")}
        testID="background-work-detail-copy"
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const moreLabel = {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  } as const;
  return {
    // The markdown fence: surface2, 1 px border, radius 6, padding 12, mono 12 / 17.
    fence: {
      position: "relative",
      gap: theme.spacing[2],
      padding: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
    },
    commandClip: {
      maxHeight: COMMAND_COLLAPSED_HEIGHT,
      overflow: "hidden",
    },
    // Same width as the shown command (the fence's content box), free height, never seen.
    measure: {
      position: "absolute",
      top: theme.spacing[3],
      left: theme.spacing[3],
      right: theme.spacing[3],
      opacity: 0,
    },
    command: {
      // Clear of the copy button in the fence's top trailing corner.
      paddingRight: theme.spacing[6],
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      lineHeight: COMMAND_LINE_HEIGHT,
      color: theme.colors.foreground,
    },
    moreButton: { alignSelf: "flex-start" },
    moreLabel,
    moreLabelHovered: { ...moreLabel, color: theme.colors.foreground },
  };
});
