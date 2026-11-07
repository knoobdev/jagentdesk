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
import { resolvePrototypeStartNode } from "./prototype-start";
import { errorMessage, useFigmaCall } from "./api";
import {
  SECTION_MOVE_DEADLINE_MS,
  type SectionMoveStatus,
  type SectionOffset,
  sectionEditing as buildSectionEditing,
  sectionMoveDescription,
  sectionMoveScript,
} from "./section-interaction";
import {
  absoluteBoundingBoxOf,
  type Camera,
  centerCameraOn,
  cameraToFit,
  nodeFocusBounds,
} from "./viewport";
import { useFigmaRemoteStatus } from "../queries";
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

/** Expo-router params arrive as string | string[]; empty means absent. */
function firstRouteParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && raw.length > 0 ? raw : null;
}

// The route-page banner's OWN signature: the clear path compares against it so fixing the
// URL never blindly wipes an unrelated focus-layer error sitting in the same banner slot.
function routePageErrorMessage(pageId: string): string {
  return `Page ${pageId} is not in this file.`;
}

function isRoutePageError(message: string): boolean {
  return message.startsWith("Page ") && message.endsWith(" is not in this file.");
}

// ADR-0039 / spec 32.5.1: the viewer gates ONCE on `figmaNodeDepth`, next to the existing base
// `figma` gate. An old host strips the `depth=1` option from `figma.file.nodes` and answers with
// the full Section, so sending it anyway silently breaks the bounded-Section contract — this
// client never sends depth to a host that does not advertise it, and there is no fallback to the
// full Section here. Missing capability shows the update-host view with NO data path mounted:
// the inner screen (outline, frame store, watch, edits) never runs its hooks, mirroring the
// W6 PrototypePlayer feature-contract shape so no hook is called conditionally.
export function FigmaFileScreen(ref: FigmaFileRef) {
  const enabled = useHostFeature(ref.serverId, "figma");
  const nodeDepth = useHostFeature(ref.serverId, "figmaNodeDepth");
  const pagedOutline = useHostFeature(ref.serverId, "figmaPagedOutline");
  if (!enabled) {
    return (
      <View style={jiraStyles.screen} testID="figma-host-unsupported">
        <ErrorBanner message="This host does not speak Figma yet — update the app running the daemon." />
      </View>
    );
  }
  if (!nodeDepth || !pagedOutline) {
    return (
      <View style={jiraStyles.screen} testID="figma-update-host">
        <ErrorBanner message="Update the app running the daemon to open Figma files with page loading." />
      </View>
    );
  }
  // Keyed so a host/file/version switch MOUNTS A FRESH inner: an in-flight write's promise
  // window cannot leak into the new identity through lingering state (the generation guard is
  // the belt; the key is the braces).
  return (
    <FigmaFileScreenInner
      key={`${ref.serverId}|${ref.fileKey}|${ref.version ?? "live"}`}
      {...ref}
    />
  );
}

// The write's synchronous identity: which host/file/page/version the committed drag belongs to.
// Compared in late callbacks directly — never relying on the effect-flushed generation alone.
interface MoveIdentity {
  serverId: string;
  fileKey: string;
  pageId: string | null;
  version: string | null;
}

