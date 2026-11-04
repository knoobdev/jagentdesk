import { useCallback, useMemo, useReducer, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import { MoreVertical, Plus, Ship, Sparkles } from "lucide-react-native";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ArgoCdInstance, ArgoCdInstanceState } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { PageHeader } from "@/components/headers/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { buildArgoCdInstanceRoute } from "@/utils/host-routes";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useArgoCdAskAi, type ArgoCdAskAiContext } from "./ask-ai";
import { instanceToInput } from "./instance-form";
import { InstanceFormSheet } from "./instance-form-sheet";
import { ArgoCdSignIn } from "./sign-in";
import { errorMessage, useArgoCdInstances } from "./use-instances";

// Argo CD instances (spec 30.3 Instances, 30.2 sign-in): list with sign-in state, user and
// server version; add / edit / delete; sign in, sign out, sign in again.

const STATE_LABELS: Record<ArgoCdInstanceState, string> = {
  connected: "Connected",
  connecting: "Connecting...",
  needs_reauth: "Session expired",
  logged_out: "Signed out",
  error: "Error",
};

const STATE_DOT_STYLE = {
  connected: "dotConnected",
  connecting: "dotConnecting",
  needs_reauth: "dotWarning",
  logged_out: "dotMuted",
  error: "dotError",
} as const;

export function InstanceStateDot({ state }: { state: ArgoCdInstanceState }) {
  return <View style={[styles.dot, styles[STATE_DOT_STYLE[state]]]} />;
}

export function instanceStateLabel(state: ArgoCdInstanceState): string {
  return STATE_LABELS[state];
}

function instanceSummary(instance: ArgoCdInstance): string {
  const parts = [STATE_LABELS[instance.state]];
  if (instance.state === "connected" && instance.username) parts.push(`as ${instance.username}`);
  if (instance.serverVersion) parts.push(`Argo CD ${instance.serverVersion}`);
  return parts.join(" · ");
}

type FormTarget = { open: false } | { open: true; instance: ArgoCdInstance | null };

export function ArgoCdInstancesScreen({ serverId }: { serverId: string }) {
  const { client, state, reload, upsert, remove } = useArgoCdInstances(serverId);
  const [form, setForm] = useState<FormTarget>({ open: false });
  const openCreate = useCallback(() => setForm({ open: true, instance: null }), []);
  const openEdit = useCallback((instance: ArgoCdInstance) => setForm({ open: true, instance }), []);
  const closeForm = useCallback(() => setForm({ open: false }), []);
  const askAi = useArgoCdAskAi(serverId);

  const headerActions = useMemo(
    () => (
      <Button
        size="sm"
        variant="outline"
        leftIcon={Plus}
        onPress={openCreate}
        disabled={!client}
        testID="argocd-add-instance"
      >
        Add instance
      </Button>
    ),
    [client, openCreate],
  );

  return (
    <View style={styles.page} testID="argocd-instances-screen">
      <PageHeader
        icon={Ship}
        title="Argo CD"
        description="Sign in to Argo CD, then browse and sync its applications."
        actions={headerActions}
      />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.column}>
          <InstancesBody
            serverId={serverId}
            client={client}
            state={state}
            onRetry={reload}
            onAskAi={askAi}
            onEdit={openEdit}
            onInstance={upsert}
            onRemoved={remove}
          />
        </View>
      </ScrollView>
      {form.open && client ? (
        <InstanceFormSheet
          key={form.instance?.id ?? "new"}
          client={client}
          instance={form.instance}
          onClose={closeForm}
          onSaved={upsert}
        />
      ) : null}
    </View>
  );
}

interface InstancesBodyProps {
  serverId: string;
  client: DaemonClient | null;
  state: ReturnType<typeof useArgoCdInstances>["state"];
  onRetry: () => void;
  onAskAi: (context: ArgoCdAskAiContext) => void;
  onEdit: (instance: ArgoCdInstance) => void;
  onInstance: (instance: ArgoCdInstance) => void;
  onRemoved: (id: string) => void;
}

