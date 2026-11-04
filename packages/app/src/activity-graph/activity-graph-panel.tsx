import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown, Maximize, X } from "lucide-react-native";
import type {
  ActivityGraphNodeRef,
  ActivityGraphNodeStatus,
  ActivityGraphNodeStatusEntry,
  ActivityGraphTurnSummary,
  ActivityGraphView,
} from "@jagentdesk/protocol/agent-activity-graph";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import {
  ACTIVITY_STATUS_COLORS,
  buildActivityGraphDocument,
  type ActivityGraphPalette,
} from "./activity-graph-document";
import { ActivityGraphFrame } from "./activity-graph-frame";
import type { ActivityGraphFrameHandle } from "./activity-graph-frame-types";
import { activityGraphAgentKey, useActivityGraphPanelStore } from "./activity-graph-store";
import {
  useActivityGraph,
  type ActivityGraphGraph,
  type ActivityGraphLoadState,
} from "./use-activity-graph";

// Activity graph body shared by the desktop side panel and the mobile sheet (spec 31.4): Flow/Plan,
// turn picker (live turn by default, 10 most recent), Fit, the sandboxed archify canvas, and a
// status legend in the design-system colors (docs/reference/paseo-design-system.md §1.4).

export interface ActivityGraphPanelProps {
  serverId: string;
  agentId: string;
  onClose: () => void;
  onSelectNode: (nodeId: string, ref: ActivityGraphNodeRef) => void;
  testID?: string;
}

interface ThemeProps {
  palette: ActivityGraphPalette;
  colorScheme: "light" | "dark";
  iconColor: string;
  mutedIconColor: string;
}

const LEGEND: Array<{ status: ActivityGraphNodeStatus; labelKey: string }> = [
  { status: "running", labelKey: "activityGraph.legend.running" },
  { status: "waiting", labelKey: "activityGraph.legend.waiting" },
  { status: "done", labelKey: "activityGraph.legend.done" },
  { status: "failed", labelKey: "activityGraph.legend.failed" },
  { status: "pending", labelKey: "activityGraph.legend.pending" },
];

// Main-path steps the camera follows when nothing is selected.
const FOLLOWED_KINDS = new Set(["tools", "compaction", "error", "end", "todo"]);

function focusNode(
  graph: ActivityGraphGraph,
  statuses: ReadonlyMap<string, ActivityGraphNodeStatus>,
  selected: string | null,
): string | null {
  if (selected && graph.nodeIndex[selected]) return selected;
  const ids = Object.keys(graph.nodeIndex);
  const kind = (id: string) => graph.nodeIndex[id]?.kind ?? "";
  const running = ids.find((id) => statuses.get(id) === "running" && FOLLOWED_KINDS.has(kind(id)));
  if (running) return running;
  const waiting = ids.find((id) => statuses.get(id) === "waiting");
  if (waiting) return waiting;
  return graph.nodeIndex.end ? "end" : null;
}

function newestFirst(turns: readonly ActivityGraphTurnSummary[]): ActivityGraphTurnSummary[] {
  const out: ActivityGraphTurnSummary[] = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) out.push(turns[index]!);
  return out;
}

