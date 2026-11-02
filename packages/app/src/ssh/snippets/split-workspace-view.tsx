import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
  type ViewStyle,
} from "react-native";
import { useTranslation } from "react-i18next";
import { Columns2, Radio, Rows2, Save, X } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { SSH_WORKSPACE_MAX_PANES } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  getPane,
  paneIds,
  type PaneNode,
  type SplitContainer,
  type SplitWorkspace,
} from "./split-layout";

export interface PaneRenderState {
  focused: boolean;
  broadcasting: boolean;
}

export interface SplitWorkspaceViewProps {
  workspace: SplitWorkspace;
  /** The owner renders the real terminal (or results pane) for each pane. */
  renderPane: (pane: PaneNode, state: PaneRenderState) => ReactNode;
  onFocusPane: (paneId: string) => void;
  onResize?: (splitId: string, sizes: number[]) => void;
  paneLabel: (pane: PaneNode) => string;
}

/**
 * Split view of up to 16 panes (spec 25.4). Desktop shows the whole tree with drag
 * handles; compact layouts show one pane at a time with a pane switcher. While
 * broadcasting, the main (focused) pane gets the bold frame.
 */
export function SplitWorkspaceView(props: SplitWorkspaceViewProps) {
  const isCompact = useIsCompactFormFactor();
  return (
    <View style={styles.root} testID="ssh-split-workspace">
      {props.workspace.broadcast ? <BroadcastBanner /> : null}
      {isCompact ? (
        <CompactWorkspace {...props} />
      ) : (
        <SplitNodeView {...props} nodeId={props.workspace.rootId} />
      )}
    </View>
  );
}

function BroadcastBanner() {
  const { t } = useTranslation();
  return (
    <View style={styles.banner} testID="ssh-broadcast-banner">
      <Text style={styles.bannerText}>{t("ssh.snippets.split.broadcastOn")}</Text>
    </View>
  );
}

function CompactWorkspace(props: SplitWorkspaceViewProps) {
  const { workspace } = props;
  const ids = paneIds(workspace);
  const focused = getPane(workspace, workspace.focusedPaneId);
  return (
    <View style={styles.root}>
      {ids.length > 1 ? (
        <ScrollView
          horizontal
          style={styles.switcher}
          contentContainerStyle={styles.switcherContent}
        >
          {ids.map((id) => (
            <PaneTab
              key={id}
              paneId={id}
              label={props.paneLabel(getPane(workspace, id))}
              active={id === workspace.focusedPaneId}
              onFocusPane={props.onFocusPane}
            />
          ))}
        </ScrollView>
      ) : null}
      <PaneFrame pane={focused} {...props} />
    </View>
  );
}

function PaneTab({
  paneId,
  label,
  active,
  onFocusPane,
}: {
  paneId: string;
  label: string;
  active: boolean;
  onFocusPane: (paneId: string) => void;
}) {
  const focus = useCallback(() => onFocusPane(paneId), [onFocusPane, paneId]);
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={focus}
      style={[styles.switcherTab, active ? styles.switcherTabActive : null]}
      accessibilityRole="tab"
      accessibilityState={accessibilityState}
      testID={`ssh-pane-tab-${paneId}`}
    >
      <Text style={styles.switcherText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function SplitNodeView(props: SplitWorkspaceViewProps & { nodeId: string }) {
  const node = props.workspace.nodes[props.nodeId]!;
  if (node.kind === "pane") return <PaneFrame pane={node} {...props} />;
  return <SplitContainerView {...props} split={node} />;
}

function SplitContainerView(props: SplitWorkspaceViewProps & { split: SplitContainer }) {
  const { split } = props;
  const [length, setLength] = useState(0);
  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { width, height } = event.nativeEvent.layout;
      setLength(split.direction === "row" ? width : height);
    },
    [split.direction],
  );
  return (
    <View
      style={[styles.split, split.direction === "row" ? styles.splitRow : styles.splitColumn]}
      onLayout={onLayout}
    >
      {split.children.map((childId, index) => (
        <SplitChild
          key={childId}
          {...props}
          childId={childId}
          index={index}
          containerLength={length}
        />
      ))}
    </View>
  );
}

function SplitChild(
  props: SplitWorkspaceViewProps & {
    split: SplitContainer;
    childId: string;
    index: number;
    containerLength: number;
  },
) {
  const { split, index } = props;
  const isLast = index === split.children.length - 1;
  return (
    <>
      <View style={[styles.splitChild, { flex: split.sizes[index] }]}>
        <SplitNodeView {...props} nodeId={props.childId} />
      </View>
      {!isLast && props.onResize ? (
        <SplitDivider
          split={split}
          index={index}
          containerLength={props.containerLength}
          onResize={props.onResize}
        />
      ) : null}
    </>
  );
}

