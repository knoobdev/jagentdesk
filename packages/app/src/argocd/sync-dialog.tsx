import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  ArgoCdAppDetail,
  ArgoCdManagedResource,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { ArgoCdCheckbox } from "./checkbox";
import { ArgoCdSyncBadge } from "./status";
import { resourceKeyId } from "./resources";
import {
  PRUNE_PROPAGATION_POLICIES,
  SYNC_OPTION_DEFINITIONS,
  buildSyncRequestOptions,
  initialSyncForm,
  summarizeSync,
  syncableResources,
  type PrunePropagationPolicy,
  type SyncFormState,
  type SyncOptionFlag,
  type SyncSummary,
} from "./sync-form";

type SubmitState =
  | { status: "editing" }
  | { status: "submitting" }
  | { status: "done"; dryRun: boolean }
  | { status: "failed"; message: string };

type MainFlag = "prune" | "dryRun" | "applyOnly" | "force";

const MAIN_FLAGS: ReadonlyArray<{ key: MainFlag; label: string; description: string }> = [
  { key: "prune", label: "Prune", description: "Delete resources that are no longer in Git" },
  { key: "dryRun", label: "Dry run", description: "Validate without changing the cluster" },
  { key: "applyOnly", label: "Apply only", description: "Apply manifests without running hooks" },
  {
    key: "force",
    label: "Force",
    description: "Delete and re-create resources that fail to apply",
  },
];

function MainFlagRow({
  flag,
  form,
  onChange,
}: {
  flag: (typeof MAIN_FLAGS)[number];
  form: SyncFormState;
  onChange: (key: MainFlag, value: boolean) => void;
}) {
  const handleChange = useCallback(
    (value: boolean) => onChange(flag.key, value),
    [flag.key, onChange],
  );
  return (
    <ArgoCdCheckbox
      label={flag.label}
      description={flag.description}
      value={form[flag.key]}
      onValueChange={handleChange}
      testID={`argocd-sync-${flag.key}`}
    />
  );
}

function OptionRow({
  flag,
  label,
  value,
  onChange,
}: {
  flag: SyncOptionFlag;
  label: string;
  value: boolean;
  onChange: (flag: SyncOptionFlag, value: boolean) => void;
}) {
  const handleChange = useCallback((next: boolean) => onChange(flag, next), [flag, onChange]);
  return (
    <ArgoCdCheckbox
      label={label}
      value={value}
      onValueChange={handleChange}
      testID={`argocd-sync-option-${flag}`}
    />
  );
}

function PolicyItem({
  policy,
  selected,
  onSelect,
}: {
  policy: PrunePropagationPolicy;
  selected: boolean;
  onSelect: (policy: PrunePropagationPolicy) => void;
}) {
  const handleSelect = useCallback(() => onSelect(policy), [onSelect, policy]);
  return (
    <DropdownMenuItem selected={selected} showSelectedCheck onSelect={handleSelect}>
      {policy}
    </DropdownMenuItem>
  );
}

function ResourceRow({
  resource,
  selected,
  onToggle,
}: {
  resource: ArgoCdManagedResource;
  selected: boolean;
  onToggle: (id: string, value: boolean) => void;
}) {
  const id = resourceKeyId(resource);
  const handleChange = useCallback((value: boolean) => onToggle(id, value), [id, onToggle]);
  return (
    <ArgoCdCheckbox
      label={`${resource.kind}/${resource.name}`}
      value={selected}
      onValueChange={handleChange}
    >
      <ArgoCdSyncBadge status={resource.sync} />
      {resource.requiresPruning ? <Text style={styles.pruneTag}>needs pruning</Text> : null}
    </ArgoCdCheckbox>
  );
}

function summaryText(summary: SyncSummary): string {
  const changes = `${summary.changes} ${summary.changes === 1 ? "resource" : "resources"} will change`;
  return `${changes}, ${summary.prunes} will be pruned`;
}

function SyncSummaryView({ summary, dryRun }: { summary: SyncSummary; dryRun: boolean }) {
  const prefix = dryRun ? "Dry run: " : "";
  if (summary.prunes > 0) {
    return (
      <Alert
        variant="warning"
        title={`${prefix}${summaryText(summary)}`}
        description={`Prune deletes ${summary.prunes} ${summary.prunes === 1 ? "resource" : "resources"} from the cluster.`}
        testID="argocd-sync-summary"
      />
    );
  }
  const skipped =
    summary.pruneSkipped > 0
      ? `${summary.pruneSkipped} need pruning but stay because Prune is off.`
      : undefined;
  return (
    <Alert
      variant="info"
      title={`${prefix}${summaryText(summary)}`}
      description={skipped}
      testID="argocd-sync-summary"
    />
  );
}

