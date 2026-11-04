import { useCallback, useMemo, useReducer, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ChevronDown,
  ChevronLeft,
  FileDiff,
  History,
  RefreshCw,
  RotateCw,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Zap,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArgoCdAppDetail, ArgoCdAppRef } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { CompactBackButton } from "@/components/headers/compact-back-button";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArgoCdSpinner } from "./spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { buildArgoCdInstanceRoute } from "@/utils/host-routes";
import { formatTimeAgo } from "@/utils/time";
import { ArgoCdAppDiffSheet, ArgoCdAutoSyncDialog, ArgoCdDeleteAppDialog } from "./app-dialogs";
import { useArgoCdAskAi } from "./ask-ai";
import { ArgoCdHistoryPanel, shortRevision } from "./history-panel";
import { openResourceInClusters } from "./open-in-clusters";
import { useArgoCdClusterLink } from "./queries";
import { ArgoCdResourceDetail } from "./resource-detail";
import { ArgoCdResourceFilters } from "./resource-filters";
import { ArgoCdResourceGraph } from "./resource-graph";
import { ArgoCdResourceTreeList } from "./resource-tree-list";
import { ArgoCdPodsView, ArgoCdResourceList } from "./resource-views";
import {
  EMPTY_RESOURCE_FILTER,
  buildResourceModel,
  filterOptions,
  filterResources,
  type ArgoCdResourceFilter,
  type ArgoCdResourceItem,
} from "./resources";
import { ArgoCdHealthBadge, ArgoCdSyncBadge } from "./status";
import { ArgoCdSyncDialog } from "./sync-dialog";
import { useArgoCdAppSubscription } from "./use-app-subscription";

const ThemedChevronDown = withUnistyles(ChevronDown);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type ResourceView = "tree" | "list" | "pods";
type OpenDialog = "sync" | "history" | "diff" | "delete" | "autoSync" | null;

const VIEW_OPTIONS: SegmentedControlOption<ResourceView>[] = [
  { value: "tree", label: "Tree", testID: "argocd-view-tree" },
  { value: "list", label: "List", testID: "argocd-view-list" },
  { value: "pods", label: "Pods", testID: "argocd-view-pods" },
];

type ActionState =
  | { status: "idle" }
  | { status: "pending"; label: string }
  | { status: "success"; message: string }
  | { status: "failed"; title: string; message: string };

type ActionEvent =
  | { type: "start"; label: string }
  | { type: "succeeded"; message: string }
  | { type: "failed"; title: string; message: string }
  | { type: "dismiss" };

function reduceAction(_state: ActionState, event: ActionEvent): ActionState {
  switch (event.type) {
    case "start":
      return { status: "pending", label: event.label };
    case "succeeded":
      return { status: "success", message: event.message };
    case "failed":
      return { status: "failed", title: event.title, message: event.message };
    case "dismiss":
      return { status: "idle" };
  }
}

function destinationLabel(app: ArgoCdAppDetail): string {
  const cluster = app.destName ?? app.destServer ?? "cluster";
  return app.destNamespace ? `${cluster} / ${app.destNamespace}` : cluster;
}

function StatusCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.statusCard}>
      <Text style={styles.statusTitle}>{title}</Text>
      {children}
    </View>
  );
}

function SyncStatusCard({ app }: { app: ArgoCdAppDetail }) {
  const metadata = app.revisionMetadata;
  const targetRevision = app.sources[0]?.targetRevision || "HEAD";
  const commitAuthor =
    metadata?.author && metadata.date_ms
      ? `${metadata.author} · ${formatTimeAgo(new Date(metadata.date_ms))}`
      : (metadata?.author ?? null);
  return (
    <StatusCard title="Sync status">
      <View style={styles.inlineRow}>
        <ArgoCdSyncBadge status={app.sync} testID="argocd-app-sync" />
        <Text style={styles.mutedText}>{`to ${targetRevision}`}</Text>
        <Text style={styles.mono}>{shortRevision(app.syncRevision)}</Text>
      </View>
      <Text style={styles.mutedText}>{app.autoSync ? "Auto-sync is on" : "Auto-sync is off"}</Text>
      {metadata?.message ? (
        <Text style={styles.bodyText} numberOfLines={2}>
          {metadata.message}
        </Text>
      ) : null}
      {commitAuthor ? (
        <Text style={styles.mutedText} numberOfLines={1}>
          {commitAuthor}
        </Text>
      ) : null}
    </StatusCard>
  );
}

