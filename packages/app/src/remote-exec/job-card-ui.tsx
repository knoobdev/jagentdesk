import { Text, View, ScrollView as RNScrollView } from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import type { RemoteJobStatus } from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import { isWeb } from "@/constants/platform";
import { darkTheme } from "@/styles/theme";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";

// Job card primitives (spec 33.9) shared by the remote tasks job card and the ssh_run card.

const ScrollView = isWeb ? RNScrollView : GHScrollView;

/** Both ScrollView implementations expose the same imperative scrollToEnd. */
export interface ScrollToEndableView {
  scrollToEnd: (options?: { animated?: boolean }) => void;
}

export interface OutputScrollEvent {
  nativeEvent: {
    layoutMeasurement: { height: number };
    contentOffset: { y: number };
    contentSize: { height: number };
  };
}

/** spec 33.9: the output frame is at most 240px tall and scrolls. */
const OUTPUT_MAX_HEIGHT = 240;

/** spec 33.9 dot colours: green succeeded, amber syncing/running, red failed/lost, muted stopped. */
export type RemoteJobDotVariant = "succeeded" | "active" | "failed" | "stopped";

export function remoteJobDotVariant(status: RemoteJobStatus): RemoteJobDotVariant {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "syncing":
    case "running":
      return "active";
    case "failed":
    case "timed_out":
    case "lost":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

/** The status dot (spec 33.9 §1.4 palette); shared by the job card and the ssh_run card. */
export function RemoteJobDot({ variant }: { variant: RemoteJobDotVariant }) {
  return <View style={[styles.dot, dotVariantStyle(variant)]} />;
}

function dotVariantStyle(variant: RemoteJobDotVariant) {
  switch (variant) {
    case "succeeded":
      return styles.dotSucceeded;
    case "active":
      return styles.dotActive;
    case "failed":
      return styles.dotFailed;
    case "stopped":
      return styles.dotStopped;
  }
}

/**
 * The command line, mono and capped at 3 lines (spec 33.9 wrap rule, shared by the job card
 * and the ssh_run card). The full text stays in the accessibility label.
 */
export function RemoteJobCommand({
  command,
  accessibilityLabel,
}: {
  command: string;
  accessibilityLabel?: string;
}) {
  if (!command) return null;
  return (
    <Text
      selectable
      style={styles.command}
      dataSet={CODE_SURFACE_DATASET}
      numberOfLines={3}
      accessibilityLabel={accessibilityLabel ?? command}
    >
      {command}
    </Text>
  );
}

/** The dark output frame, shared by the full card and the compact card's expanded state. */
export function RemoteJobOutputBox({
  output,
  outputEmptyLabel,
  attachScrollRef,
  handleOutputScroll,
  handleContentSizeChange,
  testID = "remote-job-output-box",
}: {
  output: string;
  outputEmptyLabel: string;
  attachScrollRef: (instance: ScrollToEndableView | null) => void;
  handleOutputScroll: (event: OutputScrollEvent) => void;
  /** Fired when the content lays out or grows; the card sticks to the bottom while pinned. */
  handleContentSizeChange?: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.outputBox} testID={testID}>
      <ScrollView
        ref={attachScrollRef}
        style={styles.outputScroll}
        contentContainerStyle={styles.outputContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        onScroll={handleOutputScroll}
        onContentSizeChange={handleContentSizeChange}
        scrollEventThrottle={16}
      >
        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          {output.length > 0 ? (
            <Text selectable style={styles.outputText} dataSet={CODE_SURFACE_DATASET}>
              {output}
            </Text>
          ) : (
            <Text style={styles.outputEmptyText}>{outputEmptyLabel}</Text>
          )}
        </ScrollView>
      </ScrollView>
    </View>
  );
}

export const styles = StyleSheet.create((theme) => ({
  card: {
    gap: theme.spacing[2],
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  dotSucceeded: {
    backgroundColor: theme.colors.palette.green[500],
  },
  dotActive: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  dotFailed: {
    backgroundColor: theme.colors.palette.red[500],
  },
  dotStopped: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  targetLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  statusText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  spacer: {
    flex: 1,
  },
  command: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    // Wrap long commands inside the card; numberOfLines={3} caps the lines with an ellipsis
    // (native) and via -webkit-line-clamp (web), and the full text stays in the
    // accessibility label.
    ...(isWeb ? { whiteSpace: "pre-wrap", overflowWrap: "anywhere" } : null),
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.xs,
  },
  // Terminal palette (design system §1.7): the frame stays dark in both app themes.
  outputBox: {
    backgroundColor: darkTheme.colors.terminal.background,
    borderRadius: theme.borderRadius.base,
    overflow: "hidden",
  },
  outputScroll: {
    maxHeight: OUTPUT_MAX_HEIGHT,
  },
  outputContent: {
    padding: theme.spacing[2],
  },
  outputText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: darkTheme.colors.terminal.foreground,
    ...(isWeb ? { whiteSpace: "pre", overflowWrap: "normal" } : null),
  },
  outputEmptyText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: darkTheme.colors.terminal.brightBlack,
  },
  truncatedNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
