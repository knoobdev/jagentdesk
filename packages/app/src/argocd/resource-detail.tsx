import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Boxes, MoreHorizontal, Sparkles, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ArgoCdAppRef,
  ArgoCdResourceAction,
  ArgoCdResourceRef,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import { KindIcon } from "@/components/cluster-kind-icon";
import { DiffViewer } from "@/components/diff-viewer";
import { HighlightedLines } from "@/components/highlighted-content";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArgoCdSpinner } from "./spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import type { Theme } from "@/styles/theme";
import { highlightToKeyedLines } from "@/utils/highlight-cache";
import { formatTimeAgo } from "@/utils/time";
import { parseUnifiedDiff } from "@/utils/tool-call-parsers";
import { ArgoCdResourceActionSheet } from "./resource-action-sheet";
import { ArgoCdResourceLogs } from "./resource-logs";
import { ArgoCdHealthBadge, ArgoCdSyncBadge } from "./status";
import {
  errorMessage,
  useArgoCdAppDiff,
  useArgoCdEvents,
  useArgoCdLiveManifest,
  useArgoCdResourceActions,
} from "./queries";
import { hasLogs, resourceKeyId, type ArgoCdResourceItem } from "./resources";

const ThemedX = withUnistyles(X);
const ThemedMore = withUnistyles(MoreHorizontal);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type DetailTab = "summary" | "manifest" | "diff" | "events" | "logs";

function StateLine({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return <Text style={tone === "error" ? styles.errorText : styles.mutedText}>{children}</Text>;
}

function Loading({ label }: { label: string }) {
  return (
    <View style={styles.loadingRow}>
      <ArgoCdSpinner size={14} />
      <StateLine>{label}</StateLine>
    </View>
  );
}

function SummaryRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <View style={styles.summaryValue}>
        {typeof children === "string" ? (
          <Text style={styles.summaryText} selectable>
            {children}
          </Text>
        ) : (
          children
        )}
      </View>
    </View>
  );
}

function SummaryTab({ item }: { item: ArgoCdResourceItem }) {
  const createdAt = item.node?.createdAt_ms ?? null;
  return (
    <ScrollView contentContainerStyle={styles.tabContent}>
      <SummaryRow label="Kind">
        {item.group
          ? `${item.kind} (${item.group}/${item.version})`
          : `${item.kind} (${item.version})`}
      </SummaryRow>
      <SummaryRow label="Name">{item.name}</SummaryRow>
      <SummaryRow label="Namespace">{item.namespace || "—"}</SummaryRow>
      {item.sync ? (
        <SummaryRow label="Sync">
          <ArgoCdSyncBadge status={item.sync} />
        </SummaryRow>
      ) : null}
      {item.health ? (
        <SummaryRow label="Health">
          <ArgoCdHealthBadge status={item.health} />
        </SummaryRow>
      ) : null}
      {item.healthMessage ? (
        <SummaryRow label="Health message">{item.healthMessage}</SummaryRow>
      ) : null}
      {item.requiresPruning ? (
        <SummaryRow label="Prune">Not in Git: removed by a sync with Prune</SummaryRow>
      ) : null}
      {(item.node?.info ?? []).map((entry) => (
        <SummaryRow key={entry.name} label={entry.name}>
          {entry.value}
        </SummaryRow>
      ))}
      {(item.node?.images.length ?? 0) > 0 ? (
        <SummaryRow label="Images">{item.node?.images.join("\n") ?? ""}</SummaryRow>
      ) : null}
      {createdAt !== null ? (
        <SummaryRow label="Created">
          {`${new Date(createdAt).toLocaleString()} (${formatTimeAgo(new Date(createdAt))})`}
        </SummaryRow>
      ) : null}
      {item.uid ? <SummaryRow label="UID">{item.uid}</SummaryRow> : null}
      {item.node === null ? (
        <StateLine>This resource does not exist in the cluster yet.</StateLine>
      ) : null}
    </ScrollView>
  );
}

function ManifestTab({
  scope,
  resource,
  exists,
}: {
  scope: Scope;
  resource: ArgoCdResourceRef;
  exists: boolean;
}) {
  const query = useArgoCdLiveManifest(scope, resource, exists);
  const lines = useMemo(
    () => (query.data ? highlightToKeyedLines(query.data, "yaml") : null),
    [query.data],
  );
  if (!exists) return <StateLine>No live manifest: the resource has not been created.</StateLine>;
  if (query.isPending) return <Loading label="Loading manifest..." />;
  if (query.isError)
    return (
      <StateLine tone="error">{errorMessage(query.error, "Unable to load the manifest")}</StateLine>
    );
  return (
    <ScrollView style={styles.codeScroll}>
      <ScrollView horizontal contentContainerStyle={styles.codeInner}>
        {lines ? (
          <HighlightedLines lines={lines} startLine={1} />
        ) : (
          <Text style={styles.code} selectable>
            {query.data}
          </Text>
        )}
      </ScrollView>
    </ScrollView>
  );
}

