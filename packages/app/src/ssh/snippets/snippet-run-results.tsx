import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type {
  SshSnippetOutputChunk,
  SshSnippetRun,
  SshSnippetRunTarget,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { SnippetsApi } from "./api";
import { useCancelRun, useLiveRun } from "./queries";
import { tallyRun, targetOutcome, type TargetOutcome } from "./run-state";
import { snippetPaneId } from "./snippet-input";
import { createWorkspace, focusPane, type PaneNode } from "./split-layout";
import { SplitWorkspaceView } from "./split-workspace-view";
import { sshStyles } from "./ui";

export interface SnippetRunResultsProps {
  api: SnippetsApi;
  run: SshSnippetRun;
  serverLabels: Readonly<Record<string, string>>;
  onClose?: () => void;
}

/**
 * Output of a multi-server run (spec 25.7, 25.16 #9): a new workspace with one pane
 * per server, each streaming that server's stdout/stderr and its exit code.
 */
export function SnippetRunResults({
  api,
  run: initial,
  serverLabels,
  onClose,
}: SnippetRunResultsProps) {
  const { t } = useTranslation();
  const run = useLiveRun(api, initial);
  const cancel = useCancelRun(api);
  const serverIds = useMemo(
    () => initial.targets.map((target) => target.serverId),
    [initial.targets],
  );
  const baseWorkspace = useMemo(
    () =>
      createWorkspace(
        serverIds.map((serverId) => ({
          id: snippetPaneId(serverId),
          target: { kind: "server", serverId },
          tabTitle: serverLabels[serverId] ?? serverId,
        })),
      ),
    [serverIds, serverLabels],
  );
  const [focusedPaneId, setFocusedPaneId] = useState(baseWorkspace.focusedPaneId);
  const workspace = useMemo(
    () => focusPane(baseWorkspace, focusedPaneId),
    [baseWorkspace, focusedPaneId],
  );
  const targetsById = useMemo(
    () => new Map(run.targets.map((target) => [target.serverId, target])),
    [run.targets],
  );
  const tally = tallyRun(run);

  const { mutate: mutateCancel } = cancel;
  const cancelTarget = useCallback(
    (serverId: string) => mutateCancel({ runId: run.runId, serverId }),
    [mutateCancel, run.runId],
  );
  const cancelAll = useCallback(
    () => mutateCancel({ runId: run.runId }),
    [mutateCancel, run.runId],
  );

  const renderPane = useCallback(
    (pane: PaneNode) => {
      if (pane.target.kind !== "server") return null;
      const target = targetsById.get(pane.target.serverId);
      if (!target) return null;
      return (
        <ResultPane
          target={target}
          label={pane.tabTitle ?? target.serverId}
          onCancel={cancelTarget}
        />
      );
    },
    [targetsById, cancelTarget],
  );

  return (
    <View style={styles.root} testID="ssh-snippet-run-results">
      <View style={styles.header}>
        <View style={sshStyles.grow}>
          <Text style={sshStyles.rowTitle} numberOfLines={1}>
            {run.label}
          </Text>
          <Text style={sshStyles.rowMeta} testID="ssh-snippet-run-tally">
            {t("ssh.snippets.results.tally", { ...tally })}
          </Text>
        </View>
        {tally.pending > 0 ? (
          <Button
            size="sm"
            variant="outline"
            onPress={cancelAll}
            loading={cancel.isPending}
            testID="ssh-snippet-cancel-all"
          >
            {t("ssh.snippets.results.cancelAll")}
          </Button>
        ) : null}
        {onClose ? (
          <Button size="sm" variant="ghost" onPress={onClose}>
            {t("common.actions.close")}
          </Button>
        ) : null}
      </View>
      {cancel.error ? (
        <Alert
          variant="error"
          title={t("ssh.snippets.results.cancelFailed")}
          description={cancel.error.message}
        />
      ) : null}
      <SplitWorkspaceView
        workspace={workspace}
        renderPane={renderPane}
        onFocusPane={setFocusedPaneId}
        paneLabel={paneTitle}
      />
    </View>
  );
}

function paneTitle(pane: PaneNode): string {
  return pane.tabTitle ?? pane.id;
}

interface KeyedChunk {
  key: string;
  chunk: SshSnippetOutputChunk;
}

/** Chunks only ever append, so the character offset of each one is a stable key. */
function keyChunks(chunks: readonly SshSnippetOutputChunk[]): KeyedChunk[] {
  let offset = 0;
  return chunks.map((chunk) => {
    const key = `${chunk.stream}-${offset}`;
    offset += chunk.text.length;
    return { key, chunk };
  });
}

function ResultPane({
  target,
  label,
  onCancel,
}: {
  target: SshSnippetRunTarget;
  label: string;
  onCancel: (serverId: string) => void;
}) {
  const outcome = targetOutcome(target);
  const cancel = useCallback(() => onCancel(target.serverId), [onCancel, target.serverId]);
  const chunks = useMemo(() => keyChunks(target.output), [target.output]);
  return (
    <View style={styles.pane} testID={`ssh-snippet-result-${target.serverId}`}>
      <View style={styles.paneHeader}>
        <Text style={styles.paneTitle} numberOfLines={1}>
          {label}
        </Text>
        <TargetStatus target={target} outcome={outcome} />
        {outcome === "pending" ? <PaneCancelButton onCancel={cancel} /> : null}
      </View>
      <ScrollView style={styles.output} contentContainerStyle={styles.outputContent}>
        <Text selectable style={styles.outputText}>
          {chunks.map(({ key, chunk }) => (
            <Text key={key} style={chunk.stream === "stderr" ? styles.stderr : null}>
              {chunk.text}
            </Text>
          ))}
        </Text>
        {target.truncated ? <TruncatedNote /> : null}
      </ScrollView>
    </View>
  );
}

function PaneCancelButton({ onCancel }: { onCancel: () => void }) {
  const { t } = useTranslation();
  return (
    <Button size="xs" variant="ghost" onPress={onCancel}>
      {t("common.actions.cancel")}
    </Button>
  );
}

function TruncatedNote() {
  const { t } = useTranslation();
  return <Text style={sshStyles.warningText}>{t("ssh.snippets.results.truncated")}</Text>;
}

function TargetStatus({
  target,
  outcome,
}: {
  target: SshSnippetRunTarget;
  outcome: TargetOutcome;
}) {
  const { t } = useTranslation();
  let text: string;
  if (target.state === "connecting") text = t("ssh.snippets.results.connecting");
  else if (target.state === "running") text = t("ssh.snippets.results.running");
  else if (target.state === "cancelled") text = t("ssh.snippets.results.cancelled");
  else if (target.state === "failed")
    text = target.error?.message ?? t("ssh.snippets.results.failed");
  else if (target.signal) text = t("ssh.snippets.results.signal", { signal: target.signal });
  else text = t("ssh.snippets.results.exitCode", { code: target.exitCode });
  const tone = {
    pending: sshStyles.rowMeta,
    success: sshStyles.successText,
    failure: sshStyles.dangerText,
    cancelled: sshStyles.warningText,
  }[outcome];
  return (
    <Text
      style={[tone, styles.status]}
      numberOfLines={1}
      testID={`ssh-snippet-status-${target.serverId}`}
    >
      {text}
    </Text>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  pane: {
    flex: 1,
    minHeight: 0,
  },
  paneHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  paneTitle: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  status: {
    fontSize: theme.fontSize.xs,
    maxWidth: "50%",
  },
  output: {
    flex: 1,
  },
  outputContent: {
    padding: theme.spacing[2],
  },
  outputText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.terminal.foreground,
  },
  stderr: {
    color: theme.colors.terminal.red,
  },
}));