function SplitDivider({
  split,
  index,
  containerLength,
  onResize,
}: {
  split: SplitContainer;
  index: number;
  containerLength: number;
  onResize: (splitId: string, sizes: number[]) => void;
}) {
  // The responder is a non-rendering identity; the latest props are read through refs.
  const latest = useRef({ split, containerLength, onResize });
  latest.current = { split, containerLength, onResize };
  const start = useRef<number[]>(split.sizes);
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          start.current = latest.current.split.sizes;
        },
        onPanResponderMove: (_event, gesture) => {
          const current = latest.current;
          if (current.containerLength <= 0) return;
          const moved = current.split.direction === "row" ? gesture.dx : gesture.dy;
          const delta = moved / current.containerLength;
          const sizes = [...start.current];
          const pairTotal = sizes[index]! + sizes[index + 1]!;
          const next = Math.min(Math.max(sizes[index]! + delta, 0.05), pairTotal - 0.05);
          sizes[index] = next;
          sizes[index + 1] = pairTotal - next;
          current.onResize(current.split.id, sizes);
        },
      }),
    [index],
  );
  return (
    <View
      {...responder.panHandlers}
      style={split.direction === "row" ? styles.dividerVertical : styles.dividerHorizontal}
      accessibilityRole="adjustable"
    />
  );
}

function PaneFrame(props: SplitWorkspaceViewProps & { pane: PaneNode }) {
  const { workspace, pane } = props;
  const focused = workspace.focusedPaneId === pane.id;
  const broadcasting = workspace.broadcast;
  let frame: ViewStyle = styles.paneIdle;
  if (focused && broadcasting) frame = styles.paneMain;
  else if (focused) frame = styles.paneFocused;
  const { onFocusPane } = props;
  const focus = useCallback(() => onFocusPane(pane.id), [onFocusPane, pane.id]);
  return (
    // A plain View with pointer-down focus keeps text selection and terminal input
    // inside the pane working (a Pressable would claim the gesture).
    <View style={[styles.pane, frame]} onPointerDown={focus} testID={`ssh-pane-${pane.id}`}>
      {props.renderPane(pane, { focused, broadcasting })}
    </View>
  );
}

export interface SplitWorkspaceToolbarProps {
  workspace: SplitWorkspace;
  onSplit: (direction: "row" | "column") => void;
  onClosePane: () => void;
  onToggleBroadcast: () => void;
  onSaveTemplate?: () => void;
}

/** Split right/down, close the focused pane, toggle broadcast, save as template. */
export function SplitWorkspaceToolbar({
  workspace,
  onSplit,
  onClosePane,
  onToggleBroadcast,
  onSaveTemplate,
}: SplitWorkspaceToolbarProps) {
  const { t } = useTranslation();
  const count = paneIds(workspace).length;
  const full = count >= SSH_WORKSPACE_MAX_PANES;
  const splitRight = useCallback(() => onSplit("row"), [onSplit]);
  const splitDown = useCallback(() => onSplit("column"), [onSplit]);
  const broadcastState = useMemo(() => ({ checked: workspace.broadcast }), [workspace.broadcast]);
  return (
    <View style={styles.toolbar} testID="ssh-split-toolbar">
      <Text style={styles.toolbarCount}>
        {t("ssh.snippets.split.paneCount", { count, max: SSH_WORKSPACE_MAX_PANES })}
      </Text>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Columns2}
        onPress={splitRight}
        disabled={full}
        testID="ssh-split-right"
      >
        {t("ssh.snippets.split.splitRight")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={Rows2}
        onPress={splitDown}
        disabled={full}
        testID="ssh-split-down"
      >
        {t("ssh.snippets.split.splitDown")}
      </Button>
      <Button
        size="sm"
        variant={workspace.broadcast ? "default" : "ghost"}
        leftIcon={Radio}
        onPress={onToggleBroadcast}
        accessibilityState={broadcastState}
        testID="ssh-split-broadcast"
      >
        {t("ssh.snippets.split.broadcast")}
      </Button>
      {onSaveTemplate ? (
        <Button size="sm" variant="ghost" leftIcon={Save} onPress={onSaveTemplate}>
          {t("ssh.snippets.split.saveTemplate")}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" leftIcon={X} onPress={onClosePane} testID="ssh-split-close">
        {t("ssh.snippets.split.closePane")}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
  },
  banner: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.statusWarning,
  },
  bannerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.palette.white,
  },
  split: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  splitRow: {
    flexDirection: "row",
  },
  splitColumn: {
    flexDirection: "column",
  },
  splitChild: {
    minHeight: 0,
    minWidth: 0,
  },
  dividerVertical: {
    width: theme.spacing[1],
    backgroundColor: theme.colors.border,
  },
  dividerHorizontal: {
    height: theme.spacing[1],
    backgroundColor: theme.colors.border,
  },
  pane: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    backgroundColor: theme.colors.terminal.background,
  },
  paneIdle: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  paneFocused: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
  },
  paneMain: {
    borderWidth: theme.borderWidth[2],
    borderColor: theme.colors.accent,
  },
  switcher: {
    flexGrow: 0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  switcherContent: {
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  switcherTab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    maxWidth: 200,
  },
  switcherTabActive: {
    backgroundColor: theme.colors.surface2,
  },
  switcherText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  toolbar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  toolbarCount: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginRight: theme.spacing[2],
  },
}));
