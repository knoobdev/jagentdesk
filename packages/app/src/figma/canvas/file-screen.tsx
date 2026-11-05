import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
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
import { figmaNodeIdFromParam, figmaNodeParam } from "./node-url";
import {
  figmaKeys,
  invalidateFigmaFile,
  useFigmaEdits,
  useFigmaFrameStore,
  useFigmaOutline,
  useFigmaWatch,
} from "./use-figma-file";
import { type Camera, centerCameraOn } from "./viewport";
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
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [panel, setPanel] = useState<PanelTab>("inspect");
  const [panelOpen, setPanelOpen] = useState(!isCompact);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [prototypeOpen, setPrototypeOpen] = useState(false);
  const cameraInitFor = useRef<string | null>(null);

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
    void router.setParams({ node: figmaNodeParam(nodeId) ?? "" });
  }, []);

  // The selected node's latest data: from the lazy store (raw REST shape), not a summary.
  const selectedNode: FigmaNode | null = useMemo(() => {
    if (!store || !selectedNodeId) return null;
    return findNodeInStore(store, selectedNodeId);
  }, [store, selectedNodeId]);

  const componentMeta = useCallback(
    (componentId: string) => store?.componentMeta(componentId),
    [store],
  );

  const focusNode = useCallback(
    (nodeId: string) => {
      selectNode(nodeId);
      if (!page || size.width === 0) return;
      const frame = page.frames.find((candidate) => candidate.id === nodeId);
      const bounds =
        (frame?.bounds as { x: number; y: number; width: number; height: number } | undefined) ??
        (() => {
          const node = store ? findNodeInStore(store, nodeId) : null;
          const raw = node?.absoluteBoundingBox;
          return typeof raw === "object" && raw !== null
            ? (raw as { x: number; y: number; width: number; height: number })
            : null;
        })();
      if (!bounds) return;
      setCamera((current) => centerCameraOn(current, bounds, size.width, size.height));
    },
    [page, selectNode, size.height, size.width, store],
  );

  // Center the camera on the selection once per file open (deep link / comment focus).
  useEffect(() => {
    if (!page || size.width === 0 || cameraInitFor.current === `${pageId}`) return;
    cameraInitFor.current = `${pageId}`;
    if (selectedNodeId) focusNode(selectedNodeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size.width]);

  const onLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
    },
    [],
  );

  const selectPage = useCallback(
    (next: string) => {
      setPageId(next);
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
  const applyPending = useCallback(() => {
    void edits.applyPending();
  }, [edits]);
  const discardPending = useCallback(() => {
    void edits.discardPending();
  }, [edits]);

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
      componentMeta={componentMeta}
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
      />
      <View style={jiraStyles.body} onLayout={onLayout}>
        <View style={jiraStyles.main}>
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
            overrides={edits.overrides}
          />
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
        {isCompact ? (
          <View style={jiraStyles.row}>
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
  componentMeta,
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
  componentMeta?: (componentId: string) => FigmaComponentMeta | undefined;
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
          componentMeta={componentMeta}
        />
      ) : null}
      {panel === "comments" && selection ? (
        <CommentsPanel file={file} selection={selection} onFocusNode={onFocusNode} />
      ) : null}
      {panel === "versions" ? (
        <VersionsPanel file={plainFile} onOpenVersion={VERSIONS_OPEN_HANDLER} />
      ) : null}
    </View>
  );
}
