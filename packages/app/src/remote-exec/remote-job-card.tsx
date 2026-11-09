import { useMemo } from "react";
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
import { useRemoteJobCard } from "./use-remote-job-card";

const ScrollView = isWeb ? RNScrollView : GHScrollView;

/** spec 33.9: the output frame is at most 240px tall and scrolls. */
const OUTPUT_MAX_HEIGHT = 240;

/** spec 33.9 dot colours: green succeeded, amber syncing/running, red failed/lost, muted stopped. */
function remoteJobDotStyle(status: RemoteJobStatus) {
  switch (status) {
    case "succeeded":
      return styles.dotSucceeded;
    case "syncing":
    case "running":
      return styles.dotActive;
    case "failed":
    case "timed_out":
    case "lost":
      return styles.dotFailed;
    case "stopped":
      return styles.dotStopped;
  }
}

export function RemoteJobCard({
  client,
  initialJob,
  initialOutput,
  initialOutputOffset,
  initialTruncated = false,
  testID,
}: {
  client: DaemonClient | null;
  initialJob: RemoteJob | null;
  initialOutput: string;
  initialOutputOffset: number;
  /** True when the tool result already reported a dropped output head. */
  initialTruncated?: boolean;
  testID?: string;
}) {
  const { t } = useTranslation();
  const { job, output, stopping, stopError, stop } = useRemoteJobCard({
    client,
    jobId: initialJob?.id ?? "",
    initialJob,
    initialOutput,
    initialOutputOffset,
  });

  const active = job !== null && !isTerminalRemoteJobStatus(job.status);
  const metaParts = useMemo(() => {
    if (!job) return [];
    const parts: string[] = [];
    if (job.sync) {
      parts.push(
        t("ssh.remoteExec.job.syncSummary", {
          sent: job.sync.filesUploaded,
          removed: job.sync.filesDeleted,
        }),
      );
    }
    if (job.exitCode !== null) {
      parts.push(t("ssh.remoteExec.job.exitCode", { code: job.exitCode }));
    }
    return parts;
  }, [job, t]);
  const truncated = initialTruncated || (job?.outputTruncated ?? false);

  if (!job) return null;

  return (
    <View style={styles.card} testID={testID}>
      <View style={styles.headerRow}>
        <View style={[styles.dot, remoteJobDotStyle(job.status)]} />
        <Text style={styles.targetLabel} numberOfLines={1}>
          {job.serverLabel}
        </Text>
        <Text style={styles.statusText}>{t(`ssh.remoteExec.job.status.${job.status}`)}</Text>
        <View style={styles.spacer} />
        {active ? (
          <Button
            size="xs"
            variant="outline"
            onPress={stop}
            disabled={stopping}
            testID="remote-job-stop"
          >
            {stopping ? t("ssh.remoteExec.job.stopping") : t("ssh.remoteExec.job.stop")}
          </Button>
        ) : null}
      </View>
      <Text selectable style={styles.command} dataSet={CODE_SURFACE_DATASET}>
        {job.command}
      </Text>
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
      <View style={styles.outputBox}>
        <ScrollView
          style={styles.outputScroll}
          contentContainerStyle={styles.outputContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
        >
          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
            {output.length > 0 ? (
              <Text selectable style={styles.outputText} dataSet={CODE_SURFACE_DATASET}>
                {output}
              </Text>
            ) : (
              <Text style={styles.outputEmptyText}>{t("ssh.remoteExec.job.outputEmpty")}</Text>
            )}
          </ScrollView>
        </ScrollView>
      </View>
      {truncated ? (
        <Text style={styles.truncatedNote}>{t("ssh.remoteExec.job.outputTruncated")}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
    ...(isWeb ? { whiteSpace: "pre", overflowWrap: "normal" } : null),
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