function LastSyncCard({ app }: { app: ArgoCdAppDetail }) {
  const operation = app.operationState;
  if (!operation) {
    return (
      <StatusCard title="Last sync">
        <Text style={styles.mutedText}>Never synced</Text>
      </StatusCard>
    );
  }
  const isFailed = operation.phase === "Failed" || operation.phase === "Error";
  const finishedAt = operation.finishedAt_ms;
  const details = [
    finishedAt ? formatTimeAgo(new Date(finishedAt)) : null,
    operation.revision ? shortRevision(operation.revision) : null,
    operation.automated ? "automated" : operation.initiatedBy,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <StatusCard title="Last sync">
      <Text style={isFailed ? styles.dangerText : styles.bodyText} testID="argocd-operation-phase">
        {app.operationRunning ? `${operation.phase}...` : operation.phase}
      </Text>
      <Text style={styles.mutedText} numberOfLines={1}>
        {details}
      </Text>
      {isFailed && operation.message ? (
        <Text style={styles.dangerText} numberOfLines={4} selectable>
          {operation.message}
        </Text>
      ) : null}
    </StatusCard>
  );
}

function ConditionsCard({ app }: { app: ArgoCdAppDetail }) {
  return (
    <StatusCard title={`Conditions (${app.conditions.length})`}>
      {app.conditions.length === 0 ? <Text style={styles.mutedText}>None</Text> : null}
      {app.conditions.map((condition) => (
        <Text
          key={`${condition.type}/${condition.message}`}
          style={styles.bodyText}
          numberOfLines={3}
          selectable
        >
          <Text style={condition.type.endsWith("Error") ? styles.dangerText : styles.warningText}>
            {condition.type}
          </Text>
          {`: ${condition.message}`}
        </Text>
      ))}
    </StatusCard>
  );
}

function StatusPanel({ app }: { app: ArgoCdAppDetail }) {
  return (
    <View style={styles.statusPanel} testID="argocd-status-panel">
      <StatusCard title="App health">
        <ArgoCdHealthBadge status={app.health} testID="argocd-app-health" />
        {app.deleting ? <Text style={styles.warningText}>Deleting</Text> : null}
      </StatusCard>
      <SyncStatusCard app={app} />
      <LastSyncCard app={app} />
      <ConditionsCard app={app} />
    </View>
  );
}