function TurnMenuItem({
  turn,
  latest,
  selected,
  onSelect,
}: {
  turn: ActivityGraphTurnSummary;
  latest: boolean;
  selected: boolean;
  onSelect: (turnIndex: number | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(
    () => onSelect(latest ? null : turn.turnIndex),
    [latest, onSelect, turn.turnIndex],
  );
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      description={turn.label}
      onSelect={handleSelect}
      testID={`activity-graph-turn-${turn.turnIndex}`}
    >
      {latest
        ? t("activityGraph.turnCurrent")
        : t("activityGraph.turnNumber", { number: turn.turnIndex + 1 })}
    </DropdownMenuItem>
  );
}

function TurnMenu({
  turns,
  turnIndex,
  graphTurnIndex,
  mutedIconColor,
  onSelect,
}: {
  turns: readonly ActivityGraphTurnSummary[];
  turnIndex: number | null;
  graphTurnIndex: number | null;
  mutedIconColor: string;
  onSelect: (turnIndex: number | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const latestTurn = turns.at(-1)?.turnIndex ?? null;
  const shownTurn = turnIndex ?? graphTurnIndex ?? latestTurn;
  const label =
    turnIndex === null || turnIndex === latestTurn
      ? t("activityGraph.turnCurrent")
      : t("activityGraph.turnNumber", { number: (shownTurn ?? 0) + 1 });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        style={styles.outlineControl}
        accessibilityRole="button"
        accessibilityLabel={t("activityGraph.turnPicker")}
        testID="activity-graph-turn"
      >
        <Text style={styles.controlText} numberOfLines={1}>
          {label}
        </Text>
        <ChevronDown size={14} color={mutedIconColor} />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" width={260}>
        {newestFirst(turns).map((turn) => (
          <TurnMenuItem
            key={turn.turnIndex}
            turn={turn}
            latest={turn.turnIndex === latestTurn}
            selected={turn.turnIndex === shownTurn}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ActivityGraphStateView({
  state,
  mutedIconColor,
  onRetry,
}: {
  state: Exclude<ActivityGraphLoadState, { kind: "ready" }> | { kind: "ready" };
  mutedIconColor: string;
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.state} testID={`activity-graph-state-${state.kind}`}>
      {state.kind === "loading" || state.kind === "ready" ? (
        <>
          <LoadingSpinner size="small" color={mutedIconColor} />
          <Text style={styles.stateText}>{t("activityGraph.loading")}</Text>
        </>
      ) : null}
      {state.kind === "empty" ? (
        <>
          <Text style={styles.stateTitle}>{t("activityGraph.empty")}</Text>
          <Text style={styles.stateText}>{t("activityGraph.emptyHint")}</Text>
        </>
      ) : null}
      {state.kind === "offline" ? (
        <Text style={styles.stateText}>{t("activityGraph.offline")}</Text>
      ) : null}
      {state.kind === "failed" ? (
        <>
          <Text style={styles.stateText}>{t("activityGraph.failed")}</Text>
          <Pressable onPress={onRetry} accessibilityRole="button">
            <Text style={styles.retry}>{t("activityGraph.retry")}</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const SWATCH_STYLE: Record<
  ActivityGraphNodeStatus,
  "swatchRunning" | "swatchWaiting" | "swatchDone" | "swatchFailed" | "swatchPending"
> = {
  running: "swatchRunning",
  waiting: "swatchWaiting",
  done: "swatchDone",
  failed: "swatchFailed",
  pending: "swatchPending",
};

function ActivityGraphLegend(): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.legend} testID="activity-graph-legend">
      {LEGEND.map((entry) => (
        <View key={entry.status} style={styles.legendItem}>
          <View style={styles[SWATCH_STYLE[entry.status]]} />
          <Text style={styles.legendText}>{t(entry.labelKey)}</Text>
        </View>
      ))}
    </View>
  );
}

function ActivityGraphPanelImpl({
  serverId,
  agentId,
  onClose,
  onSelectNode,
  testID,
  palette,
  colorScheme,
  iconColor,
  mutedIconColor,
}: ActivityGraphPanelProps & ThemeProps): ReactElement {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const key = activityGraphAgentKey(serverId, agentId);
  const view = useActivityGraphPanelStore((state) => state.viewByAgent[key] ?? "flow");
  const setView = useActivityGraphPanelStore((state) => state.setView);
  const [turnIndex, setTurnIndex] = useState<number | null>(null);
  const frameRef = useRef<ActivityGraphFrameHandle | null>(null);
  const statusesRef = useRef(new Map<string, ActivityGraphNodeStatus>());
  const selectedRef = useRef<string | null>(null);

  const onStatus = useCallback((nodes: ActivityGraphNodeStatusEntry[]) => {
    for (const entry of nodes) statusesRef.current.set(entry.id, entry.status);
    frameRef.current?.postStatus(nodes);
  }, []);
  const { state, retry } = useActivityGraph({
    client,
    agentId,
    view,
    turnIndex,
    enabled: true,
    onStatus,
  });
  const graph = state.kind === "ready" ? state.graph : null;

  // A new document only when archify re-rendered (or the theme changed); statuses never rebuild it.
  const document = useMemo(() => {
    if (!graph) return null;
    statusesRef.current = new Map(graph.nodes.map((entry) => [entry.id, entry.status]));
    return buildActivityGraphDocument({
      html: graph.html,
      colorScheme,
      palette,
      statuses: graph.nodes,
      focusNodeId: focusNode(graph, statusesRef.current, selectedRef.current),
      scale: null,
      // Spec 31.3 / review: every new render starts from the width-fit/readable camera.
      fit: false,
    });
  }, [graph, colorScheme, palette]);

  const handleSelect = useCallback(
    (nodeId: string) => {
      const ref = graph?.nodeIndex[nodeId];
      if (!ref) return;
      selectedRef.current = nodeId;
      onSelectNode(nodeId, ref);
    },
    [graph, onSelectNode],
  );
  const handleFit = useCallback(() => frameRef.current?.view("fit"), []);
  const handleView = useCallback(
    (next: ActivityGraphView) => {
      selectedRef.current = null;
      setView(key, next);
    },
    [key, setView],
  );
  const handleTurn = useCallback((next: number | null) => {
    selectedRef.current = null;
    setTurnIndex(next);
  }, []);
  const viewOptions = useMemo(
    () => [
      {
        value: "flow" as const,
        label: t("activityGraph.flow"),
        testID: "activity-graph-view-flow",
      },
      {
        value: "plan" as const,
        label: t("activityGraph.plan"),
        testID: "activity-graph-view-plan",
      },
    ],
    [t],
  );
  const showLive = graph?.live === true && turnIndex === null;

  return (
    <View style={styles.root} testID={testID}>
      <View style={styles.toolbar}>
        <View style={styles.titleRow}>
          <Text style={styles.title} numberOfLines={1}>
            {t("activityGraph.title")}
          </Text>
          {showLive ? (
            <View style={styles.livePill} testID="activity-graph-live">
              <View style={styles.liveDot} />
              <Text style={styles.liveText}>{t("activityGraph.live")}</Text>
            </View>
          ) : null}
          <View style={styles.spacer} />
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("activityGraph.close")}
            style={styles.iconButton}
            testID="activity-graph-close"
          >
            <X size={16} color={mutedIconColor} />
          </Pressable>
        </View>
        <View style={styles.controlsRow}>
          <SegmentedControl
            options={viewOptions}
            value={view}
            onValueChange={handleView}
            size="sm"
            testID="activity-graph-view"
          />
          <TurnMenu
            turns={graph?.turns ?? []}
            turnIndex={turnIndex}
            graphTurnIndex={graph?.turnIndex ?? null}
            mutedIconColor={mutedIconColor}
            onSelect={handleTurn}
          />
          <View style={styles.spacer} />
          <Pressable
            onPress={handleFit}
            disabled={!graph}
            accessibilityRole="button"
            accessibilityLabel={t("activityGraph.fit")}
            style={styles.outlineControl}
            testID="activity-graph-fit"
          >
            <Maximize size={14} color={iconColor} />
            <Text style={styles.controlText}>{t("activityGraph.fit")}</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.canvas}>
        {document && graph ? (
          <ActivityGraphFrame
            ref={frameRef}
            document={document}
            nodeIndex={graph.nodeIndex}
            onSelect={handleSelect}
            title={t("activityGraph.title")}
            testID="activity-graph-frame"
          />
        ) : (
          <ActivityGraphStateView state={state} mutedIconColor={mutedIconColor} onRetry={retry} />
        )}
      </View>
      <ActivityGraphLegend />
    </View>
  );
}

const ThemedActivityGraphPanel = withUnistyles(ActivityGraphPanelImpl);

const mapTheme = (theme: Theme): ThemeProps => ({
  palette: {
    surface0: theme.colors.surface0,
    surface1: theme.colors.surface1,
    surface2: theme.colors.surface2,
    foreground: theme.colors.foreground,
    foregroundMuted: theme.colors.foregroundMuted,
    foregroundExtraMuted: theme.colors.foregroundExtraMuted,
    border: theme.colors.border,
  },
  colorScheme: theme.colorScheme === "light" ? "light" : "dark",
  iconColor: theme.colors.foreground,
  mutedIconColor: theme.colors.foregroundMuted,
});

export function ActivityGraphPanel(props: ActivityGraphPanelProps): ReactElement {
  return <ThemedActivityGraphPanel {...props} uniProps={mapTheme} />;
}

const swatch = { width: 8, height: 8, borderRadius: 4 } as const;

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  toolbar: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  livePill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  liveDot: {
    ...swatch,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: ACTIVITY_STATUS_COLORS.running,
  },
  liveText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  spacer: {
    flex: 1,
  },
  iconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  controlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  outlineControl: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 180,
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
  },
  controlText: {
    flexShrink: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  canvas: {
    flex: 1,
    minHeight: 0,
  },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[6],
  },
  stateTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  stateText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  retry: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.accentBright,
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  swatchRunning: { ...swatch, backgroundColor: ACTIVITY_STATUS_COLORS.running },
  swatchWaiting: { ...swatch, backgroundColor: ACTIVITY_STATUS_COLORS.waiting },
  swatchDone: { ...swatch, backgroundColor: ACTIVITY_STATUS_COLORS.done },
  swatchFailed: { ...swatch, backgroundColor: ACTIVITY_STATUS_COLORS.failed },
  swatchPending: {
    ...swatch,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: theme.colors.foregroundMuted,
  },
  legendText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