/** Synchronize panel (spec 30.3; reference §1.3 maps each control to the request). */
export function ArgoCdSyncDialog({
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
  const [form, setForm] = useState<SyncFormState>(() => initialSyncForm(app));
  const [submit, setSubmit] = useState<SubmitState>({ status: "editing" });
  const resources = useMemo(() => syncableResources(app.resources), [app.resources]);
  const summary = useMemo(() => summarizeSync(form, app.resources), [form, app.resources]);

  const handleRevision = useCallback(
    (revision: string) => setForm((f) => ({ ...f, revision })),
    [],
  );
  const handleMainFlag = useCallback(
    (key: MainFlag, value: boolean) => setForm((f) => ({ ...f, [key]: value })),
    [],
  );
  const handleOption = useCallback(
    (flag: SyncOptionFlag, value: boolean) =>
      setForm((f) => ({ ...f, flags: { ...f.flags, [flag]: value } })),
    [],
  );
  const handlePolicy = useCallback(
    (prunePropagationPolicy: PrunePropagationPolicy) =>
      setForm((f) => ({ ...f, prunePropagationPolicy })),
    [],
  );
  const handleToggleResource = useCallback((id: string, value: boolean) => {
    setForm((f) => {
      const selected = new Set(f.selected);
      if (value) selected.add(id);
      else selected.delete(id);
      return { ...f, selected };
    });
  }, []);
  const handleSelectAll = useCallback(
    () => setForm((f) => ({ ...f, selected: new Set(resources.map(resourceKeyId)) })),
    [resources],
  );
  const handleSelectNone = useCallback(() => setForm((f) => ({ ...f, selected: new Set() })), []);

  const handleSubmit = useCallback(async () => {
    if (!client) {
      setSubmit({ status: "failed", message: "The host is not connected." });
      return;
    }
    setSubmit({ status: "submitting" });
    try {
      const payload = await client.argocd("argocd.app.sync.request", {
        instanceId,
        app: { name: app.name, appNamespace: app.appNamespace },
        options: buildSyncRequestOptions(form, app),
      });
      setSubmit(
        payload.error
          ? { status: "failed", message: payload.error }
          : { status: "done", dryRun: form.dryRun },
      );
    } catch (error) {
      setSubmit({
        status: "failed",
        message: error instanceof Error ? error.message : "Unable to start the sync",
      });
    }
  }, [app, client, form, instanceId]);

  const isSubmitting = submit.status === "submitting";
  const hasNoSelection = resources.length > 0 && form.selected.size === 0;
  const destination = `${app.destName ?? app.destServer ?? "cluster"}/${app.destNamespace ?? ""}`;
  const header = useMemo<SheetHeader>(
    () => ({ title: `Sync ${app.name}`, subtitle: `${app.project} → ${destination}` }),
    [app.name, app.project, destination],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      desktopMaxWidth={640}
      testID="argocd-sync-dialog"
    >
      <View style={styles.field}>
        <Text style={styles.label}>Revision</Text>
        <AdaptiveTextInput
          style={styles.input}
          initialValue={form.revision}
          onChangeText={handleRevision}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isSubmitting}
          accessibilityLabel="Revision"
          testID="argocd-sync-revision"
        />
      </View>

      <View style={styles.section}>
        {MAIN_FLAGS.map((flag) => (
          <MainFlagRow key={flag.key} flag={flag} form={form} onChange={handleMainFlag} />
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.label}>Sync options</Text>
        <View style={styles.optionGrid}>
          {SYNC_OPTION_DEFINITIONS.map((definition) => (
            <View key={definition.flag} style={styles.optionCell}>
              <OptionRow
                flag={definition.flag}
                label={definition.label}
                value={form.flags[definition.flag]}
                onChange={handleOption}
              />
            </View>
          ))}
        </View>
        <View style={styles.policyRow}>
          <Text style={styles.policyLabel}>Prune propagation policy</Text>
          <DropdownMenu>
            <DropdownTrigger
              style={styles.policyTrigger}
              accessibilityRole="button"
              accessibilityLabel="Prune propagation policy"
              testID="argocd-sync-prune-policy"
            >
              <Text style={styles.policyValue}>{form.prunePropagationPolicy}</Text>
            </DropdownTrigger>
            <DropdownMenuContent align="start">
              {PRUNE_PROPAGATION_POLICIES.map((policy) => (
                <PolicyItem
                  key={policy}
                  policy={policy}
                  selected={form.prunePropagationPolicy === policy}
                  onSelect={handlePolicy}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.resourcesHeader}>
          <Text
            style={styles.label}
          >{`Resources (${summary.selected} of ${resources.length} selected)`}</Text>
          <View style={styles.selectButtons}>
            <Button variant="ghost" size="xs" onPress={handleSelectAll}>
              All
            </Button>
            <Button variant="ghost" size="xs" onPress={handleSelectNone}>
              None
            </Button>
          </View>
        </View>
        {resources.map((resource) => {
          const id = resourceKeyId(resource);
          return (
            <ResourceRow
              key={id}
              resource={resource}
              selected={form.selected.has(id)}
              onToggle={handleToggleResource}
            />
          );
        })}
      </View>

      <SyncSummaryView summary={summary} dryRun={form.dryRun} />
      {submit.status === "failed" ? (
        <Alert
          variant="error"
          title="Unable to sync"
          description={submit.message}
          testID="argocd-sync-error"
        />
      ) : null}
      {submit.status === "done" ? (
        <Alert
          variant="success"
          title={submit.dryRun ? "Dry run started" : "Sync started"}
          description="Argo CD accepted the operation. Status updates live on this page."
          testID="argocd-sync-done"
        />
      ) : null}

      <View style={styles.actions}>
        <Button
          style={styles.flex}
          variant="secondary"
          onPress={onClose}
          testID="argocd-sync-cancel"
        >
          {submit.status === "done" ? "Close" : "Cancel"}
        </Button>
        {submit.status === "done" ? null : (
          <Button
            style={styles.flex}
            variant="default"
            onPress={handleSubmit}
            loading={isSubmitting}
            disabled={isSubmitting || hasNoSelection}
            testID="argocd-sync-submit"
          >
            {isSubmitting ? "Syncing..." : "Synchronize"}
          </Button>
        )}
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  field: {
    gap: theme.spacing[2],
  },
  section: {
    gap: theme.spacing[1],
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
  optionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  optionCell: {
    minWidth: 220,
    flexBasis: "50%",
    flexGrow: 1,
  },
  policyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  policyLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  policyTrigger: {
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    justifyContent: "center",
  },
  policyValue: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  resourcesHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  selectButtons: {
    flexDirection: "row",
    gap: theme.spacing[1],
  },
  pruneTag: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  flex: {
    flex: 1,
  },
}));
