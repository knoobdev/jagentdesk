import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Copy, Pencil, Plus, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ForwardingRule, ForwardingState } from "@jagentdesk/protocol/ssh/forwarding-schemas";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { confirmDialog } from "@/utils/confirm-dialog";
import { ErrorBanner, IconButton, Spinner, destructiveTint, mutedTint } from "../ui";
import type { ForwardingApi } from "./api";
import { describeRule, emptyRuleForm, exposesToNetwork, ruleToForm, type RuleForm } from "./model";
import { ForwardingRuleEditor, type ForwardingServerChoice } from "./rule-editor";
import { useForwardingStore, type ForwardingStore } from "./store";

const ThemedArrow = withUnistyles(ArrowRight);
const ThemedCopy = withUnistyles(Copy);
const ThemedPencil = withUnistyles(Pencil);

const ThemedTrash = withUnistyles(Trash2);

const STOPPED: Omit<ForwardingState, "ruleId"> = {
  status: "stopped",
  activeConnections: 0,
  changedAtMs: 0,
};

type ToggleIntent = "start" | "stop";

function StatusDot({ status }: { status: ForwardingState["status"] }) {
  const tone = {
    stopped: styles.dotStopped,
    starting: styles.dotStarting,
    active: styles.dotActive,
    error: styles.dotError,
  }[status];
  return <View style={[styles.dot, tone]} />;
}

function RuleRow({
  api,
  store,
  rule,
  state: reported,
  serverLabel,
  autoStart,
  onAutoStartChange,
  onEdit,
  onDuplicate,
}: {
  api: ForwardingApi;
  store: ForwardingStore;
  rule: ForwardingRule;
  state: ForwardingState | undefined;
  serverLabel: string | null;
  autoStart: boolean | null;
  onAutoStartChange?: (ruleId: string, enabled: boolean) => void;
  onEdit: (rule: ForwardingRule) => void;
  onDuplicate: (rule: ForwardingRule) => void;
}) {
  const { t } = useTranslation();
  const state = reported ?? { ruleId: rule.id, ...STOPPED };
  const [failure, setFailure] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: (intent: ToggleIntent) =>
      intent === "start" ? api.start(rule.id) : api.stop(rule.id),
    onSuccess: (next) => {
      setFailure(null);
      store.putState(next);
    },
    onError: (error) => setFailure(error instanceof Error ? error.message : String(error)),
  });
  const remove = useMutation({
    mutationFn: () => api.remove(rule.id),
    onSuccess: () => store.dropRule(rule.id),
    onError: (error) => setFailure(error instanceof Error ? error.message : String(error)),
  });
  const running = state.status === "active" || state.status === "starting";

  const confirmExposedStart = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("ssh.forwarding.exposeConfirm.title"),
      message: t("ssh.forwarding.exposeConfirm.message", {
        address: rule.bindAddress,
        port: rule.bindPort,
      }),
      confirmLabel: t("ssh.forwarding.exposeConfirm.confirm"),
      destructive: true,
    });
    if (confirmed) toggle.mutate("start");
  }, [rule.bindAddress, rule.bindPort, t, toggle]);
  const handleToggle = useCallback(
    (enable: boolean) => {
      if (!enable) {
        toggle.mutate("stop");
        return;
      }
      if (!exposesToNetwork(rule)) {
        toggle.mutate("start");
        return;
      }
      void confirmExposedStart();
    },
    [confirmExposedStart, rule, toggle],
  );
  const confirmDelete = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("ssh.forwarding.delete.title", { label: rule.label }),
      message: t("ssh.forwarding.delete.message"),
      confirmLabel: t("ssh.forwarding.delete.confirm"),
      destructive: true,
    });
    if (confirmed) remove.mutate();
  }, [remove, rule.label, t]);
  const handleDelete = useCallback(() => void confirmDelete(), [confirmDelete]);
  const handleTogglePress = useCallback(() => handleToggle(!running), [handleToggle, running]);
  const handleEdit = useCallback(() => onEdit(rule), [onEdit, rule]);
  const handleDuplicate = useCallback(() => onDuplicate(rule), [onDuplicate, rule]);
  const handleAutoStart = useCallback(
    (enabled: boolean) => onAutoStartChange?.(rule.id, enabled),
    [onAutoStartChange, rule.id],
  );
  const dismissFailure = useCallback(() => setFailure(null), []);
  const ends = describeRule(rule, state.boundPort);
  const pending = toggle.isPending || remove.isPending;

  return (
    <View style={styles.row} testID={`forwarding-rule-${rule.id}`}>
      <View style={styles.rowTop}>
        <StatusDot status={state.status} />
        <View style={styles.rowText}>
          <Text style={styles.ruleLabel} numberOfLines={1}>
            {rule.label}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[t(`ssh.forwarding.kinds.${rule.kind}`), serverLabel].filter(Boolean).join(" · ")}
          </Text>
        </View>
        <Button
          size="sm"
          variant={running ? "outline" : "default"}
          onPress={handleTogglePress}
          loading={toggle.isPending}
          disabled={remove.isPending}
          testID={`forwarding-toggle-${rule.id}`}
        >
          {running ? t("ssh.forwarding.stop") : t("ssh.forwarding.start")}
        </Button>
      </View>
      <View style={styles.ends}>
        <Text style={styles.endText}>{ends.from}</Text>
        <ThemedArrow size={12} uniProps={mutedTint} />
        <Text style={styles.endText}>{ends.to}</Text>
      </View>
      <Text style={state.status === "error" ? styles.errorText : styles.meta}>
        {state.status === "error" && state.error
          ? state.error.message
          : t(`ssh.forwarding.status.${state.status}`, { count: state.activeConnections })}
      </Text>
      <View style={styles.rowActions}>
        {autoStart === null ? null : (
          <View style={styles.autoStart}>
            <Switch
              value={autoStart}
              onValueChange={handleAutoStart}
              accessibilityLabel={t("ssh.forwarding.autoStart")}
            />
            <Text style={styles.meta}>{t("ssh.forwarding.autoStart")}</Text>
          </View>
        )}
        <View style={styles.spacer} />
        <IconButton icon={ThemedPencil} label={t("ssh.forwarding.edit")} onPress={handleEdit} />
        <IconButton
          icon={ThemedCopy}
          label={t("ssh.forwarding.duplicate")}
          onPress={handleDuplicate}
        />
        <IconButton
          icon={ThemedTrash}
          label={t("ssh.forwarding.delete.confirm")}
          onPress={handleDelete}
          tint={destructiveTint}
          disabled={pending}
        />
      </View>
      {failure ? (
        <ErrorBanner
          message={failure}
          dismissLabel={t("common.actions.dismiss")}
          onDismiss={dismissFailure}
        />
      ) : null}
    </View>
  );
}

