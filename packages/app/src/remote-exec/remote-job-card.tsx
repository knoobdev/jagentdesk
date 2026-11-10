import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, ScrollView as RNScrollView } from "react-native";
import { ScrollView as GHScrollView } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { RemoteJob, RemoteJobStatus } from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { darkTheme } from "@/styles/theme";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { isTerminalRemoteJobStatus } from "./job-card-state";
import { nextPinnedState, scrollActionForAppend } from "./output-scroll";
import { readRemoteJobExtras } from "./remote-job-extras";
import { useRemoteJobCard } from "./use-remote-job-card";

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

/** Header row: status dot, target label, status text and (full card only) the stop button. */
function RemoteJobCardHeader({
  job,
  active,
  showStop,
  statusText,
  stopLabel,
  stoppingLabel,
  stopping,
  stop,
}: {
  job: RemoteJob;
  active: boolean;
  showStop: boolean;
  statusText: string;
  stopLabel: string;
  stoppingLabel: string;
  stopping: boolean;
  stop: () => void;
}) {
  return (
    <View style={styles.headerRow}>
      <RemoteJobDot variant={remoteJobDotVariant(job.status)} />
      <Text style={styles.targetLabel} numberOfLines={1}>
        {job.serverLabel}
      </Text>
      <Text style={styles.statusText}>{statusText}</Text>
      <View style={styles.spacer} />
      {active && showStop ? (
        <Button
          size="xs"
          variant="outline"
          onPress={stop}
          disabled={stopping}
          testID="remote-job-stop"
        >
          {stopping ? stoppingLabel : stopLabel}
        </Button>
      ) : null}
    </View>
  );
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

export function RemoteJobCard({
  client,
  initialJob,
  initialOutput,
  initialOutputOffset,
  initialTruncated = false,
  variant = "full",
  testID,
}: {
  client: DaemonClient | null;
  initialJob: RemoteJob | null;
  initialOutput: string;
  initialOutputOffset: number;
  /** True when the tool result already reported a dropped output head. */
  initialTruncated?: boolean;
  /**
   * "full" (remote_run) shows the output box outright; "compact" (remote_job_wait, a terminal
   * result) collapses it behind a "Show output" toggle. Spec 33.9 follow-up.
   */
  variant?: "full" | "compact";
  testID?: string;
}) {
  const { t } = useTranslation();
  const compact = variant === "compact";
  const { job, output, stopping, stopError, stop } = useRemoteJobCard({
    client,
    jobId: initialJob?.id ?? "",
    initialJob,
    initialOutput,
    initialOutputOffset,
  });
  const [outputExpanded, setOutputExpanded] = useState(false);
  const toggleOutput = useCallback(() => {
    setOutputExpanded((expanded) => !expanded);
  }, []);

  // Stick to the bottom (spec 33.9: the box shows the end of the output): jump to the end on
  // mount and whenever new output lands, unless the user scrolled up — their position holds
  // until they scroll back near the bottom, which re-pins the box.
  const scrollRef = useRef<ScrollToEndableView | null>(null);
  const pinnedRef = useRef(true);
  const attachScrollRef = useCallback((instance: ScrollToEndableView | null) => {
    scrollRef.current = instance;
  }, []);
  const handleOutputScroll = useCallback((event: OutputScrollEvent) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    pinnedRef.current = nextPinnedState(
      contentSize.height - layoutMeasurement.height - contentOffset.y,
    );
  }, []);
  useEffect(() => {
    if (scrollActionForAppend(pinnedRef.current) === "toEnd") {
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, [output]);

  const active = job !== null && !isTerminalRemoteJobStatus(job.status);
  // Optional ADR-0045 fields (`noCode`, `sources`), read at runtime so old-daemon records
  // without them render exactly as before.
  const extras = useMemo(() => readRemoteJobExtras(job), [job]);
  const metaParts = useMemo(() => {
    if (!job) return [];
    const parts: string[] = [];
    if (extras.noCode) {
      parts.push(t("ssh.remoteExec.job.noCode"));
    } else {
      // Source names first, then the aggregate sync summary (spec 33.9); the single-line
      // meta row truncates to fit.
      if (extras.sources.length > 0) {
        parts.push(extras.sources.map((source) => source.name).join(", "));
      }
      if (job.sync) {
        parts.push(
          t("ssh.remoteExec.job.syncSummary", {
            sent: job.sync.filesUploaded,
            removed: job.sync.filesDeleted,
          }),
        );
      }
    }
    if (job.exitCode !== null) {
      parts.push(t("ssh.remoteExec.job.exitCode", { code: job.exitCode }));
    }
    return parts;
  }, [job, extras, t]);
  const truncated = initialTruncated || (job?.outputTruncated ?? false);

  if (!job) return null;

  return (
    <View style={styles.card} testID={testID}>
      <RemoteJobCardHeader
        job={job}
        active={active}
        showStop={!compact}
        statusText={t(`ssh.remoteExec.job.status.${job.status}`)}
        stopLabel={t("ssh.remoteExec.job.stop")}
        stoppingLabel={t("ssh.remoteExec.job.stopping")}
        stopping={stopping}
        stop={stop}
      />
      <RemoteJobCommand command={job.command} />
      {metaParts.length > 0 ? (
        <Text style={styles.metaText} numberOfLines={1}>
          {metaParts.join(" · ")}
        </Text>
      ) : null}
      {job.error ? (
        <Text selectable style={styles.errorText}>
          {job.error.message}
        </Text>
      ) : null}
      {stopError ? <Text style={styles.errorText}>{stopError}</Text> : null}
      {compact ? (
        <Button
          size="xs"
          variant="outline"
          onPress={toggleOutput}
          testID="remote-job-output-toggle"
        >
          {outputExpanded ? t("ssh.remoteExec.job.hideOutput") : t("ssh.remoteExec.job.showOutput")}
        </Button>
      ) : null}
      {!compact || outputExpanded ? (
        <RemoteJobOutputBox
          output={output}
          outputEmptyLabel={t("ssh.remoteExec.job.outputEmpty")}
          attachScrollRef={attachScrollRef}
          handleOutputScroll={handleOutputScroll}
        />
      ) : null}
      {truncated ? (
        <Text style={styles.truncatedNote}>{t("ssh.remoteExec.job.outputTruncated")}</Text>
      ) : null}
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
