import { useCallback, useMemo, useRef, type ReactElement } from "react";
import { Modal, PanResponder, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { ChartNetwork } from "lucide-react-native";
import type { ActivityGraphNodeRef } from "@jagentdesk/protocol/agent-activity-graph";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { ActivityGraphPanel } from "./activity-graph-panel";
import {
  ACTIVITY_PANEL_MIN_WIDTH,
  activityGraphAgentKey,
  clampPanelFraction,
  useActivityGraphPanelStore,
} from "./activity-graph-store";

// Where the activity graph lives in the chat screen (spec 31.4): a header toggle, a resizable
// right-hand panel on desktop, and a full-screen sheet on phones.

export function useActivityGraphOpen(serverId: string, agentId: string) {
  const key = activityGraphAgentKey(serverId, agentId);
  const open = useActivityGraphPanelStore((state) => state.openByAgent[key] === true);
  const setOpen = useActivityGraphPanelStore((state) => state.setOpen);
  const supported = useHostFeature(serverId, "activityGraph");
  const setGraphOpen = useCallback((next: boolean) => setOpen(key, next), [key, setOpen]);
  return { open: supported && open, supported, setOpen: setGraphOpen };
}

export function ActivityGraphToggle({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const { open, supported, setOpen } = useActivityGraphOpen(serverId, agentId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const onPress = useCallback(() => setOpen(!open), [open, setOpen]);
  if (!supported) return null;
  return (
    <AgentControlTrigger
      icon={ChartNetwork}
      iconColor={open ? styles.iconOn.color : undefined}
      surface="toolbar"
      label={t("activityGraph.toggle")}
      showToolbarLabel={false}
      open={open}
      disabled={!isConnected}
      onPress={onPress}
      accessibilityLabel={t("activityGraph.toggle")}
      testID="activity-graph-toggle"
    />
  );
}

interface HostProps {
  serverId: string;
  agentId: string;
  onSelectNode: (nodeId: string, ref: ActivityGraphNodeRef) => void;
}

export function ActivityGraphSidePanel({
  serverId,
  agentId,
  containerWidth,
  onSelectNode,
}: HostProps & { containerWidth: number }): ReactElement {
  const { t } = useTranslation();
  const { setOpen } = useActivityGraphOpen(serverId, agentId);
  const fraction = useActivityGraphPanelStore((state) => state.widthFraction);
  const setWidthFraction = useActivityGraphPanelStore((state) => state.setWidthFraction);
  const width = Math.max(ACTIVITY_PANEL_MIN_WIDTH, Math.round(containerWidth * fraction));
  const dragStartRef = useRef(width);
  const containerWidthRef = useRef(containerWidth);
  containerWidthRef.current = containerWidth;
  const widthRef = useRef(width);
  widthRef.current = width;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          dragStartRef.current = widthRef.current;
        },
        onPanResponderMove: (_event, gesture) => {
          const total = containerWidthRef.current;
          if (total <= 0) return;
          const next = Math.max(ACTIVITY_PANEL_MIN_WIDTH, dragStartRef.current - gesture.dx);
          setWidthFraction(clampPanelFraction(next / total));
        },
      }),
    [setWidthFraction],
  );
  const panelStyle = useMemo(() => [styles.sidePanel, { width }], [width]);
  const onClose = useCallback(() => setOpen(false), [setOpen]);

  return (
    <View style={panelStyle} testID="activity-graph-side-panel">
      <View
        {...responder.panHandlers}
        style={styles.resizeHandle}
        accessibilityRole="adjustable"
        accessibilityLabel={t("activityGraph.resize")}
        testID="activity-graph-resize"
      >
        <View style={styles.resizeGrip} />
      </View>
      <ActivityGraphPanel
        serverId={serverId}
        agentId={agentId}
        onClose={onClose}
        onSelectNode={onSelectNode}
        testID="activity-graph-panel"
      />
    </View>
  );
}

export function ActivityGraphSheet({ serverId, agentId, onSelectNode }: HostProps): ReactElement {
  const { open, setOpen } = useActivityGraphOpen(serverId, agentId);
  const insets = useSafeAreaInsets();
  const onClose = useCallback(() => setOpen(false), [setOpen]);
  // Spec 31.4: on a phone a node tap closes the sheet, then the timeline scrolls to the row.
  const handleSelect = useCallback(
    (nodeId: string, ref: ActivityGraphNodeRef) => {
      setOpen(false);
      onSelectNode(nodeId, ref);
    },
    [onSelectNode, setOpen],
  );
  const sheetStyle = useMemo(
    () => [styles.sheet, { paddingTop: insets.top, paddingBottom: insets.bottom }],
    [insets.bottom, insets.top],
  );
  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      testID="activity-graph-sheet"
    >
      <View style={sheetStyle}>
        {open ? (
          <ActivityGraphPanel
            serverId={serverId}
            agentId={agentId}
            onClose={onClose}
            onSelectNode={handleSelect}
            testID="activity-graph-panel"
          />
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconOn: {
    color: theme.colors.accentBright,
  },
  sidePanel: {
    flexDirection: "row",
    minWidth: ACTIVITY_PANEL_MIN_WIDTH,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  resizeHandle: {
    width: 6,
    marginLeft: -3,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  resizeGrip: {
    width: 2,
    height: 32,
    borderRadius: 1,
    backgroundColor: theme.colors.borderAccent,
  },
  sheet: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
