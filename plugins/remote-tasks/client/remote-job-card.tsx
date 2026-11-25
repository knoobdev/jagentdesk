import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { RemoteJob } from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import {
  Button,
  RemoteJobCommand,
  RemoteJobDot,
  RemoteJobOutputBox,
  remoteJobCardStyles as styles,
  remoteJobDotVariant,
  type OutputScrollEvent,
  type ScrollToEndableView,
  nextPinnedState,
  scrollActionForAppend,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { isTerminalRemoteJobStatus } from "./job-card-state";
import { readRemoteJobExtras } from "./remote-job-extras";
import { useRemoteJobCard } from "./use-remote-job-card";

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