function RefreshMenu({
  onHardRefresh,
  disabled,
}: {
  onHardRefresh: () => void;
  disabled: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.menuTrigger}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="More refresh options"
        testID="argocd-refresh-menu"
      >
        <ThemedChevronDown size={14} uniProps={mutedColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          description="Re-generate manifests, bypassing the cache"
          onSelect={onHardRefresh}
          testID="argocd-hard-refresh"
        >
          Hard refresh
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionBanner({ state, onDismiss }: { state: ActionState; onDismiss: () => void }) {
  if (state.status === "idle") return null;
  if (state.status === "pending") {
    return (
      <View style={styles.pendingRow} testID="argocd-action-pending">
        <ArgoCdSpinner size={14} />
        <Text style={styles.mutedText}>{state.label}</Text>
      </View>
    );
  }
  const isFailure = state.status === "failed";
  return (
    <Alert
      variant={isFailure ? "error" : "success"}
      title={isFailure ? state.title : state.message}
      description={isFailure ? state.message : undefined}
      testID="argocd-action-result"
    >
      <Button variant="outline" size="sm" onPress={onDismiss}>
        Dismiss
      </Button>
    </Alert>
  );
}

function ResourceArea({
  view,
  isCompact,
  children,
  app,
  model,
  filtered,
  selectedId,
  onSelect,
}: {
  view: ResourceView;
  isCompact: boolean;
  /** The page header; phones scroll it with the resources. */
  children?: ReactNode;
  app: ArgoCdAppDetail;
  model: ReturnType<typeof buildResourceModel>;
  filtered: ReturnType<typeof filterResources>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (view === "list") {
    return (
      <ArgoCdResourceList
        model={model}
        filtered={filtered}
        selectedId={selectedId}
        onSelect={onSelect}
      >
        {children}
      </ArgoCdResourceList>
    );
  }
  if (view === "pods") {
    return (
      <ArgoCdPodsView model={model} filtered={filtered} selectedId={selectedId} onSelect={onSelect}>
        {children}
      </ArgoCdPodsView>
    );
  }
  if (isCompact) {
    return (
      <ArgoCdResourceTreeList model={model} filtered={filtered} onSelect={onSelect}>
        {children}
      </ArgoCdResourceTreeList>
    );
  }
  return (
    <ArgoCdResourceGraph
      app={app}
      model={model}
      filtered={filtered}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}

function AppDetailContent({
  serverId,
  instanceId,
  appRef,
  app,
  tree,
}: {
  serverId: string;
  instanceId: string;
  appRef: ArgoCdAppRef;
  app: ArgoCdAppDetail;
  tree: Parameters<typeof buildResourceModel>[0]["tree"];
}) {
  const client = useHostRuntimeClient(serverId);
  const router = useRouter();
  const isCompact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const askAi = useArgoCdAskAi(serverId);
  const linkQuery = useArgoCdClusterLink({ serverId, instanceId, app: appRef });
  const link = linkQuery.data?.clusterConnected ? (linkQuery.data.link ?? null) : null;

  const [view, setView] = useState<ResourceView>("tree");
  const [filter, setFilter] = useState<ArgoCdResourceFilter>(EMPTY_RESOURCE_FILTER);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const [action, dispatchAction] = useReducer(reduceAction, { status: "idle" });

  const model = useMemo(
    () => buildResourceModel({ resources: app.resources, tree }),
    [app.resources, tree],
  );
  const options = useMemo(() => filterOptions(model), [model]);
  const filtered = useMemo(() => filterResources(model, filter), [model, filter]);
  const selectedItem = selectedId ? (model.items.get(selectedId) ?? null) : null;
  const needsPruneConfirmation = app.resources.some(
    (resource) => resource.requiresDeletionConfirmation,
  );
  const isActionPending = action.status === "pending";

  const runAction = useCallback(
    async (input: {
      label: string;
      success: string;
      failureTitle: string;
      send: () => Promise<{ error: string | null }>;
    }) => {
      dispatchAction({ type: "start", label: input.label });
      try {
        const payload = await input.send();
        if (payload.error)
          dispatchAction({ type: "failed", title: input.failureTitle, message: payload.error });
        else dispatchAction({ type: "succeeded", message: input.success });
      } catch (error) {
        dispatchAction({
          type: "failed",
          title: input.failureTitle,
          message: error instanceof Error ? error.message : "The request failed",
        });
      }
    },
    [],
  );

  const refresh = useCallback(
    (hard: boolean) => {
      if (!client) return;
      void runAction({
        label: hard ? "Hard refreshing..." : "Refreshing...",
        success: hard ? "Hard refresh requested" : "Refresh requested",
        failureTitle: "Unable to refresh",
        send: () => client.argocd("argocd.app.refresh.request", { instanceId, app: appRef, hard }),
      });
    },
    [appRef, client, instanceId, runAction],
  );
  const handleRefresh = useCallback(() => refresh(false), [refresh]);
  const handleHardRefresh = useCallback(() => refresh(true), [refresh]);

  const handleTerminate = useCallback(async () => {
    if (!client) return;
    const confirmed = await confirmDialog({
      title: "Terminate operation",
      message: `Stop the running operation on ${app.name}?`,
      confirmLabel: "Terminate",
      destructive: true,
    });
    if (!confirmed) return;
    await runAction({
      label: "Terminating...",
      success: "Termination requested",
      failureTitle: "Unable to terminate",
      send: () => client.argocd("argocd.app.terminate.request", { instanceId, app: appRef }),
    });
  }, [app.name, appRef, client, instanceId, runAction]);

  const handleConfirmPruning = useCallback(async () => {
    if (!client) return;
    const count = app.resources.filter((resource) => resource.requiresDeletionConfirmation).length;
    const confirmed = await confirmDialog({
      title: "Confirm pruning",
      message: `Allow Argo CD to delete ${count} ${count === 1 ? "resource" : "resources"} waiting for confirmation?`,
      confirmLabel: "Confirm pruning",
      destructive: true,
    });
    if (!confirmed) return;
    await runAction({
      label: "Confirming pruning...",
      success: "Pruning confirmed",
      failureTitle: "Unable to confirm pruning",
      send: () => client.argocd("argocd.app.confirm_pruning.request", { instanceId, app: appRef }),
    });
  }, [app.resources, appRef, client, instanceId, runAction]);

  const handleDismissAction = useCallback(() => dispatchAction({ type: "dismiss" }), []);
  const openSync = useCallback(() => setDialog("sync"), []);
  const openHistory = useCallback(() => setDialog("history"), []);
  const openDiff = useCallback(() => setDialog("diff"), []);
  const openDelete = useCallback(() => setDialog("delete"), []);
  const openAutoSync = useCallback(() => setDialog("autoSync"), []);
  const closeDialog = useCallback(() => setDialog(null), []);
  const closeDetail = useCallback(() => setSelectedId(null), []);

  const appContext = useMemo(
    () => ({ name: app.name, appNamespace: app.appNamespace, project: app.project }),
    [app.name, app.appNamespace, app.project],
  );
  const handleAskAiApp = useCallback(
    () => askAi({ instanceId, app: appContext, resource: null }),
    [askAi, appContext, instanceId],
  );
  const handleAskAiResource = useCallback(
    (item: ArgoCdResourceItem) =>
      askAi({
        instanceId,
        app: appContext,
        resource: { kind: item.kind, namespace: item.namespace, name: item.name },
      }),
    [askAi, appContext, instanceId],
  );
  const handleOpenInClusters = useCallback(
    (item: ArgoCdResourceItem) => {
      if (!link) return;
      openResourceInClusters({
        serverId,
        clusterId: link.clusterId,
        kind: item.kind,
        namespace: item.namespace,
        name: item.name,
      });
    },
    [link, serverId],
  );
  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(buildArgoCdInstanceRoute(serverId, instanceId));
  }, [instanceId, router, serverId]);

  const detail = selectedItem ? (
    <ArgoCdResourceDetail
      serverId={serverId}
      instanceId={instanceId}
      app={appRef}
      item={selectedItem}
      canOpenInClusters={link !== null}
      onOpenInClusters={handleOpenInClusters}
      onAskAi={handleAskAiResource}
      onClose={closeDetail}
    />
  ) : null;

  const header = (
    <View style={styles.header}>
      <View style={styles.titleRow}>
        <CompactBackButton />
        {isCompact ? null : (
          <Button
            variant="ghost"
            size="xs"
            leftIcon={ChevronLeft}
            onPress={handleBack}
            testID="argocd-app-back"
          >
            Applications
          </Button>
        )}
        <Text style={styles.title} numberOfLines={1} testID="argocd-app-title">
          {app.name}
        </Text>
      </View>
      <Text style={styles.mutedText} numberOfLines={2}>
        {`${app.project} · ${destinationLabel(app)}`}
      </Text>
      <View style={styles.actionBar}>
        <Button
          variant="default"
          size="sm"
          leftIcon={RotateCw}
          onPress={openSync}
          testID="argocd-action-sync"
        >
          Sync
        </Button>
        <View style={styles.splitButton}>
          <Button
            variant="outline"
            size="sm"
            leftIcon={RefreshCw}
            onPress={handleRefresh}
            disabled={isActionPending}
            testID="argocd-action-refresh"
          >
            Refresh
          </Button>
          <RefreshMenu onHardRefresh={handleHardRefresh} disabled={isActionPending} />
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={History}
          onPress={openHistory}
          testID="argocd-action-history"
        >
          History and rollback
        </Button>
        <Button
          variant="outline"
          size="sm"
          leftIcon={FileDiff}
          onPress={openDiff}
          testID="argocd-action-diff"
        >
          Diff
        </Button>
        {needsPruneConfirmation ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={Scissors}
            onPress={handleConfirmPruning}
            disabled={isActionPending}
            testID="argocd-action-confirm-pruning"
          >
            Confirm pruning
          </Button>
        ) : null}
        {app.operationRunning ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={Square}
            onPress={handleTerminate}
            disabled={isActionPending}
            testID="argocd-action-terminate"
          >
            Terminate
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          leftIcon={Zap}
          onPress={openAutoSync}
          testID="argocd-action-autosync"
        >
          {app.autoSync ? "Auto-sync: on" : "Auto-sync: off"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          leftIcon={Sparkles}
          onPress={handleAskAiApp}
          testID="argocd-action-ask-ai"
        >
          Ask AI
        </Button>
        <Button
          variant="outline"
          size="sm"
          leftIcon={Trash2}
          onPress={openDelete}
          testID="argocd-action-delete"
        >
          Delete
        </Button>
      </View>
      <ActionBanner state={action} onDismiss={handleDismissAction} />
      <StatusPanel app={app} />
      <View style={styles.resourceToolbar}>
        <SegmentedControl options={VIEW_OPTIONS} value={view} onValueChange={setView} size="xs" />
        <ArgoCdResourceFilters filter={filter} options={options} onChange={setFilter} />
      </View>
    </View>
  );

  const dialogs = (
    <>
      {dialog === "sync" ? (
        <ArgoCdSyncDialog
          serverId={serverId}
          instanceId={instanceId}
          app={app}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "history" ? (
        <ArgoCdHistoryPanel
          serverId={serverId}
          instanceId={instanceId}
          app={app}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "diff" ? (
        <ArgoCdAppDiffSheet
          serverId={serverId}
          instanceId={instanceId}
          app={app}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "delete" ? (
        <ArgoCdDeleteAppDialog
          serverId={serverId}
          instanceId={instanceId}
          app={app}
          onClose={closeDialog}
        />
      ) : null}
      {dialog === "autoSync" ? (
        <ArgoCdAutoSyncDialog
          serverId={serverId}
          instanceId={instanceId}
          app={app}
          onClose={closeDialog}
        />
      ) : null}
    </>
  );

  if (isCompact) {
    // Phones: the whole page scrolls with the tree; a resource opens full screen.
    return (
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {detail ?? (
          <ResourceArea
            view={view}
            isCompact
            app={app}
            model={model}
            filtered={filtered}
            selectedId={selectedId}
            onSelect={setSelectedId}
          >
            {header}
          </ResourceArea>
        )}
        {dialogs}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <View style={styles.body}>
        <View style={styles.resources}>
          <ResourceArea
            view={view}
            isCompact={false}
            app={app}
            model={model}
            filtered={filtered}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </View>
        {detail ? <View style={styles.sidePanel}>{detail}</View> : null}
      </View>
      {dialogs}
    </View>
  );
}

/** One Argo CD application (spec 30.3 "Chi tiết app"), live through the tree subscription. */
export function ArgoCdAppDetailScreen({
  serverId,
  instanceId,
  name,
  appNamespace,
}: {
  serverId: string;
  instanceId: string;
  name: string;
  appNamespace: string | null;
}) {
  const appRef = useMemo<ArgoCdAppRef>(() => ({ name, appNamespace }), [name, appNamespace]);
  const state = useArgoCdAppSubscription({ serverId, instanceId, app: appRef });
  const router = useRouter();
  const handleBack = useCallback(
    () => router.replace(buildArgoCdInstanceRoute(serverId, instanceId)),
    [instanceId, router, serverId],
  );

  if (state.status === "ready") {
    return (
      <AppDetailContent
        serverId={serverId}
        instanceId={instanceId}
        appRef={appRef}
        app={state.app}
        tree={state.tree}
      />
    );
  }
  return (
    <View style={[styles.container, styles.center]}>
      {state.status === "loading" ? (
        <>
          <ArgoCdSpinner size="large" />
          <Text style={styles.mutedText}>{`Loading ${name}...`}</Text>
        </>
      ) : null}
      {state.status === "error" ? (
        <Alert
          variant="error"
          title={`Unable to load ${name}`}
          description={state.message}
          testID="argocd-app-error"
        >
          <Button variant="outline" size="sm" onPress={handleBack}>
            Back to applications
          </Button>
        </Alert>
      ) : null}
      {state.status === "deleted" ? (
        <Alert variant="info" title={`${name} was deleted`} testID="argocd-app-deleted">
          <Button variant="outline" size="sm" onPress={handleBack}>
            Back to applications
          </Button>
        </Alert>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  center: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  header: {
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[3],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  actionBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  splitButton: {
    flexDirection: "row",
    alignItems: "center",
  },
  menuTrigger: {
    height: 32,
    width: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  pendingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  statusPanel: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  statusCard: {
    flexGrow: 1,
    flexBasis: 220,
    minWidth: 0,
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  statusTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  inlineRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  resourceToolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  body: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  resources: {
    flex: 1,
    minWidth: 0,
  },
  sidePanel: {
    width: 480,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
  },
  bodyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  mutedText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  warningText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusWarning,
  },
  dangerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
}));
