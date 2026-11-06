import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { PanelRightClose, PanelRightOpen, Sparkles } from "lucide-react-native";
import type { FigmaNode, FigmaComponentMeta } from "@jagentdesk/protocol/figma/rpc-schemas";
import { useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { useHostFeature } from "@/runtime/host-features";
import { useIsCompactFormFactor } from "@/constants/layout";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { EmptyState, ErrorBanner, Tabs } from "@/jira/ui/primitives";
import { jiraStyles } from "@/jira/ui/styles";
import type { ApplyFigmaEdits, FigmaFileRef, FigmaSelection } from "../contracts";
import { CommentsPanel } from "@/figma/comments/comments-panel";
import { PrototypePlayer } from "@/figma/prototype/prototype-player";
import { VersionsPanel } from "@/figma/versions/versions-panel";
import { CanvasView, findNodeInStore } from "./canvas-view";
import { EditToolbar } from "./edit-toolbar";
import { FigmaAssistantPanel } from "./assistant-panel";
import { InspectPanel } from "./inspect-panel";
import { FigmaTopBar } from "./top-bar";
import { figmaNodeIdFromParam, figmaNodeParam, nodeParamToFocusId } from "./node-url";
import { errorMessage, useFigmaCall } from "./api";
import { absoluteBoundingBoxOf, type Camera, centerCameraOn, nodeFocusBounds } from "./viewport";
import {
  figmaKeys,
  invalidateFigmaFile,
  useFigmaEdits,
  useFigmaFrameStore,
  useFigmaOutline,
  useFigmaWatch,
} from "./use-figma-file";
import type { FigmaAssistantContext } from "./assistant-context";

// The file screen (spec 32.5): top bar + toolbar + canvas + the right-hand panel column. Owned
// state here is screen state only — camera, page, selection (mirrored to the route's `node`
// param so a selection is linkable), and which panel/sheet is open. Everything data-shaped comes
// from the hooks in ./use-figma-file; live updates reload through watch → invalidate.

type PanelTab = "inspect" | "comments" | "versions";

const PANEL_TABS = [
  { id: "inspect", label: "Inspect" },
  { id: "comments", label: "Comments" },
  { id: "versions", label: "Versions" },
] as const;

const ASSISTANT_SNAP_POINTS = ["90%"];

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  side: { flex: 1, minWidth: 0 },
  overlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: "#ffffff",
  },
  emptyOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  sideCard: { width: 360, borderRadius: 0 },
  iconRail: {
    position: "absolute",
    right: 8,
    top: 8,
    zIndex: 5,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#e4e4e7",
    backgroundColor: "#ffffff",
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  canvasError: { position: "absolute", left: 12, right: 12, top: 8, zIndex: 6 },
});

function panelTitle(tab: PanelTab): string {
  if (tab === "comments") return "Comments";
  if (tab === "versions") return "Versions";
  return "Inspect";
}

function initialNodeId(param: string | string[] | undefined): string | null {
  return figmaNodeIdFromParam(Array.isArray(param) ? param[0] : param);
}