function InstancesBody({
  serverId,
  client,
  state,
  onRetry,
  onAskAi,
  onEdit,
  onInstance,
  onRemoved,
}: InstancesBodyProps) {
  if (state.status === "connecting" || state.status === "loading" || !client) {
    return (
      <View style={styles.center}>
        <ThemedSpinner size="large" uniProps={mutedColor} />
      </View>
    );
  }
  if (state.status === "error") {
    return (
      <Alert variant="error" title="Unable to load Argo CD instances" description={state.error}>
        <View style={styles.alertActions}>
          <Button size="sm" variant="outline" onPress={onRetry}>
            Retry
          </Button>
        </View>
      </Alert>
    );
  }
  if (state.instances.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.empty}>No Argo CD instances yet</Text>
      </View>
    );
  }
  return (
    <View style={settingsStyles.card}>
      {state.instances.map((instance, index) => (
        <InstanceRow
          key={instance.id}
          serverId={serverId}
          client={client}
          instance={instance}
          isFirst={index === 0}
          onAskAi={onAskAi}
          onEdit={onEdit}
          onInstance={onInstance}
          onRemoved={onRemoved}
        />
      ))}
    </View>
  );
}

type RowTask = "signout" | "delete" | "trust";

interface IdleRow {
  status: "idle";
  confirmingDelete: boolean;
  signInOpen: boolean;
}

type RowState =
  | IdleRow
  | { status: "pending"; task: RowTask }
  | { status: "failed"; message: string };

type RowAction =
  | { type: "confirmDelete"; value: boolean }
  | { type: "toggleSignIn" }
  | { type: "start"; task: RowTask }
  | { type: "failed"; message: string }
  | { type: "done" };

const IDLE: IdleRow = { status: "idle", confirmingDelete: false, signInOpen: false };

function reduceRow(state: RowState, action: RowAction): RowState {
  switch (action.type) {
    case "confirmDelete":
      return { ...IDLE, confirmingDelete: action.value };
    case "toggleSignIn":
      return { ...IDLE, signInOpen: !(state.status === "idle" && state.signInOpen) };
    case "start":
      return { status: "pending", task: action.task };
    case "failed":
      return { status: "failed", message: action.message };
    case "done":
      return IDLE;
  }
}

const PENDING_LABELS: Record<RowTask, string> = {
  signout: "Signing out...",
  delete: "Deleting...",
  trust: "Saving...",
};

interface InstanceRowProps {
  serverId: string;
  client: DaemonClient;
  instance: ArgoCdInstance;
  isFirst: boolean;
  onAskAi: (context: ArgoCdAskAiContext) => void;
  onEdit: (instance: ArgoCdInstance) => void;
  onInstance: (instance: ArgoCdInstance) => void;
  onRemoved: (id: string) => void;
}