// eslint-disable-next-line complexity
function FigmaFileScreenInner({ serverId, fileKey, version }: FigmaFileRef) {
  const isCompact = useIsCompactFormFactor();
  // The URL is the SINGLE source of truth for page + node (spec 32.5.1): the sidebar writes
  // `page`/`node` through useFigmaNav, the top bar writes the same params atomically, and the
  // canvas renders what the route says. A local pageId state let sidebar selection and canvas
  // diverge — "Access" highlighted, canvas still on "00 Start Here".
  const params = useLocalSearchParams<{
    node?: string | string[];
    page?: string | string[];
    focus?: string | string[];
  }>();
  const queryClient = useQueryClient();

  const outlineQuery = useFigmaOutline(
    serverId,
    fileKey,
    version ?? null,
    initialNodeId(params.page),
  );
  const outline =
    outlineQuery.isPending || outlineQuery.isError ? null : (outlineQuery.data ?? null);
  const edits = useFigmaEdits(serverId, fileKey);

  const [watchToken, setWatchToken] = useState(0);
  // ADR-0039 / spec 32.5.1: every asset path — depth1 Section metadata, full subtrees and
  // rasters — must pin to the SAME outline snapshot, so even the live view forwards the
  // outline's version explicitly (the figmaNodeDepth gate guarantees the host honors it).
  // Read-only stays keyed to the explicit historical `version` prop: deriving it from the
  // outline would lock the live viewer. The outline loads before the canvas mounts, so
  // assets simply re-key once when the snapshot lands — same pattern as watchToken reloads.
  const dataVersion = version ?? outline?.version ?? null;
  const store = useFigmaFrameStore(serverId, fileKey, dataVersion, watchToken);

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

  const pageParam = firstRouteParam(params.page);
  const page = useMemo(() => {
    if (!outline) return null;
    // Missing page param: the first REAL outline page, canonicalized into the route below —
    // never an invented page of its own.
    if (!pageParam) return outline.pages[0] ?? null;
    return outline.pages.find((candidate) => candidate.id === pageParam) ?? null;
  }, [outline, pageParam]);
  const currentPageId = page?.id ?? null;

  // ONE route-state effect owns the page-param edge cases; a split would let the two halves
  // drift (the stamp outliving the banner it was supposed to pair with).
  // - Unknown route page: error CLEARLY — no silent fallback to another page (a wrong page
  //   reads as missing/wrong designs) and the focus effect bails, so no accidental node.
  // - Real page param arriving: FORGET the canonicalization stamp, so a later back/forward
  //   (or removal) returning to the old page-less URL of the SAME outline canonicalizes again
  //   instead of being skipped by a stale stamp forever.
  // - Route becoming valid: clear the banner ONLY when the shown error is the one this effect
  //   raised — an unrelated focus-layer error must survive the fix. The functional updater
  //   returns the same value otherwise, so React bails: no re-render loop.
  const canonicalizedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!outline) return;
    if (pageParam) {
      if (!outline.pages.some((candidate) => candidate.id === pageParam)) {
        // Unknown route page: error CLEARLY — no silent fallback to another page (a wrong page
        // reads as missing/wrong designs) and the focus effect bails, so no accidental node.
        setFocusError(routePageErrorMessage(pageParam));
        return;
      }
      // A REAL page param arriving means the route is now authoritative on its own: FORGET
      // the canonicalization stamp, so a later back/forward (or removal) returning to the
      // old page-less URL of the SAME outline re-canonicalizes instead of being skipped by a
      // stale stamp forever.
      canonicalizedFor.current = null;
      // Route became valid: clear the banner ONLY when the shown error is the one this effect
      // raised — an unrelated focus-layer error must survive (never setFocusError(null)
      // blindly). Returning the same value makes React bail: no re-render loop.
      setFocusError((current) => (current && isRoutePageError(current) ? null : current));
      return;
    }
    const firstPage = outline.pages[0];
    if (firstPage) {
      // URL missing a page: write the default selection back exactly ONCE per outline snapshot
      // so sidebar/topbar/canvas converge on one canonical location. Direct setParams, not
      // useFigmaNav.go — go() would rewrite node/view from a stale location.
      const stamp = `${fileKey}|${outline.version ?? ""}`;
      if (canonicalizedFor.current !== stamp) {
        canonicalizedFor.current = stamp;
        void router.setParams({ page: firstPage.id });
      }
    }
    // A page-less route is ALSO a valid route (it resolves to the first real page): deleting
    // the param must not leave a false "Page … not in this file" banner — same signature
    // compare, unrelated focus errors survive.
    setFocusError((current) => (current && isRoutePageError(current) ? null : current));
  }, [outline, pageParam, fileKey]);

  const onWatched = useCallback(() => {
    invalidateFigmaFile(serverId, fileKey);
    void queryClient.invalidateQueries({ queryKey: figmaKeys.all(serverId, fileKey) });
    setWatchToken((token) => token + 1);
  }, [serverId, fileKey, queryClient]);

  // The wrapper only mounts this screen when the host speaks Figma, so the watch is active for
  // any live file; a historical version snapshot never watches.
  useFigmaWatch({ serverId, fileKey, active: !version, onChanged: onWatched });

  // ── SECTION editing (spec 32.6.2 / acceptance 19 / ADR-0040) ────────────────────────
  // ONE gate on `figmaRemoteWrites`; the connector's state comes from W10's shared
  // useFigmaRemoteStatus (enabled=false runs zero RPC on an old host). No capability, no
  // connected connector, or a pinned historical version means select/pan only — and the canvas
  // says "Connect editing" rather than swallowing the move. A committed move stays on screen
  // until INDEPENDENTLY refreshed outline metadata confirms the new WORLD position — the
  // execute reply (not even readbackAvailable) never claims "Saved" on its own.
  const remoteWrites = useHostFeature(serverId, "figmaRemoteWrites");
  const remoteStatus = useFigmaRemoteStatus(serverId, { enabled: remoteWrites });
  const [sectionOffsets, setSectionOffsets] = useState<Record<string, SectionOffset>>({});
  const [sectionMoveStatus, setSectionMoveStatus] = useState<SectionMoveStatus>(null);
  const expectedMove = useRef<{
    id: string;
    x: number;
    y: number;
    generation: number;
    identity: MoveIdentity;
  } | null>(null);
  const moveGeneration = useRef(0);
  const moveInFlight = useRef(false);
  const moveDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Synchronous write-identity snapshot, refreshed on EVERY RENDER: a late callback must
  // compare against what the screen shows NOW, not wait for the generation effect to commit —
  // that commit window is exactly where an old file/page's promise could land. (The key on the
  // inner mount handles host/file/version; this also catches an in-instance page switch.)
  const writeIdentity = useRef<MoveIdentity>({
    serverId,
    fileKey,
    pageId: page?.id ?? null,
    version: version ?? null,
  });
  writeIdentity.current = { serverId, fileKey, pageId: page?.id ?? null, version: version ?? null };
  const moveIsStale = useCallback((generation: number, identity: MoveIdentity) => {
    const now = writeIdentity.current;
    return (
      generation !== moveGeneration.current ||
      now.serverId !== identity.serverId ||
      now.fileKey !== identity.fileKey ||
      now.pageId !== identity.pageId ||
      now.version !== identity.version
    );
  }, []);
  const sectionEditing = useMemo(
    () =>
      buildSectionEditing({
        capability: remoteWrites,
        remoteConnected: remoteStatus.data?.state === "connected",
        versionPinned: Boolean(version),
      }),
    [remoteWrites, remoteStatus.data?.state, version],
  );

  const clearMoveLatch = useCallback((status: SectionMoveStatus) => {
    if (moveDeadline.current !== null) {
      clearTimeout(moveDeadline.current);
      moveDeadline.current = null;
    }
    expectedMove.current = null;
    moveInFlight.current = false;
    setSectionMoveStatus(status);
  }, []);

  // A host/file/page/version switch drops the pending preview outright, and bumping the
  // generation makes every response captured under the old identity "late": ignored, with no
  // stale invalidate/refetch of the new file.
  useEffect(() => {
    moveGeneration.current += 1;
    if (moveDeadline.current !== null) {
      clearTimeout(moveDeadline.current);
      moveDeadline.current = null;
    }
    expectedMove.current = null;
    moveInFlight.current = false;
    setSectionOffsets({});
    setSectionMoveStatus(null);
    return () => {
      moveGeneration.current += 1;
    };
  }, [serverId, fileKey, currentPageId, version]);

  // Independent verification: only the daemon's own re-read metadata may settle a move — it
  // compares WORLD bounds against the committed target. A matching refresh ends the preview; a
  // mismatching refresh (including a new version that disagrees) settles to "unverified" and
  // drops the preview, because the previewed position is provably not what the file says.
  useEffect(() => {
    const expected = expectedMove.current;
    if (!expected || !page) return;
    if (moveIsStale(expected.generation, expected.identity)) {
      expectedMove.current = null;
      return;
    }
    const moved = page.frames.find((frame) => frame.id === expected.id);
    if (!moved) return; // outline not re-read yet — the deadline settles it.
    if (
      Math.abs(moved.bounds.x - expected.x) < 0.5 &&
      Math.abs(moved.bounds.y - expected.y) < 0.5
    ) {
      clearMoveLatch(null);
      setSectionOffsets({});
    } else {
      clearMoveLatch("unverified");
      setSectionOffsets({});
    }
  }, [clearMoveLatch, moveIsStale, page]);

  const handleMoveSection = useCallback(
    (sectionId: string, dx: number, dy: number) => {
      const summary = page?.frames.find((frame) => frame.id === sectionId);
      // Synchronous single-write latch: a fast second drag cannot overwrite expectedMove or
      // race a second unverified write onto the wire.
      if (!summary || !sectionEditing.canEdit || moveInFlight.current) return;
      const x = summary.bounds.x + dx;
      const y = summary.bounds.y + dy;
      // NaN/Infinity on the committed delta would produce a meaningless target; the write must
      // land on finite world coordinates before the script is ever generated.
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const generation = moveGeneration.current;
      const identity = writeIdentity.current;
      moveInFlight.current = true;
      expectedMove.current = { id: sectionId, x, y, generation, identity };
      setSectionOffsets({ [sectionId]: { dx, dy } });
      setSectionMoveStatus("saving");
      void call("figma.remote.execute.request", {
        fileKey,
        code: sectionMoveScript(sectionId, x, y),
        description: sectionMoveDescription(summary.name, x, y),
      })
        .then((response) => {
          if (moveIsStale(generation, identity)) return; // late: no claim, no refetch
          if (response.result?.isError) {
            clearMoveLatch("failed");
            setSectionOffsets({});
            return;
          }
          // Independent re-read: drop the cached tree + outline so the NEXT render proves the
          // position from daemon-side metadata (the .then above never claims "Saved").
          onWatched();
          if (response.readbackAvailable === false) {
            // The daemon's own metadata re-read failed: the write may have landed, but nothing
            // proves it — and a preview that silently becomes document state is a lie. Drop the
            // preview while the refresh proceeds and keep the line flagged as uncertain (no
            // "Saved", no automatic retry).
            clearMoveLatch("unverified");
            setSectionOffsets({});
            return undefined;
          }
          // Wait for the refreshed outline to settle match/mismatch — never "saving" forever.
          moveDeadline.current = setTimeout(() => {
            if (moveIsStale(generation, identity)) return;
            clearMoveLatch("unverified");
          }, SECTION_MOVE_DEADLINE_MS);
          return undefined;
        })
        .catch(() => {
          if (moveIsStale(generation, identity)) return;
          clearMoveLatch("failed");
          setSectionOffsets({});
        });
    },
    [call, clearMoveLatch, fileKey, moveIsStale, onWatched, page, sectionEditing],
  );

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

  // W6 handoff: the player is started from the frame, never from the selected descendant. The
  // chain only exists once subtrees load, so this tracks the same store tick as selectedNode.
  const prototypeStartNodeId = useMemo(
    () =>
      resolvePrototypeStartNode({
        selectedNodeId,
        frames: page?.frames ?? [],
        flowStartingPoints: page?.flowStartingPoints ?? [],
        parentOf,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedNodeId, page, parentOf, storeTick],
  );

  const focusNode = useCallback(
    async (nodeId: string) => {
      setFocusError(null);
      selectNode(nodeId);
      if (!page || size.width === 0) return;
      let bounds = nodeFocusBounds(store, page, nodeId);
      let section =
        page.frames.find((frame) => frame.id === nodeId)?.type === "SECTION" ||
        (store ? findNodeInStore(store, nodeId)?.type === "SECTION" : false);
      if (!bounds) {
        // Resolve unknown bounds with shallow metadata first. A nested Section must not
        // download every descendant merely to focus it. Drawing roots still get full trees
        // through the viewport queue; Sections keep their separate depth-1 queue.
        try {
          const data = await call("figma.file.nodes.request", {
            fileKey,
            ids: [nodeId],
            ...(dataVersion ? { version: dataVersion, depth: 1 as const } : {}),
          });
          bounds = absoluteBoundingBoxOf(data.nodes?.[nodeId]);
          section = data.nodes?.[nodeId]?.type === "SECTION";
        } catch (cause) {
          setFocusError(`Could not focus layer ${nodeId}: ${errorMessage(cause)}`);
          return;
        }
        if (!bounds) {
          setFocusError(`Layer ${nodeId} was not found in this page.`);
          return;
        }
        if (section) void store?.loadSections([nodeId]);
        else void store?.load([nodeId]);
      }
      const target = bounds;
      setCamera((current) =>
        section
          ? cameraToFit(target, size.width, size.height)
          : centerCameraOn(current, target, size.width, size.height),
      );
    },
    [call, fileKey, page, selectNode, size.height, size.width, store, dataVersion],
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

  // A route page change (sidebar click, top bar write, back/forward) must not leave the
  // previous page's node highlighted or the focus latch pointed at a stale node: the URL no
  // longer names it, so neither may the screen. Mount/first-settling never clears (a deep
  // link's node param survives its own page); only an ACTUAL page flip does. Declared BEFORE
  // the focus effect so a history restore clears first and the restored node then re-selects.
  const lastRoutePage = useRef<string | null>(null);
  useEffect(() => {
    if (lastRoutePage.current !== null && lastRoutePage.current !== currentPageId) {
      setSelectedNodeId(null);
      skipUrlFocus.current = null;
      autoFocusedFor.current = null;
    }
    lastRoutePage.current = currentPageId;
  }, [currentPageId]);

  // The URL's `node` param drives focus: a deep link or a comment-panel URL write selects and
  // zooms to the layer, nested layers included (F5 owns the comment side of this contract).
  // Canvas clicks write the same param; `nodeParamToFocusId` keeps that echo from moving the
  // camera (skip/auto-focus guards are both held in the decoded node-id form).
  const nodeParam = Array.isArray(params.node) ? params.node[0] : params.node;
  const focusRequest = firstRouteParam(params.focus);
  const lastFocusRequest = useRef(focusRequest);
  useEffect(() => {
    if (lastFocusRequest.current !== focusRequest) {
      lastFocusRequest.current = focusRequest;
      skipUrlFocus.current = null;
      autoFocusedFor.current = null;
    }
    const nodeId = nodeParamToFocusId(nodeParam, skipUrlFocus.current, autoFocusedFor.current);
    if (!nodeId) {
      if (!figmaNodeIdFromParam(nodeParam ?? null)) autoFocusedFor.current = null;
      return;
    }
    if (!page || size.width === 0) return;
    autoFocusedFor.current = nodeId;
    void focusNode(nodeId);
  }, [nodeParam, focusRequest, page, size.width, focusNode]);

  const onLayout = useCallback(
    (event: { nativeEvent: { layout: { width: number; height: number } } }) => {
      setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
    },
    [],
  );

  const selectPage = useCallback((next: string) => {
    // ONE atomic route write: page changes AND the node clear land together, so the sidebar,
    // the top bar and the canvas all converge on the same location (the page-change effect
    // above the URL-focus effect drops the stale local selection when the route flips).
    // Never a local-only setPageId — that left the sidebar stale while the canvas moved.
    void router.setParams({ page: next, node: "" });
  }, []);

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

  const refetchOutline = outlineQuery.refetch;
  const retryOutline = useCallback(() => {
    void refetchOutline();
  }, [refetchOutline]);
  const retrying = outlineQuery.retrying;
  const retryAction = useMemo(
    () => (
      <Pressable
        onPress={retryOutline}
        accessibilityRole="button"
        testID="figma-page-retry"
        disabled={retrying}
      >
        <Text style={jiraStyles.mainText}>{retrying ? "Retrying…" : "Retry"}</Text>
      </Pressable>
    ),
    [retryOutline, retrying],
  );

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
        <ErrorBanner
          message={outlineQuery.error?.message ?? "The file could not be loaded."}
          action={retryAction}
        />
      </View>
    );
  }

  if (pageParam && !page) {
    return (
      <View style={jiraStyles.screen}>
        <ErrorBanner message={routePageErrorMessage(pageParam)} />
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
            version={dataVersion}
            page={page}
            store={store}
            camera={camera}
            onCamera={setCamera}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            overrides={version ? HISTORY_NO_OVERRIDES : edits.overrides}
            sectionEditing={sectionEditing}
            sectionOffsets={sectionOffsets}
            sectionMoveStatus={sectionMoveStatus}
            onMoveSection={handleMoveSection}
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
                startNodeId={prototypeStartNodeId}
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