function DiffTab({ scope, item }: { scope: Scope; item: ArgoCdResourceItem }) {
  const query = useArgoCdAppDiff(scope, true);
  const entry = useMemo(
    () => query.data?.find((diff) => resourceKeyId(diff) === item.id) ?? null,
    [query.data, item.id],
  );
  const lines = useMemo(() => parseUnifiedDiff(entry?.diff ?? ""), [entry]);
  if (query.isPending) return <Loading label="Computing diff..." />;
  if (query.isError)
    return (
      <StateLine tone="error">{errorMessage(query.error, "Unable to compute the diff")}</StateLine>
    );
  if (!entry || !entry.modified) return <StateLine>Live state matches Git</StateLine>;
  return (
    <View style={styles.fill}>
      {entry.truncated ? <StateLine>Diff truncated</StateLine> : null}
      <DiffViewer diffLines={lines} fillAvailableHeight />
    </View>
  );
}

function EventsTab({ scope, item }: { scope: Scope; item: ArgoCdResourceItem }) {
  const resource = item.uid
    ? {
        group: item.group,
        kind: item.kind,
        namespace: item.namespace,
        name: item.name,
        uid: item.uid,
      }
    : null;
  const query = useArgoCdEvents(scope, resource, resource !== null);
  if (!resource) return <StateLine>No events: the resource has not been created.</StateLine>;
  if (query.isPending) return <Loading label="Loading events..." />;
  if (query.isError)
    return <StateLine tone="error">{errorMessage(query.error, "Unable to load events")}</StateLine>;
  if (query.data.length === 0) return <StateLine>No events</StateLine>;
  return (
    <ScrollView contentContainerStyle={styles.tabContent}>
      {query.data.map((event) => {
        const at = event.lastTimestamp_ms ?? event.firstTimestamp_ms;
        return (
          <View
            key={`${event.objectKind}/${event.objectName}/${event.reason}/${event.firstTimestamp_ms ?? ""}/${event.message}`}
            style={styles.event}
          >
            <View style={styles.eventHeader}>
              <Text style={event.type === "Warning" ? styles.eventWarning : styles.eventNormal}>
                {event.type}
              </Text>
              <Text style={styles.eventReason}>{event.reason}</Text>
              <Text style={styles.mutedText}>
                {`${event.count > 1 ? `×${event.count} · ` : ""}${at ? formatTimeAgo(new Date(at)) : ""}`}
              </Text>
            </View>
            <Text style={styles.summaryText} selectable>
              {event.message}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

interface Scope {
  serverId: string;
  instanceId: string;
  app: ArgoCdAppRef;
}

function ActionsMenu({
  scope,
  resource,
  onPick,
}: {
  scope: Scope;
  resource: ArgoCdResourceRef;
  onPick: (action: ArgoCdResourceAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const query = useArgoCdResourceActions(scope, resource, open);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel="Resource actions"
        testID="argocd-resource-actions"
      >
        <ThemedMore size={16} uniProps={mutedColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" minWidth={200}>
        {query.isPending ? <DropdownMenuHint>Loading actions...</DropdownMenuHint> : null}
        {query.isError ? (
          <DropdownMenuHint>{errorMessage(query.error, "Unable to load actions")}</DropdownMenuHint>
        ) : null}
        {query.data && query.data.length === 0 ? (
          <DropdownMenuHint>No actions for this resource</DropdownMenuHint>
        ) : null}
        {(query.data ?? []).map((action) => (
          <ActionItem key={action.name} action={action} onPick={onPick} />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActionItem({
  action,
  onPick,
}: {
  action: ArgoCdResourceAction;
  onPick: (action: ArgoCdResourceAction) => void;
}) {
  const handleSelect = useCallback(() => onPick(action), [action, onPick]);
  return (
    <DropdownMenuItem disabled={action.disabled} onSelect={handleSelect}>
      {action.displayName ?? action.name}
    </DropdownMenuItem>
  );
}

/**
 * One resource of the app (spec 30.3): Summary, Manifest (read only), Diff, Events, Logs, the
 * resource actions menu, Ask AI, and Open in Clusters when the destination is a linked,
 * connected cluster.
 */
export function ArgoCdResourceDetail({
  serverId,
  instanceId,
  app,
  item,
  canOpenInClusters,
  onOpenInClusters,
  onAskAi,
  onClose,
}: {
  serverId: string;
  instanceId: string;
  app: ArgoCdAppRef;
  item: ArgoCdResourceItem;
  canOpenInClusters: boolean;
  onOpenInClusters: (item: ArgoCdResourceItem) => void;
  onAskAi: (item: ArgoCdResourceItem) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("summary");
  const [pickedAction, setPickedAction] = useState<ArgoCdResourceAction | null>(null);
  const scope = useMemo(() => ({ serverId, instanceId, app }), [serverId, instanceId, app]);
  const resource = useMemo<ArgoCdResourceRef>(
    () => ({
      group: item.group,
      version: item.version,
      kind: item.kind,
      namespace: item.namespace,
      name: item.name,
    }),
    [item.group, item.version, item.kind, item.namespace, item.name],
  );
  const showLogs = hasLogs(item) && item.node !== null;
  const tabs = useMemo<SegmentedControlOption<DetailTab>[]>(() => {
    const options: SegmentedControlOption<DetailTab>[] = [
      { value: "summary", label: "Summary" },
      { value: "manifest", label: "Manifest" },
      { value: "diff", label: "Diff" },
      { value: "events", label: "Events" },
    ];
    if (showLogs) options.push({ value: "logs", label: "Logs" });
    return options;
  }, [showLogs]);
  const activeTab = tab === "logs" && !showLogs ? "summary" : tab;

  const handleAskAi = useCallback(() => onAskAi(item), [item, onAskAi]);
  const handleOpenInClusters = useCallback(() => onOpenInClusters(item), [item, onOpenInClusters]);
  const handleCloseAction = useCallback(() => setPickedAction(null), []);

  return (
    <View style={styles.container} testID="argocd-resource-detail">
      <View style={styles.header}>
        <KindIcon kind={item.kind} active />
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.mutedText} numberOfLines={1}>
            {item.namespace ? `${item.kind} · ${item.namespace}` : item.kind}
          </Text>
        </View>
        {item.node ? (
          <ActionsMenu scope={scope} resource={resource} onPick={setPickedAction} />
        ) : null}
        <Pressable
          style={styles.iconButton}
          onPress={onClose}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Close resource"
          testID="argocd-resource-close"
        >
          <ThemedX size={16} uniProps={mutedColor} />
        </Pressable>
      </View>
      <View style={styles.headerActions}>
        <Button
          variant="outline"
          size="xs"
          leftIcon={Sparkles}
          onPress={handleAskAi}
          testID="argocd-resource-ask-ai"
        >
          Ask AI
        </Button>
        {canOpenInClusters && item.node ? (
          <Button
            variant="outline"
            size="xs"
            leftIcon={Boxes}
            onPress={handleOpenInClusters}
            testID="argocd-open-in-clusters"
          >
            Open in Clusters
          </Button>
        ) : null}
      </View>
      <SegmentedControl
        options={tabs}
        value={activeTab}
        onValueChange={setTab}
        size="xs"
        testID="argocd-resource-tabs"
      />
      <View style={styles.body}>
        {activeTab === "summary" ? <SummaryTab item={item} /> : null}
        {activeTab === "manifest" ? (
          <ManifestTab scope={scope} resource={resource} exists={item.node !== null} />
        ) : null}
        {activeTab === "diff" ? <DiffTab scope={scope} item={item} /> : null}
        {activeTab === "events" ? <EventsTab scope={scope} item={item} /> : null}
        {activeTab === "logs" ? (
          <ArgoCdResourceLogs serverId={serverId} instanceId={instanceId} app={app} item={item} />
        ) : null}
      </View>
      {pickedAction ? (
        <ArgoCdResourceActionSheet
          serverId={serverId}
          instanceId={instanceId}
          app={app}
          resource={resource}
          action={pickedAction}
          onClose={handleCloseAction}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerText: {
    flex: 1,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  iconButton: {
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.base,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  fill: {
    flex: 1,
    minHeight: 0,
    gap: theme.spacing[2],
  },
  tabContent: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[4],
  },
  loadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  mutedText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[300],
  },
  summaryRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  summaryLabel: {
    width: 120,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  summaryValue: {
    flex: 1,
    minWidth: 0,
  },
  summaryText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  codeScroll: {
    flex: 1,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  codeInner: {
    padding: theme.spacing[2],
  },
  code: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
  },
  event: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  eventHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  eventWarning: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusWarning,
  },
  eventNormal: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  eventReason: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