// eslint-disable-next-line complexity
export function FigmaFileScreen({ serverId, fileKey, version }: FigmaFileRef) {
  const enabled = useHostFeature(serverId, "figma");
  const isCompact = useIsCompactFormFactor();
  const params = useLocalSearchParams<{ node?: string | string[] }>();
  const queryClient = useQueryClient();

  const outlineQuery = useFigmaOutline(serverId, fileKey, version ?? null);
  const outline = outlineQuery.data ?? null;
  const edits = useFigmaEdits(serverId, fileKey);

  const [watchToken, setWatchToken] = useState(0);
  const store = useFigmaFrameStore(serverId, fileKey, version ?? null, watchToken);

  const [pageId, setPageId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() =>
    initialNodeId(params.node),
  );
  const [camera, setCamera] = useState<Camera>({ zoom: 1, offsetX: 0, offsetY: 0 });
  // Screen size of the canvas area only — Fit / 100% / centring must never measure the body
  // (the side panel and the compact icon column used to be counted and the fit overshot).
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [panel, setPanel] = useState<PanelTab>("inspect");
  const [panelOpen, setPanelOpen] = useState(!isCompact);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [prototypeOpen, setPrototypeOpen] = useState(false);
  const [storeTick, setStoreTick] = useState(0);
  const [focusError, setFocusError] = useState<string | null>(null);
  const skipUrlFocus = useRef<string | null>(null);
  const autoFocusedFor = useRef<string | null>(null);
  const call = useFigmaCall(serverId);
  const dismissFocusError = useCallback(() => setFocusError(null), []);
  const focusErrorAction = useMemo(
    () => (
      <Pressable onPress={dismissFocusError} accessibilityRole="button" hitSlop={6}>
        <Text style={jiraStyles.textSmall}>Dismiss</Text>
      </Pressable>
    ),
    [dismissFocusError],
  );

  const page = useMemo(() => {
    if (!outline) return null;
    return outline.pages.find((candidate) => candidate.id === pageId) ?? outline.pages[0] ?? null;
  }, [outline, pageId]);

  const onWatched = useCallback(() => {
    invalidateFigmaFile(serverId, fileKey);
    void queryClient.invalidateQueries({ queryKey: figmaKeys.all(serverId, fileKey) });
    setWatchToken((token) => token + 1);
  }, [serverId, fileKey, queryClient]);

  useFigmaWatch({ serverId, fileKey, active: enabled && !version, onChanged: onWatched });

  const selectNode = useCallback((nodeId: string | null) => {
    setSelectedNodeId(nodeId);
    // A canvas-originated selection must not re-center the camera when the URL param echoes
    // it. The skip is stored in the DECODED form — the same form the focus effect compares —
    // so the echo actually matches.
    skipUrlFocus.current = nodeId;
    void router.setParams({ node: figmaNodeParam(nodeId) ?? "" });
  }, []);

  // Loaded subtrees arrive through store listeners, not new store references — without the
  // tick the memo below would never see a frame land and nested layers would inspect as null.
  const bumpStore = useCallback(() => setStoreTick((value) => value + 1), []);
  useEffect(() => (store ? store.subscribe(bumpStore) : undefined), [store, bumpStore]);

  // The selected node's latest data: from the lazy store (raw REST shape), not a summary.
  const selectedNode: FigmaNode | null = useMemo(() => {
    if (!store || !selectedNodeId) return null;
    return findNodeInStore(store, selectedNodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, selectedNodeId, storeTick]);

  const componentMeta = useCallback(
    (componentId: string) => store?.componentMeta(componentId),
    [store],
  );

  const parentOf = useCallback((nodeId: string) => store?.parentOf(nodeId), [store]);

  const focusNode = useCallback(
    async (nodeId: string) => {
      setFocusError(null);
      selectNode(nodeId);
      if (!page || size.width === 0) return;
      let bounds = nodeFocusBounds(store, page, nodeId);
      if (!bounds) {
        // Unknown layer (deep link / comment to a nested node): ask the daemon for the node
        // itself (one Tier-1 call, cached per version), then queue its subtree so the canvas,
        // the selection box and the inspector all see it once it arrives.
        try {
          const data = await call("figma.file.nodes.request", {
            fileKey,
            ids: [nodeId],
            ...(version ? { version } : {}),
          });
          bounds = absoluteBoundingBoxOf(data.nodes?.[nodeId]);
        } catch (cause) {
          setFocusError(`Could not focus layer ${nodeId}: ${errorMessage(cause)}`);
          return;
        }
        if (!bounds) {
          setFocusError(`Layer ${nodeId} was not found in this page.`);
          return;
        }
        void store?.load([nodeId]);
      }
      const target = bounds;
      setCamera((current) => centerCameraOn(current, target, size.width, size.height));
    },
    [call, fileKey, page, selectNode, size.height, size.width, store, version],
  );

  // Comment pins with only an x/y offset (no node): pan the camera to the point itself.
  const focusPoint = useCallback(
    (point: { x: number; y: number }) => {
      if (size.width === 0) return;
      setCamera((current) =>
        centerCameraOn(
          current,
          { x: point.x, y: point.y, width: 0, height: 0 },
          size.width,
          size.height,
        ),
      );
    },
    [size.height, size.width],
  );

  // The URL's `node` param drives focus: a deep link or a comment-panel URL write selects and
  // zooms to the layer, nested layers included (F5 owns the comment side of this contract).
  // Canvas clicks write the same param; `nodeParamToFocusId` keeps that echo from moving the
  // camera (skip/auto-focus guards are both held in the decoded node-id form).
  const nodeParam = Array.isArray(params.node) ? params.node[0] : params.node;
  useEffect(() => {
    const nodeId = nodeParamToFocusId(nodeParam, skipUrlFocus.current, autoFocusedFor.current);
    if (!nodeId) {
      if (!figmaNodeIdFromParam(nodeParam ?? null)) autoFocusedFor.current = null;
      return;
    }
    if (!page || size.width === 0) return;
    autoFocusedFor.current = nodeId;
    void focusNode(nodeId);
  }, [nodeParam, page, size.width, focusNode]);

  const onLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
    },
    [],
  );

  const selectPage = useCallback(
    (next: string) => {
      setPageId(next);
      autoFocusedFor.current = null;
      selectNode(null);
    },
    [selectNode],
  );
  const openPrototype = useCallback(() => setPrototypeOpen(true), []);
  const closePrototype = useCallback(() => setPrototypeOpen(false), []);
  const toggleAssistant = useCallback(() => setAssistantOpen((open) => !open), []);
  const openAssistant = useCallback(() => setAssistantOpen(true), []);
  const closeAssistant = useCallback(() => setAssistantOpen(false), []);
  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  // Return the queue RPC promises so the toolbar can surface real failures; do NOT void here.
  const applyPending = useCallback(() => edits.applyPending(), [edits]);
  const discardPending = useCallback(() => edits.discardPending(), [edits]);

  const assistantContext = useMemo<FigmaAssistantContext>(
    () => ({
      serverId,
      fileKey,
      fileName: outline?.name ?? "",
      pageId: page?.id ?? null,
      nodeId: selectedNodeId,
    }),
    [serverId, fileKey, outline?.name, page?.id, selectedNodeId],
  );

  const fileRef = useMemo(() => ({ serverId, fileKey, version }), [serverId, fileKey, version]);
  const plainFileRef = useMemo(() => ({ serverId, fileKey }), [serverId, fileKey]);
  const selection = useMemo<FigmaSelection | null>(
    () => (page ? { pageId: page.id, nodeId: selectedNodeId } : null),
    [page, selectedNodeId],
  );
  const panelHeader = useMemo(() => ({ title: panelTitle(panel) }), [panel]);

  if (!enabled) {
    return (
      <View style={jiraStyles.screen}>
        <ErrorBanner message="This host does not speak Figma yet — update the app running the daemon." />
      </View>
    );
  }

  if (outlineQuery.isPending) {
    return (
      <View style={[jiraStyles.screen, styles.center]}>
        <LoadingSpinner size="large" color="#71717a" />
      </View>
    );
  }

  if (outlineQuery.isError || !outline) {
    return (
      <View style={jiraStyles.screen}>
        <ErrorBanner message={outlineQuery.error?.message ?? "The file could not be loaded."} />
      </View>
    );
  }

  const sidePanel = assistantOpen ? (
    <AssistantColumn context={assistantContext} isCompact={isCompact} onClose={closeAssistant} />
  ) : (
    <PanelColumn
      serverId={serverId}
      fileKey={fileKey}
      file={fileRef}
      plainFile={plainFileRef}
      panel={panel}
      onPanelChange={setPanel}
      selectedNode={selectedNode}
      linked={edits.linked}
      applyEdits={edits.applyEdits}
      selection={selection}
      onFocusNode={focusNode}
      onFocusPoint={focusPoint}
      componentMeta={componentMeta}
      parentOf={parentOf}
    />
  );

  return (
    <View style={jiraStyles.screen} testID="figma-file-screen">
      <FigmaTopBar
        fileKey={fileKey}
        outline={outline}
        version={version ?? null}
        page={page}
        selectedNodeId={selectedNodeId}
        camera={camera}
        size={size}
        compact={isCompact}
        onCamera={setCamera}
        onSelectPage={selectPage}
        onOpenPrototype={openPrototype}
        onAskAi={toggleAssistant}
      />
      <EditToolbar
        page={page}
        selection={selection}
        node={selectedNode}
        camera={camera}
        size={size}
        applyEdits={edits.applyEdits}
        linked={edits.linked}
        pendingCount={edits.pendingCount}
        onApplyPending={applyPending}
        onDiscardPending={discardPending}
        disabled={Boolean(version)}
      />
      <View style={jiraStyles.body}>
        <View style={jiraStyles.main} onLayout={onLayout}>
          <CanvasView
            serverId={serverId}
            fileKey={fileKey}
            version={version ?? null}
            page={page}
            store={store}
            camera={camera}
            onCamera={setCamera}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            overrides={version ? HISTORY_NO_OVERRIDES : edits.overrides}
          />
          {focusError ? (
            <View style={styles.canvasError} testID="figma-focus-error">
              <ErrorBanner message={focusError} action={focusErrorAction} />
            </View>
          ) : null}
          {isCompact ? (
            // Phones: the canvas owns the full width — the inspector / Ask AI icons float over
            // it instead of taking a column beside it (which used to shrink the measured size).
            <View style={[styles.iconRail, jiraStyles.row]}>
              <Pressable
                style={jiraStyles.iconButton}
                onPress={openPanel}
                accessibilityLabel="Open inspector"
                hitSlop={6}
                testID="figma-compact-panel"
              >
                <PanelRightClose size={16} color="#71717a" />
              </Pressable>
              <Pressable
                style={jiraStyles.iconButton}
                onPress={openAssistant}
                accessibilityLabel="Ask AI"
                hitSlop={6}
                testID="figma-compact-assistant"
              >
                <Sparkles size={16} color="#71717a" />
              </Pressable>
            </View>
          ) : null}
          {prototypeOpen ? (
            <View style={styles.overlay}>
              <PrototypePlayer
                file={fileRef}
                outline={outline}
                startNodeId={selectedNodeId ?? page?.flowStartingPoints[0]?.nodeId ?? null}
                onClose={closePrototype}
              />
            </View>
          ) : null}
        </View>
        {!isCompact && panelOpen ? (
          <View style={[jiraStyles.card, styles.sideCard]}>{sidePanel}</View>
        ) : null}
        {!isCompact && !panelOpen ? (
          <Pressable
            style={jiraStyles.iconButton}
            onPress={openPanel}
            accessibilityLabel="Open panel"
            hitSlop={6}
            testID="figma-panel-open"
          >
            <PanelRightOpen size={16} color="#71717a" />
          </Pressable>
        ) : null}
      </View>
      {isCompact ? (
        <AdaptiveModalSheet visible={panelOpen} onClose={closePanel} header={panelHeader}>
          {sidePanel}
        </AdaptiveModalSheet>
      ) : null}
      {isCompact && assistantOpen ? (
        <AdaptiveModalSheet
          visible
          onClose={closeAssistant}
          header={ASSISTANT_HEADER}
          snapPoints={ASSISTANT_SNAP_POINTS}
        >
          <AssistantColumn context={assistantContext} isCompact onClose={closeAssistant} />
        </AdaptiveModalSheet>
      ) : null}
      {page && page.frames.length === 0 ? (
        <View style={styles.emptyOverlay}>
          <EmptyState title="This page has no frames" body="Create one from the toolbar." />
        </View>
      ) : null}
    </View>
  );
}

