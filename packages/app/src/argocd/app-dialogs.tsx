import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ArgoCdAppDetail, ArgoCdResourceDiff } from "@jagentdesk/protocol/argocd/rpc-schemas";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { DiffViewer } from "@/components/diff-viewer";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ArgoCdSpinner } from "./spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { parseUnifiedDiff } from "@/utils/tool-call-parsers";
import { ArgoCdCheckbox } from "./checkbox";
import { errorMessage, useArgoCdAppDiff } from "./queries";

type SubmitState =
  | { status: "editing" }
  | { status: "submitting" }
  | { status: "done" }
  | { status: "failed"; message: string };

interface DialogProps {
  serverId: string;
  instanceId: string;
  app: ArgoCdAppDetail;
  onClose: () => void;
}

type PropagationPolicy = "foreground" | "background";
const PROPAGATION_OPTIONS = [
  { value: "foreground" as const, label: "Foreground" },
  { value: "background" as const, label: "Background" },
];

/** Delete app (spec 30.3): the user types the app name; the daemon checks it again. */
export function ArgoCdDeleteAppDialog({ serverId, instanceId, app, onClose }: DialogProps) {
  const client = useHostRuntimeClient(serverId);
  const [typedName, setTypedName] = useState("");
  const [cascade, setCascade] = useState(true);
  const [policy, setPolicy] = useState<PropagationPolicy>("foreground");
  const [submit, setSubmit] = useState<SubmitState>({ status: "editing" });
  const nameMatches = typedName === app.name;
  const header = useMemo<SheetHeader>(
    () => ({ title: `Delete ${app.name}`, subtitle: app.project }),
    [app.name, app.project],
  );

  const handleDelete = useCallback(async () => {
    if (!client) {
      setSubmit({ status: "failed", message: "The host is not connected." });
      return;
    }
    setSubmit({ status: "submitting" });
    try {
      const payload = await client.argocd("argocd.app.delete.request", {
        instanceId,
        app: { name: app.name, appNamespace: app.appNamespace },
        confirmName: typedName,
        cascade,
        propagationPolicy: policy,
      });
      setSubmit(payload.error ? { status: "failed", message: payload.error } : { status: "done" });
    } catch (error) {
      setSubmit({ status: "failed", message: errorMessage(error, "Unable to delete the app") });
    }
  }, [app.appNamespace, app.name, cascade, client, instanceId, policy, typedName]);

  const isSubmitting = submit.status === "submitting";
  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="argocd-delete-dialog">
      <Text style={styles.body}>
        {cascade
          ? "Deletes the application and every resource it manages in the cluster."
          : "Deletes the application only. Its resources stay in the cluster."}
      </Text>
      <ArgoCdCheckbox
        label="Cascade"
        description="Delete the app's resources too"
        value={cascade}
        onValueChange={setCascade}
        disabled={isSubmitting}
      />
      {cascade ? (
        <View style={styles.field}>
          <Text style={styles.label}>Propagation policy</Text>
          <SegmentedControl
            options={PROPAGATION_OPTIONS}
            value={policy}
            onValueChange={setPolicy}
            size="sm"
          />
        </View>
      ) : null}
      <View style={styles.field}>
        <Text style={styles.label}>{`Type ${app.name} to confirm`}</Text>
        <AdaptiveTextInput
          style={styles.input}
          initialValue=""
          onChangeText={setTypedName}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting && submit.status !== "done"}
          accessibilityLabel="Application name"
          testID="argocd-delete-confirm-name"
        />
      </View>
      {submit.status === "failed" ? (
        <Alert variant="error" title="Unable to delete the app" description={submit.message} />
      ) : null}
      {submit.status === "done" ? (
        <Alert
          variant="success"
          title="Deleting application"
          description="Argo CD is removing it."
        />
      ) : null}
      <View style={styles.actions}>
        <Button
          style={styles.flex}
          variant="secondary"
          onPress={onClose}
          testID="argocd-delete-cancel"
        >
          {submit.status === "done" ? "Close" : "Cancel"}
        </Button>
        {submit.status === "done" ? null : (
          <Button
            style={styles.flex}
            variant="destructive"
            onPress={handleDelete}
            loading={isSubmitting}
            disabled={!nameMatches || isSubmitting}
            testID="argocd-delete-submit"
          >
            {isSubmitting ? "Deleting..." : "Delete"}
          </Button>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

/** Auto-sync on/off with prune and self-heal (the one sync-policy change spec 30.3 allows). */
export function ArgoCdAutoSyncDialog({ serverId, instanceId, app, onClose }: DialogProps) {
  const client = useHostRuntimeClient(serverId);
  const [enabled, setEnabled] = useState(app.autoSync);
  const [prune, setPrune] = useState(app.autoSyncPrune);
  const [selfHeal, setSelfHeal] = useState(app.autoSyncSelfHeal);
  const header = useMemo<SheetHeader>(
    () => ({ title: "Auto-sync", subtitle: app.name }),
    [app.name],
  );
  const [submit, setSubmit] = useState<SubmitState>({ status: "editing" });

  const handleSave = useCallback(async () => {
    if (!client) {
      setSubmit({ status: "failed", message: "The host is not connected." });
      return;
    }
    setSubmit({ status: "submitting" });
    try {
      const payload = await client.argocd("argocd.app.set_auto_sync.request", {
        instanceId,
        app: { name: app.name, appNamespace: app.appNamespace },
        enabled,
        prune: enabled && prune,
        selfHeal: enabled && selfHeal,
      });
      setSubmit(payload.error ? { status: "failed", message: payload.error } : { status: "done" });
    } catch (error) {
      setSubmit({ status: "failed", message: errorMessage(error, "Unable to change auto-sync") });
    }
  }, [app.appNamespace, app.name, client, enabled, instanceId, prune, selfHeal]);

  const isSubmitting = submit.status === "submitting";
  const isUnchanged =
    enabled === app.autoSync &&
    (!enabled || (prune === app.autoSyncPrune && selfHeal === app.autoSyncSelfHeal));
  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} testID="argocd-autosync-dialog">
      <View style={styles.switchRow}>
        <View style={styles.switchText}>
          <Text style={styles.switchLabel}>Automated sync</Text>
          <Text style={styles.body}>Argo CD syncs the app whenever Git changes</Text>
        </View>
        <Switch
          value={enabled}
          onValueChange={setEnabled}
          disabled={isSubmitting}
          accessibilityLabel="Automated sync"
          testID="argocd-autosync-enabled"
        />
      </View>
      {enabled ? (
        <>
          <ArgoCdCheckbox
            label="Prune resources"
            description="Delete resources removed from Git"
            value={prune}
            onValueChange={setPrune}
            disabled={isSubmitting}
          />
          <ArgoCdCheckbox
            label="Self heal"
            description="Revert changes made directly in the cluster"
            value={selfHeal}
            onValueChange={setSelfHeal}
            disabled={isSubmitting}
          />
        </>
      ) : null}
      {submit.status === "failed" ? (
        <Alert variant="error" title="Unable to change auto-sync" description={submit.message} />
      ) : null}
      {submit.status === "done" ? (
        <Alert variant="success" title={enabled ? "Auto-sync is on" : "Auto-sync is off"} />
      ) : null}
      <View style={styles.actions}>
        <Button
          style={styles.flex}
          variant="secondary"
          onPress={onClose}
          testID="argocd-autosync-cancel"
        >
          {submit.status === "done" ? "Close" : "Cancel"}
        </Button>
        {submit.status === "done" ? null : (
          <Button
            style={styles.flex}
            variant="default"
            onPress={handleSave}
            loading={isSubmitting}
            disabled={isSubmitting || isUnchanged}
            testID="argocd-autosync-save"
          >
            {isSubmitting ? "Saving..." : "Save"}
          </Button>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

function DiffItem({ item }: { item: ArgoCdResourceDiff }) {
  const lines = useMemo(() => parseUnifiedDiff(item.diff), [item.diff]);
  return (
    <View style={styles.diffItem}>
      <Text style={styles.diffTitle}>
        {`${item.kind} ${item.namespace ? `${item.namespace}/` : ""}${item.name}${item.truncated ? " (truncated)" : ""}`}
      </Text>
      <DiffViewer diffLines={lines} />
    </View>
  );
}

/** App diff: live vs desired state, one unified diff per changed resource (reference §3.4). */
export function ArgoCdAppDiffSheet({ serverId, instanceId, app, onClose }: DialogProps) {
  const query = useArgoCdAppDiff(
    { serverId, instanceId, app: { name: app.name, appNamespace: app.appNamespace } },
    true,
  );
  const header = useMemo<SheetHeader>(
    () => ({ title: "Diff", subtitle: `${app.name}: live state vs Git` }),
    [app.name],
  );
  const handleRetry = useCallback(() => void query.refetch(), [query]);
  const modified = useMemo(() => (query.data ?? []).filter((item) => item.modified), [query.data]);
  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      desktopMaxWidth={960}
      testID="argocd-diff-sheet"
    >
      {query.isPending ? (
        <View style={styles.loading}>
          <ArgoCdSpinner size={14} />
          <Text style={styles.body}>Computing diff...</Text>
        </View>
      ) : null}
      {query.isError ? (
        <Alert
          variant="error"
          title="Unable to compute the diff"
          description={errorMessage(query.error, "")}
        >
          <Button variant="outline" size="sm" onPress={handleRetry}>
            Retry
          </Button>
        </Alert>
      ) : null}
      {query.isSuccess && modified.length === 0 ? (
        <Text style={styles.body}>Live state matches Git</Text>
      ) : null}
      <ScrollView>
        {modified.map((item) => (
          <DiffItem key={`${item.group}/${item.kind}/${item.namespace}/${item.name}`} item={item} />
        ))}
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  field: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  flex: {
    flex: 1,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  switchText: {
    flex: 1,
    gap: 2,
  },
  switchLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  loading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  diffItem: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[4],
  },
  diffTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
