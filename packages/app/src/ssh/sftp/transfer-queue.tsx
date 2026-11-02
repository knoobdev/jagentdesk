import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import type { SshTransfer } from "@jagentdesk/protocol/ssh/sftp-schemas";
import { Button } from "@/components/ui/button";
import { ErrorBanner, Spinner } from "../ui";
import type { SftpApi } from "./api";
import {
  basename,
  formatBytes,
  transferActions,
  transferFraction,
  type TransferAction,
  type TransferListState,
} from "./model";
import type { TransferStore } from "./transfer-store";

const POLICY_LABEL_KEYS = {
  replace: "ssh.sftp.transfers.actions.replace",
  "keep-both": "ssh.sftp.transfers.actions.keepBoth",
  skip: "ssh.sftp.transfers.actions.skip",
} as const;

function actionKey(action: TransferAction): string {
  return action.kind === "resolve" ? `resolve:${action.policy}` : action.kind;
}

function runTransferAction(
  api: SftpApi,
  transfer: SshTransfer,
  action: TransferAction,
): Promise<SshTransfer | null> {
  switch (action.kind) {
    case "pause":
      return api.pauseTransfer(transfer.id);
    case "resume":
      return api.resumeTransfer(transfer.id);
    case "cancel":
      return api.cancelTransfer(transfer.id);
    case "retry":
      return api.startTransfer(transfer.id);
    case "resolve":
      return api.startTransfer(transfer.id, action.policy);
    case "dismiss":
      return api.dismissTransfer(transfer.id).then(() => null);
  }
}

function TransferActionButton({
  action,
  label,
  disabled,
  onRun,
}: {
  action: TransferAction;
  label: string;
  disabled: boolean;
  onRun: (action: TransferAction) => void;
}) {
  const handlePress = useCallback(() => onRun(action), [action, onRun]);
  return (
    <Button
      size="xs"
      variant={action.kind === "cancel" ? "ghost" : "outline"}
      disabled={disabled}
      onPress={handlePress}
    >
      {label}
    </Button>
  );
}

function TransferRow({
  api,
  store,
  transfer,
}: {
  api: SftpApi;
  store: TransferStore;
  transfer: SshTransfer;
}) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (action: TransferAction) => runTransferAction(api, transfer, action),
    onSuccess: (result) => {
      setError(null);
      if (result) store.apply(result);
      else store.forget(transfer.id);
    },
    onError: (failure) => setError(failure instanceof Error ? failure.message : String(failure)),
  });
  const dismissError = useCallback(() => setError(null), []);
  const fraction = transferFraction(transfer);
  const progressStyle = [styles.progressFill, { width: `${Math.round(fraction * 100)}%` as const }];
  const name = basename(transfer.sourcePath);
  const showFiles = transfer.kind === "directory" && transfer.filesTotal > 0;

  function actionLabel(action: TransferAction): string {
    if (action.kind === "resolve") return t(POLICY_LABEL_KEYS[action.policy]);
    return t(`ssh.sftp.transfers.actions.${action.kind}`);
  }

  return (
    <View style={styles.row} testID={`sftp-transfer-${transfer.id}`}>
      <View style={styles.rowTop}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={transfer.status === "failed" ? styles.statusError : styles.status}>
          {t(`ssh.sftp.transfers.status.${transfer.status}`)}
        </Text>
      </View>
      <Text style={styles.path} numberOfLines={1}>
        {transfer.targetPath}
      </Text>
      <View style={styles.progressTrack}>
        <View style={progressStyle} />
      </View>
      <View style={styles.rowTop}>
        <Text style={styles.meta}>
          {t("ssh.sftp.transfers.bytes", {
            done: formatBytes(transfer.bytesTransferred),
            total: formatBytes(transfer.bytesTotal),
          })}
          {showFiles
            ? `  ·  ${t("ssh.sftp.transfers.files", { done: transfer.filesDone, total: transfer.filesTotal })}`
            : ""}
        </Text>
        {mutation.isPending ? <Spinner /> : null}
      </View>
      {transfer.status === "conflict" ? (
        <Text style={styles.meta}>{t("ssh.sftp.transfers.conflict", { name })}</Text>
      ) : null}
      {transfer.error ? <Text style={styles.statusError}>{transfer.error.message}</Text> : null}
      <View style={styles.actions}>
        {transferActions(transfer).map((action) => (
          <TransferActionButton
            key={actionKey(action)}
            action={action}
            label={actionLabel(action)}
            disabled={mutation.isPending}
            onRun={mutation.mutate}
          />
        ))}
      </View>
      {error ? (
        <ErrorBanner
          message={error}
          dismissLabel={t("common.actions.dismiss")}
          onDismiss={dismissError}
        />
      ) : null}
    </View>
  );
}

/** The transfer queue (spec 25.5): progress, pause, resume, retry, conflict resolution. */
export function SftpTransferQueue({
  api,
  store,
  state,
  testID,
}: {
  api: SftpApi;
  store: TransferStore;
  state: TransferListState;
  testID?: string;
}) {
  const { t } = useTranslation();
  if (state.status === "loading") {
    return (
      <View style={styles.center} testID={testID}>
        <Spinner />
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <View style={styles.center} testID={testID}>
        <Text style={styles.statusError}>{t("ssh.sftp.transfers.loadFailed")}</Text>
        <Text style={styles.meta}>{state.error}</Text>
      </View>
    );
  }
  if (state.transfers.length === 0) {
    return (
      <View style={styles.center} testID={testID}>
        <Text style={styles.meta}>{t("ssh.sftp.transfers.empty")}</Text>
      </View>
    );
  }
  return (
    <ScrollView style={styles.list} contentContainerStyle={styles.listContent} testID={testID}>
      {state.transfers.map((transfer) => (
        <TransferRow key={transfer.id} api={api} store={store} transfer={transfer} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
  },
  listContent: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  row: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  name: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  path: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  status: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  statusError: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  meta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  progressTrack: {
    height: 4,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  progressFill: {
    height: 4,
    backgroundColor: theme.colors.accent,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