const ASSISTANT_HEADER = { title: "Figma assistant" };
const PANEL_HEADER_TABS = PANEL_TABS.map((tab) => ({ id: tab.id, label: tab.label }));
const VERSIONS_OPEN_HANDLER = () => undefined;
// A historical snapshot (32.5.4) is read-only: current queued edits preview over the *latest*
// file, so they must not bleed into the snapshot the canvas renders for an old version.
const HISTORY_NO_OVERRIDES: Record<string, Partial<FigmaNode>> = {};

function AssistantColumn({
  context,
  isCompact,
  onClose,
}: {
  context: FigmaAssistantContext;
  isCompact: boolean;
  onClose: () => void;
}) {
  return (
    <FigmaAssistantPanel
      serverId={context.serverId}
      context={context}
      isCompact={isCompact}
      onClose={onClose}
    />
  );
}

function PanelColumn({
  serverId,
  fileKey,
  file,
  plainFile,
  panel,
  onPanelChange,
  selectedNode,
  linked,
  applyEdits,
  selection,
  onFocusNode,
  onFocusPoint,
  componentMeta,
  parentOf,
}: {
  serverId: string;
  fileKey: string;
  file: FigmaFileRef;
  plainFile: FigmaFileRef;
  panel: PanelTab;
  onPanelChange: (tab: PanelTab) => void;
  selectedNode: FigmaNode | null;
  linked: boolean;
  applyEdits: ApplyFigmaEdits;
  selection: FigmaSelection | null;
  onFocusNode: (nodeId: string) => void;
  onFocusPoint: (point: { x: number; y: number }) => void;
  componentMeta?: (componentId: string) => FigmaComponentMeta | undefined;
  parentOf?: (nodeId: string) => FigmaNode | null | undefined;
}) {
  return (
    <View style={styles.side}>
      <Tabs
        tabs={PANEL_HEADER_TABS}
        value={panel}
        onChange={onPanelChange}
        testIDPrefix="figma-panel"
      />
      {panel === "inspect" ? (
        <InspectPanel
          serverId={serverId}
          fileKey={fileKey}
          node={selectedNode}
          linked={linked}
          applyEdits={applyEdits}
          disabled={Boolean(file.version)}
          componentMeta={componentMeta}
          parentOf={parentOf}
        />
      ) : null}
      {panel === "comments" && selection ? (
        <CommentsPanel
          file={file}
          selection={selection}
          onFocusNode={onFocusNode}
          onFocusPoint={onFocusPoint}
        />
      ) : null}
      {panel === "versions" ? (
        <VersionsPanel file={plainFile} onOpenVersion={VERSIONS_OPEN_HANDLER} />
      ) : null}
    </View>
  );
}
