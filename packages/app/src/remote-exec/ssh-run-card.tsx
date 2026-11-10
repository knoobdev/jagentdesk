import { useCallback, useRef } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SshRunToolResult } from "./ssh-run-detection";
import { useSshServerLabel } from "./use-ssh-server-label";
import { nextPinnedState } from "./output-scroll";
import {
  RemoteJobCommand,
  RemoteJobDot,
  RemoteJobOutputBox,
  styles as remoteJobCardStyles,
  type OutputScrollEvent,
  type ScrollToEndableView,
} from "./remote-job-card";

/**
 * Result card for an `ssh_run` tool call (spec 33.9): server label, command, status dot,
 * "Exit code N" / "Timed out" / "Signal S", dark stdout box and a separate "stderr" box
 * when stderr is non-empty. The result is terminal — no Stop button, no live updates.
 */
export function SshRunCard({
  client,
  result,
  testID = "ssh-run-card",
}: {
  client: DaemonClient | null;
  result: SshRunToolResult;
  testID?: string;
}) {
  const { t } = useTranslation();
  const serverLabel = useSshServerLabel(client, result.serverId);
  const stdout = useStickToEnd();
  const stderr = useStickToEnd();
  // spec 33.9: green only for a clean exit; timeout, signal and non-zero exits are red.
  const succeeded = result.exitCode === 0 && !result.timedOut && !result.signal;
  const truncated = result.stdoutTruncated || result.stderrTruncated;
  let statusText = "";
  if (result.timedOut) {
    statusText = t("ssh.remoteExec.sshRun.timedOut");
  } else if (result.signal) {
    statusText = t("ssh.remoteExec.sshRun.signal", { signal: result.signal });
  } else if (result.exitCode !== null) {
    statusText = t("ssh.remoteExec.job.exitCode", { code: result.exitCode });
  }
  return (
    <View style={remoteJobCardStyles.card} testID={testID}>
      <View style={remoteJobCardStyles.headerRow}>
        <RemoteJobDot variant={succeeded ? "succeeded" : "failed"} />
        <Text style={remoteJobCardStyles.targetLabel} numberOfLines={1}>
          {serverLabel ?? result.serverId}
        </Text>
        {statusText ? <Text style={remoteJobCardStyles.statusText}>{statusText}</Text> : null}
        <View style={remoteJobCardStyles.spacer} />
      </View>
      <RemoteJobCommand command={result.command} />
      <RemoteJobOutputBox
        output={result.stdout}
        outputEmptyLabel={t("ssh.remoteExec.sshRun.outputEmpty")}
        attachScrollRef={stdout.attachScrollRef}
        handleOutputScroll={stdout.handleOutputScroll}
        handleContentSizeChange={stdout.handleContentSizeChange}
      />
      {result.stderr.length > 0 ? (
        <View style={localStyles.stderrBlock}>
          <Text style={remoteJobCardStyles.metaText}>{t("ssh.remoteExec.sshRun.stderr")}</Text>
          <RemoteJobOutputBox
            output={result.stderr}
            outputEmptyLabel={t("ssh.remoteExec.sshRun.outputEmpty")}
            attachScrollRef={stderr.attachScrollRef}
            handleOutputScroll={stderr.handleOutputScroll}
            handleContentSizeChange={stderr.handleContentSizeChange}
            testID="ssh-run-stderr-box"
          />
        </View>
      ) : null}
      {truncated ? (
        <Text style={remoteJobCardStyles.truncatedNote}>
          {t("ssh.remoteExec.sshRun.outputTruncated")}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Stick-to-bottom wiring for one static output box (spec 33.9: the box shows the end of the
 * output): jump to the end when the content lays out, and keep the user's position while
 * they are scrolled up. The content never grows, so pinning is only decided on scroll.
 */
function useStickToEnd() {
  const pinnedRef = useRef(true);
  const scrollRef = useRef<ScrollToEndableView | null>(null);
  const attachScrollRef = useCallback((instance: ScrollToEndableView | null) => {
    scrollRef.current = instance;
  }, []);
  const handleOutputScroll = useCallback((event: OutputScrollEvent) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    pinnedRef.current = nextPinnedState(
      contentSize.height - layoutMeasurement.height - contentOffset.y,
    );
  }, []);
  const handleContentSizeChange = useCallback(() => {
    if (pinnedRef.current) {
      scrollRef.current?.scrollToEnd({ animated: false });
    }
  }, []);
  return { attachScrollRef, handleOutputScroll, handleContentSizeChange };
}

const localStyles = StyleSheet.create((theme) => ({
  stderrBlock: {
    gap: theme.spacing[1],
  },
}));
