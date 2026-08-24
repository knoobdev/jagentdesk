import { useCallback, useEffect, useMemo, useRef } from "react";
import { Pressable, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Gesture } from "react-native-gesture-handler";
import { MessageSquare, X } from "lucide-react-native";
import { AgentConversationPanel } from "@/panels/agent-panel";
import {
  PaneProvider,
  PaneFocusProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import { ClusterComposer, type ClusterComposerResource } from "@/components/cluster-composer";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  useClusterChatStore,
  CLUSTER_CHAT_MIN_WIDTH,
  CLUSTER_CHAT_MAX_WIDTH,
} from "@/stores/cluster-chat-store";
import type { Theme } from "@/styles/theme";

const ThemedX = withUnistyles(X);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const noop = () => {};

/**
 * The chat surface for the cluster view — the ONLY place chat lives. It is a
 * right sidebar: collapsed to a slim handle by default, expanding into a panel
 * that holds either the entry composer (type your first question) or the real
 * agent conversation + composer once a chat exists. The k8s content stays on the
 * left the whole time; opening/closing never leaves the cluster route. Whatever
 * the user is viewing (`resource`) rides along as context on the first message.
 */
export function ClusterChatDock({
  serverId,
  clusterId,
  clusterName,
  resource,
}: {
  serverId: string;
  clusterId: string;
  clusterName: string;
  resource?: ClusterComposerResource;
}) {
  const open = useClusterChatStore((s) => s.open);
  const agentId = useClusterChatStore((s) => s.agentId);
  const workspaceId = useClusterChatStore((s) => s.workspaceId);
  const width = useClusterChatStore((s) => s.width);
  const hideChat = useClusterChatStore((s) => s.hideChat);
  const showChat = useClusterChatStore((s) => s.showChat);
  const setWidth = useClusterChatStore((s) => s.setWidth);

  const isCompact = useIsCompactFormFactor();
  const { width: screenWidth } = useWindowDimensions();
  const target = isCompact ? screenWidth : width;

  const w = useSharedValue(open ? target : 0);
  const prevOpen = useRef(open);
  useEffect(() => {
    // Animate only when the open state toggles; snap on width/rotation changes.
    const toggled = prevOpen.current !== open;
    prevOpen.current = open;
    const to = open ? target : 0;
    w.value = toggled ? withTiming(to, { duration: 220 }) : to;
  }, [open, target, w]);
  const animStyle = useAnimatedStyle(() => ({ width: w.value }));

  const startWidthRef = useRef(width);
  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .onStart(() => {
          startWidthRef.current = width;
        })
        .onUpdate((event) => {
          // Dragging the left edge left (negative translationX) widens the dock.
          const next = Math.max(
            CLUSTER_CHAT_MIN_WIDTH,
            Math.min(CLUSTER_CHAT_MAX_WIDTH, startWidthRef.current - event.translationX),
          );
          w.value = next;
          runOnJS(setWidth)(next);
        }),
    [width, setWidth, w],
  );

  const handleClose = useCallback(() => hideChat(), [hideChat]);
  const handleOpen = useCallback(() => showChat(), [showChat]);
  const innerStyle = useMemo(() => [styles.inner, { width: target }], [target]);

  // AgentConversationPanel + Composer read their target/serverId/workspace from
  // the pane context, so provide a synthetic one scoped to the dock's agent.
  const paneValue = useMemo<PaneContextValue>(
    () => ({
      serverId,
      workspaceId: workspaceId ?? "",
      tabId: `cluster-chat-${agentId ?? "none"}`,
      target: { kind: "agent", agentId: agentId ?? "" },
      openTab: noop,
      closeCurrentTab: hideChat,
      retargetCurrentTab: noop,
      openFileInWorkspace: noop,
      openImportSheet: noop,
    }),
    [serverId, workspaceId, agentId, hideChat],
  );
  const focusValue = useMemo(
    () => createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: true }),
    [],
  );

  if (!open) {
    return (
      <Pressable style={styles.handle} onPress={handleOpen} accessibilityLabel="Open chat">
        <ThemedMessageSquare size={18} uniProps={mutedColor} />
      </Pressable>
    );
  }

  return (
    <Animated.View style={[styles.dock, animStyle]}>
      {isCompact ? null : (
        <SidebarResizeHandle edge="left" gesture={resizeGesture} testID="cluster-chat-resize" />
      )}
      <View style={innerStyle}>
        <View style={styles.header}>
          <ThemedMessageSquare size={15} uniProps={mutedColor} />
          <Text style={styles.headerTitle} numberOfLines={1}>
            {agentId ? clusterName : `Ask about ${clusterName}`}
          </Text>
          <Pressable
            style={styles.closeBtn}
            onPress={handleClose}
            accessibilityLabel="Collapse chat"
            hitSlop={8}
          >
            <ThemedX size={16} uniProps={mutedColor} />
          </Pressable>
        </View>
        <View style={styles.body}>
          {agentId ? (
            <PaneProvider value={paneValue}>
              <PaneFocusProvider value={focusValue}>
                <AgentConversationPanel />
              </PaneFocusProvider>
            </PaneProvider>
          ) : (
            <View style={styles.entry}>
              <View style={styles.entrySpacer} />
              <ClusterComposer
                serverId={serverId}
                clusterId={clusterId}
                clusterName={clusterName}
                resource={resource}
              />
            </View>
          )}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  handle: {
    width: 48,
    height: "100%",
    alignItems: "center",
    paddingTop: theme.spacing[3],
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  dock: {
    height: "100%",
    overflow: "hidden",
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  inner: {
    flex: 1,
    minHeight: 0,
    height: "100%",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  closeBtn: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  entry: {
    flex: 1,
    minHeight: 0,
  },
  entrySpacer: {
    flex: 1,
  },
}));