/**
 * Saved port forwarding rules with live status (spec 25.6), start/stop toggles, edit, duplicate
 * and delete. Pass `serverId` to show one server's rules on its screen; pass `autoStartRuleIds`
 * with `onAutoStartChange` to let the user attach rules to that server's connect (its
 * `forwardingRuleIds`, spec 25.2).
 */
export function PortForwardingList({
  api,
  servers,
  serverId,
  autoStartRuleIds,
  onAutoStartChange,
}: {
  api: ForwardingApi;
  servers: ForwardingServerChoice[];
  serverId?: string;
  autoStartRuleIds?: string[];
  onAutoStartChange?: (ruleId: string, enabled: boolean) => void;
}) {
  const { t } = useTranslation();
  const { store, state } = useForwardingStore(api);
  const [editing, setEditing] = useState<RuleForm | null>(null);
  const serverLabels = useMemo(
    () => new Map(servers.map((server) => [server.serverId, server.label])),
    [servers],
  );
  const rules = serverId ? state.rules.filter((rule) => rule.serverId === serverId) : state.rules;

  const openNew = useCallback(
    () => setEditing(emptyRuleForm("local", serverId ?? servers[0]?.serverId ?? "")),
    [serverId, servers],
  );
  const openEdit = useCallback((rule: ForwardingRule) => setEditing(ruleToForm(rule, {})), []);
  const openDuplicate = useCallback(
    (rule: ForwardingRule) =>
      setEditing(
        ruleToForm(rule, { duplicateLabel: t("ssh.forwarding.copyLabel", { label: rule.label }) }),
      ),
    [t],
  );
  const closeEditor = useCallback(() => setEditing(null), []);
  const handleSaved = useCallback(
    (rule: ForwardingRule) => {
      store.putRule(rule);
      setEditing(null);
    },
    [store],
  );
  const retry = useCallback(() => void store.reload(), [store]);

  let content;
  if (state.status === "loading") {
    content = (
      <View style={styles.center}>
        <Spinner />
      </View>
    );
  } else if (state.status === "error") {
    content = (
      <View style={styles.center}>
        <Text style={styles.errorText}>{t("ssh.forwarding.loadFailed")}</Text>
        <Text style={styles.meta}>{state.error}</Text>
        <Button size="sm" variant="outline" onPress={retry}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  } else if (rules.length === 0) {
    content = (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>{t("ssh.forwarding.emptyTitle")}</Text>
        <Text style={styles.meta}>{t("ssh.forwarding.emptyBody")}</Text>
      </View>
    );
  } else {
    content = (
      <ScrollView contentContainerStyle={styles.list}>
        {rules.map((rule) => (
          <RuleRow
            key={rule.id}
            api={api}
            store={store}
            rule={rule}
            state={state.states[rule.id]}
            serverLabel={serverId ? null : (serverLabels.get(rule.serverId) ?? rule.serverId)}
            autoStart={autoStartRuleIds ? autoStartRuleIds.includes(rule.id) : null}
            onAutoStartChange={onAutoStartChange}
            onEdit={openEdit}
            onDuplicate={openDuplicate}
          />
        ))}
      </ScrollView>
    );
  }

  return (
    <View style={styles.container} testID="port-forwarding-list">
      <View style={styles.header}>
        <Text style={styles.title}>{t("ssh.forwarding.title")}</Text>
        <Button
          size="sm"
          variant="default"
          leftIcon={Plus}
          onPress={openNew}
          disabled={servers.length === 0 && !serverId}
          testID="forwarding-new"
        >
          {t("ssh.forwarding.newRule")}
        </Button>
      </View>
      {content}
      {editing ? (
        <ForwardingRuleEditor
          api={api}
          initial={editing}
          servers={servers}
          lockServer={serverId !== undefined}
          onClose={closeEditor}
          onSaved={handleSaved}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  list: {
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
  emptyTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  row: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  rowTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
  },
  ruleLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  meta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  ends: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  endText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  autoStart: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  spacer: {
    flex: 1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  dotStopped: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  dotStarting: {
    backgroundColor: theme.colors.palette.amber[500],
  },
  dotActive: {
    backgroundColor: theme.colors.palette.green[500],
  },
  dotError: {
    backgroundColor: theme.colors.destructive,
  },
}));