function InstanceRow({
  serverId,
  client,
  instance,
  isFirst,
  onAskAi,
  onEdit,
  onInstance,
  onRemoved,
}: InstanceRowProps) {
  const router = useRouter();
  const isCompact = useIsCompactFormFactor();
  const [row, dispatch] = useReducer(reduceRow, IDLE);
  const connected = instance.state === "connected";
  const signInOpen = row.status === "idle" && row.signInOpen;
  const showSignIn = !connected || signInOpen;
  const confirmingDelete = row.status === "idle" && row.confirmingDelete;
  const tlsUntrusted = instance.lastErrorCode === "tls_untrusted";

  const open = useCallback(() => {
    router.push(buildArgoCdInstanceRoute(serverId, instance.id));
  }, [instance.id, router, serverId]);
  const edit = useCallback(() => onEdit(instance), [instance, onEdit]);
  const askAi = useCallback(
    () => onAskAi({ instanceId: instance.id, app: null, resource: null }),
    [instance.id, onAskAi],
  );

  const run = useCallback(async (task: RowTask, call: () => Promise<{ error: string | null }>) => {
    dispatch({ type: "start", task });
    try {
      const res = await call();
      if (res.error) dispatch({ type: "failed", message: res.error });
      else dispatch({ type: "done" });
    } catch (error) {
      dispatch({ type: "failed", message: errorMessage(error, "The request failed") });
    }
  }, []);

  const signOut = useCallback(() => {
    void run("signout", async () => {
      const res = await client.argocd("argocd.instances.logout.request", { id: instance.id });
      if (res.instance) onInstance(res.instance);
      return res;
    });
  }, [client, instance.id, onInstance, run]);

  const trust = useCallback(() => {
    void run("trust", async () => {
      const res = await client.argocd("argocd.instances.save.request", {
        instance: instanceToInput(instance, { tlsSkipVerify: true }),
      });
      if (res.instance) onInstance(res.instance);
      return res;
    });
  }, [client, instance, onInstance, run]);

  const confirmDelete = useCallback(() => {
    void run("delete", async () => {
      const res = await client.argocd("argocd.instances.delete.request", { id: instance.id });
      if (!res.error) onRemoved(instance.id);
      return res;
    });
  }, [client, instance.id, onRemoved, run]);

  const askDelete = useCallback(() => dispatch({ type: "confirmDelete", value: true }), []);
  const cancelDelete = useCallback(() => dispatch({ type: "confirmDelete", value: false }), []);
  const toggleSignIn = useCallback(() => dispatch({ type: "toggleSignIn" }), []);

  return (
    <View
      style={isFirst ? styles.row : [styles.row, settingsStyles.rowBorder]}
      testID={`argocd-instance-${instance.id}`}
    >
      <View style={styles.rowHeader}>
        <Pressable
          style={styles.rowMain}
          onPress={open}
          disabled={!connected}
          accessibilityRole="button"
          accessibilityLabel={`Open applications of ${instance.displayName}`}
        >
          <View style={styles.dotSlot}>
            <InstanceStateDot state={instance.state} />
          </View>
          <View style={styles.rowText}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {instance.displayName || instance.url}
            </Text>
            <Text style={styles.hint} numberOfLines={1}>
              {instance.url}
            </Text>
            <Text style={styles.hint} numberOfLines={1} testID="argocd-instance-summary">
              {instanceSummary(instance)}
            </Text>
          </View>
        </Pressable>
        <View style={isCompact ? styles.rowActionsCompact : styles.rowActions}>
          {connected ? (
            <Button size="sm" variant="outline" onPress={open} testID="argocd-instance-open">
              Applications
            </Button>
          ) : null}
          {connected ? (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={Sparkles}
              onPress={askAi}
              testID="argocd-instance-ask-ai"
            >
              Ask AI
            </Button>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              accessibilityLabel={`More actions for ${instance.displayName}`}
              style={styles.kebab}
              testID="argocd-instance-menu"
            >
              <ThemedMore size={16} uniProps={mutedColor} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" minWidth={180}>
              <DropdownMenuItem onSelect={edit} testID="argocd-instance-edit">
                Edit
              </DropdownMenuItem>
              {connected ? (
                <DropdownMenuItem onSelect={toggleSignIn} testID="argocd-instance-signin-again">
                  Sign in again
                </DropdownMenuItem>
              ) : null}
              {connected ? (
                <DropdownMenuItem onSelect={signOut} testID="argocd-instance-signout">
                  Sign out
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem destructive onSelect={askDelete} testID="argocd-instance-delete">
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>

      <InstanceNotice
        instance={instance}
        trusting={row.status === "pending" && row.task === "trust"}
        busy={row.status === "pending"}
        onTrust={trust}
      />

      {showSignIn && !tlsUntrusted ? (
        <View style={styles.indented}>
          <ArgoCdSignIn client={client} instance={instance} onInstance={onInstance} />
        </View>
      ) : null}

      {confirmingDelete ? (
        <DeleteConfirm
          name={instance.displayName || instance.url}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
        />
      ) : null}
      <RowStatus row={row} />
    </View>
  );
}

function InstanceNotice({
  instance,
  trusting,
  busy,
  onTrust,
}: {
  instance: ArgoCdInstance;
  trusting: boolean;
  busy: boolean;
  onTrust: () => void;
}) {
  if (instance.lastErrorCode === "tls_untrusted") {
    const description = instance.tlsFingerprintSha256
      ? `SHA-256 fingerprint: ${instance.tlsFingerprintSha256}`
      : (instance.lastError ?? undefined);
    return (
      <Alert
        variant="warning"
        title="Certificate not trusted"
        description={description}
        testID="argocd-instance-tls"
      >
        <View style={styles.alertActions}>
          <Button
            size="sm"
            variant="outline"
            loading={trusting}
            disabled={busy}
            onPress={onTrust}
            testID="argocd-instance-trust"
          >
            Trust this server (skip TLS verify)
          </Button>
        </View>
      </Alert>
    );
  }
  if (!instance.lastError || instance.state === "connected") return null;
  return (
    <Text style={styles.error} testID="argocd-instance-error">
      {instance.lastError}
    </Text>
  );
}

function DeleteConfirm({
  name,
  onCancel,
  onConfirm,
}: {
  name: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <View style={styles.confirm} testID="argocd-instance-delete-confirm">
      <Text style={styles.confirmText}>{`Delete ${name}? Its saved sign-in is removed too.`}</Text>
      <View style={styles.confirmActions}>
        <Button size="sm" variant="ghost" onPress={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onPress={onConfirm}
          testID="argocd-instance-delete-confirm-button"
        >
          Delete
        </Button>
      </View>
    </View>
  );
}

function RowStatus({ row }: { row: RowState }) {
  if (row.status === "pending" && row.task !== "trust") {
    return (
      <View style={styles.pendingRow}>
        <ThemedSpinner size="small" uniProps={mutedColor} />
        <Text style={styles.hint}>{PENDING_LABELS[row.task]}</Text>
      </View>
    );
  }
  if (row.status === "failed") {
    return (
      <Text style={styles.error} testID="argocd-instance-action-error">
        {row.message}
      </Text>
    );
  }
  return null;
}

const ThemedSpinner = withUnistyles(LoadingSpinner);
const ThemedMore = withUnistyles(MoreVertical);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme) => ({
  page: { flex: 1 },
  scroll: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.chrome.pageCanvas,
  },
  content: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[6],
    flexGrow: 1,
  },
  column: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
    gap: theme.spacing[3],
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 160,
  },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  alertActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  row: {
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    gap: theme.spacing[3],
  },
  rowHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  rowMain: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 240,
    minWidth: 0,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    marginLeft: "auto",
  },
  // Phones: the actions wrap under the text and start on its rail.
  rowActionsCompact: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    width: "100%",
    paddingLeft: theme.spacing[2] + theme.spacing[3],
  },
  kebab: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  hint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  error: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
    paddingLeft: theme.spacing[2] + theme.spacing[3],
  },
  indented: {
    paddingLeft: theme.spacing[2] + theme.spacing[3],
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.borderRadius.full,
  },
  // Optical: centers the dot on the title's first line.
  dotSlot: { paddingTop: 6 },
  dotConnected: { backgroundColor: theme.colors.statusSuccess },
  dotConnecting: { backgroundColor: theme.colors.palette.blue[500] },
  dotWarning: { backgroundColor: theme.colors.statusWarning },
  dotMuted: { backgroundColor: theme.colors.foregroundMuted },
  dotError: { backgroundColor: theme.colors.statusDanger },
  confirm: {
    marginLeft: theme.spacing[2] + theme.spacing[3],
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  confirmText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  confirmActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2] + theme.spacing[3],
  },
}));
