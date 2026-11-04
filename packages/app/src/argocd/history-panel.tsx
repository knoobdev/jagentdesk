import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArgoCdAppDetail, ArgoCdHistoryEntry } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";
import { ArgoCdCheckbox } from "./checkbox";

type RollbackState =
  | { status: "idle" }
  | { status: "confirming"; entry: ArgoCdHistoryEntry; prune: boolean; dryRun: boolean }
  | { status: "submitting"; entry: ArgoCdHistoryEntry }
  | { status: "done"; entry: ArgoCdHistoryEntry; dryRun: boolean }
  | { status: "failed"; entry: ArgoCdHistoryEntry; message: string };

export function shortRevision(revision: string | null): string {
  if (!revision) return "—";
  return /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 7) : revision;
}

function entryRevision(entry: ArgoCdHistoryEntry): string {
  const revision = entry.revision ?? entry.revisions[0] ?? null;
  return shortRevision(revision);
}

function HistoryRow({
  entry,
  isCurrent,
  canRollback,
  onRollback,
}: {
  entry: ArgoCdHistoryEntry;
  isCurrent: boolean;
  canRollback: boolean;
  onRollback: (entry: ArgoCdHistoryEntry) => void;
}) {
  const handleRollback = useCallback(() => onRollback(entry), [entry, onRollback]);
  const deployedAt = entry.deployedAt_ms;
  const initiator = entry.automated ? "automated" : (entry.initiatedBy ?? "unknown");
  const source = entry.sources[0];
  return (
    <View style={styles.row} testID={`argocd-history-${entry.id}`}>
      <View style={styles.rowText}>
        <View style={styles.rowTitle}>
          <Text style={styles.id}>{`#${entry.id}`}</Text>
          <Text style={styles.revision} selectable>
            {entryRevision(entry)}
          </Text>
          {isCurrent ? <Text style={styles.current}>current</Text> : null}
        </View>
        <Text style={styles.meta} numberOfLines={2}>
          {[
            deployedAt
              ? `${new Date(deployedAt).toLocaleString()} (${formatTimeAgo(new Date(deployedAt))})`
              : null,
            `by ${initiator}`,
            source ? `${source.path ?? source.chart ?? source.repoURL}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      {canRollback && !isCurrent ? (
        <Button
          variant="outline"
          size="sm"
          onPress={handleRollback}
          testID={`argocd-rollback-${entry.id}`}
        >
          Rollback
        </Button>
      ) : null}
    </View>
  );
}

/** History and rollback (spec 30.3). Rollback is hidden while auto-sync is on (criterion 5). */
export function ArgoCdHistoryPanel({
  serverId,
  instanceId,
  app,
  onClose,
}: {
  serverId: string;
  instanceId: string;
  app: ArgoCdAppDetail;
  onClose: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const [rollback, setRollback] = useState<RollbackState>({ status: "idle" });
  const entries = useMemo(() => [...app.history].sort((a, b) => b.id - a.id), [app.history]);
  const currentId = entries[0]?.id ?? null;
  const canRollback = !app.autoSync;
  const header = useMemo<SheetHeader>(
    () => ({ title: "History and rollback", subtitle: app.name }),
    [app.name],
  );

  const handleRollback = useCallback(
    (entry: ArgoCdHistoryEntry) =>
      setRollback({ status: "confirming", entry, prune: false, dryRun: false }),
    [],
  );
  const handleCancel = useCallback(() => setRollback({ status: "idle" }), []);
  const handlePrune = useCallback(
    (prune: boolean) =>
      setRollback((state) => (state.status === "confirming" ? { ...state, prune } : state)),
    [],
  );
  const handleDryRun = useCallback(
    (dryRun: boolean) =>
      setRollback((state) => (state.status === "confirming" ? { ...state, dryRun } : state)),
    [],
  );
  const handleConfirm = useCallback(async () => {
    if (rollback.status !== "confirming") return;
    const { entry, prune, dryRun } = rollback;
    if (!client) {
      setRollback({ status: "failed", entry, message: "The host is not connected." });
      return;
    }
    setRollback({ status: "submitting", entry });
    try {
      const payload = await client.argocd("argocd.app.rollback.request", {
        instanceId,
        app: { name: app.name, appNamespace: app.appNamespace },
        historyId: entry.id,
        prune,
        dryRun,
      });
      setRollback(
        payload.error
          ? { status: "failed", entry, message: payload.error }
          : { status: "done", entry, dryRun },
      );
    } catch (error) {
      setRollback({
        status: "failed",
        entry,
        message: error instanceof Error ? error.message : "Unable to roll back",
      });
    }
  }, [app.appNamespace, app.name, client, instanceId, rollback]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      desktopMaxWidth={640}
      testID="argocd-history-panel"
    >
      {canRollback ? null : (
        <Alert
          variant="info"
          title="Turn off auto-sync to roll back"
          description="Argo CD would sync the app straight back to Git."
          testID="argocd-history-autosync-note"
        />
      )}
      {entries.length === 0 ? <Text style={styles.meta}>No deployments yet</Text> : null}
      <View style={styles.list}>
        {entries.map((entry) => (
          <HistoryRow
            key={entry.id}
            entry={entry}
            isCurrent={entry.id === currentId}
            canRollback={canRollback && rollback.status === "idle"}
            onRollback={handleRollback}
          />
        ))}
      </View>

      {rollback.status === "confirming" || rollback.status === "submitting" ? (
        <View style={styles.confirm} testID="argocd-rollback-confirm">
          <Text style={styles.confirmTitle}>
            {`Roll back ${app.name} to #${rollback.entry.id} (${entryRevision(rollback.entry)})?`}
          </Text>
          {rollback.status === "confirming" ? (
            <>
              <ArgoCdCheckbox label="Prune" value={rollback.prune} onValueChange={handlePrune} />
              <ArgoCdCheckbox
                label="Dry run"
                value={rollback.dryRun}
                onValueChange={handleDryRun}
              />
            </>
          ) : null}
          <View style={styles.actions}>
            <Button
              style={styles.flex}
              variant="secondary"
              onPress={handleCancel}
              disabled={rollback.status === "submitting"}
              testID="argocd-rollback-cancel"
            >
              Cancel
            </Button>
            <Button
              style={styles.flex}
              variant="destructive"
              onPress={handleConfirm}
              loading={rollback.status === "submitting"}
              disabled={rollback.status === "submitting"}
              testID="argocd-rollback-submit"
            >
              {rollback.status === "submitting" ? "Rolling back..." : "Roll back"}
            </Button>
          </View>
        </View>
      ) : null}
      {rollback.status === "failed" ? (
        <Alert variant="error" title="Unable to roll back" description={rollback.message}>
          <Button variant="outline" size="sm" onPress={handleCancel}>
            Dismiss
          </Button>
        </Alert>
      ) : null}
      {rollback.status === "done" ? (
        <Alert
          variant="success"
          title={
            rollback.dryRun ? "Dry-run rollback started" : `Rolling back to #${rollback.entry.id}`
          }
          description="Status updates live on the app page."
        >
          <Button variant="outline" size="sm" onPress={handleCancel}>
            Dismiss
          </Button>
        </Alert>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  list: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  id: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  revision: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
  current: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.accent,
  },
  meta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  confirm: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  confirmTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  flex: {
    flex: 1,
  },
}));
