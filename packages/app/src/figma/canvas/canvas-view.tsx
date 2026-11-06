import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, PanResponder, PixelRatio, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { FigmaBytes, FigmaNode, FigmaPage } from "@jagentdesk/protocol/figma/rpc-schemas";
import { isWeb } from "@/constants/platform";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createFigmaRenderer } from "@/figma/renderer";
import { callFigma } from "./api";
import { isPinnedVersion, rasterRung } from "./assets";
import type { FrameStore } from "./frame-store";
import {
  childSummaries,
  flattenVisibleRoots,
  isSectionSummary,
  type SectionAwareSummary,
} from "./section-outline";
import { type FigmaAssets, useFigmaAssets } from "./use-figma-assets";
import {
  beginSectionDrag,
  cancelSectionDrag,
  commitSectionDrag,
  descendantIds,
  IDLE_DRAG,
  isSectionDragging,
  moveSectionDrag,
  sectionHitAt,
  STATUS_MOVE_FAILED,
  STATUS_MOVE_UNVERIFIED,
  STATUS_SAVING_MOVE,
  type SectionDrag,
  type SectionEditing,
  type SectionMoveStatus,
  type SectionOffset,
} from "./section-interaction";

// One place maps the committed move's lifecycle onto its status line (a lookup, not a ternary
// staircase — each state has exactly one honest string).
const MOVE_STATUS_LINES: Record<Exclude<SectionMoveStatus, null>, string> = {
  saving: STATUS_SAVING_MOVE,
  failed: STATUS_MOVE_FAILED,
  unverified: STATUS_MOVE_UNVERIFIED,
};
import {
  type Camera,
  type Point,
  figmaToScreen,
  framesInViewport,
  lodMode,
  panBy,
  planRootLoad,
  screenToFigma,
  visibleRect,
  zoomAroundPoint,
} from "./viewport";

// The canvas viewer (spec 32.5.1, ADR-0039). Web/Electron draw into one HTML canvas with a
// devicePixelRatio-backed store: drag or two-finger wheel pans, ctrl/cmd-wheel or pinch zooms
// around the cursor, and a click without movement runs the renderer's hitTest. What reaches the
// network is decided by ONE plan function (planRootLoad): at Fit every root is too small for
// detail, so overview draws factual metadata boxes and requests nothing; thumbnail LOD fetches
// cached rasters only for frames projected large enough to read; vectors (and their subtree
// loads, FrameStore batches ≤ 50 ids, LRU-capped) come only above THUMBNAIL_ZOOM with real
// projected size. SECTIONs never load a full tree: chrome from the summary, children via
// shallow depth-1 reads into a separate bounded cache, flattened into the same root list that
// painting, culling, hit-testing and Inspect share. Mobile shares the camera math, the plan,
// and shows frame rasters with pinch/pan and frame-level tap selection.

export interface CanvasViewProps {
  serverId: string;
  fileKey: string;
  version: string | null;
  page: FigmaPage | null;
  store: FrameStore | null;
  camera: Camera;
  onCamera: (next: Camera) => void;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  overrides: Record<string, Partial<FigmaNode>>;
  // ── SECTION selection + drag (spec 32.6.2 / acceptance 19) ──
  /** Capability/connector/history gate; when false, Sections are select/pan-only and say so. */
  sectionEditing?: SectionEditing | null;
  /** The single write on pointerup (a move commits once; Esc/cancel commits nothing). */
  onMoveSection?: (sectionId: string, dx: number, dy: number) => void;
  /** Committed offsets held until the refreshed outline data lands (preview continuity). */
  sectionOffsets?: Readonly<Record<string, SectionOffset>>;
  /** In-flight/uncertain/failed state of the last committed move, decided by FileScreen. */
  sectionMoveStatus?: "saving" | "failed" | "unverified" | null;
}

interface Size {
  width: number;
  height: number;
}

interface FrameBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Is a Figma-space point inside a root's real summary bounds? (Topmost pick, not culling.) */
function containsPoint(bounds: FrameBounds, point: Point): boolean {
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

const PAPER_COLOR = "#f5f5f5";
const PLACEHOLDER_BORDER = "#9a9a9a";
export const SELECTION_COLOR = "#0d99ff";

function boundsOf(node: FigmaNode | null | undefined): FrameBounds | null {
  const raw = node?.absoluteBoundingBox;
  if (typeof raw !== "object" || raw === null) return null;
  const box = raw as Record<string, unknown>;
  if (
    typeof box.x !== "number" ||
    typeof box.y !== "number" ||
    typeof box.width !== "number" ||
    typeof box.height !== "number"
  ) {
    return null;
  }
  return { x: box.x, y: box.y, width: box.width, height: box.height };
}

function findNode(node: FigmaNode, id: string): FigmaNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** The node behind an id, searched through everything the store has already loaded. */
export function findNodeInStore(store: FrameStore, nodeId: string): FigmaNode | null {
  for (const id of store.loadedIds()) {
    const root = store.get(id);
    if (!root) continue;
    const found = root.id === nodeId ? root : findNode(root, nodeId);
    if (found) return found;
  }
  // Shallow SECTION payloads carry their direct children (depth-1, ADR-0039): a selected
  // Section or one of its direct children must resolve for Inspect without a full-tree load.
  for (const id of store.sectionLoadedIds()) {
    const root = store.sectionNode(id);
    if (!root) continue;
    const found = root.id === nodeId ? root : findNode(root, nodeId);
    if (found) return found;
  }
  return null;
}

export function CanvasView(props: CanvasViewProps) {
  const {
    serverId,
    fileKey,
    version,
    page,
    store,
    camera,
    onCamera,
    selectedNodeId,
    onSelectNode,
    overrides,
    sectionEditing,
    onMoveSection,
    sectionOffsets,
    sectionMoveStatus,
  } = props;
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [tick, setTick] = useState(0);
  // One left-press on a selected Section's header/border tracks a whole-subtree preview; it
  // resolves to a single commit on pointerup or to nothing on Esc (spec 32.6.2). State (not a
  // ref) because the paint reads it — one update per pointermove coalesces into one rAF draw,
  // the same cadence panning already keeps, so there is no redraw storm.
  const [sectionDrag, setSectionDrag] = useState<SectionDrag>(IDLE_DRAG);
  const renderer = useMemo(() => createFigmaRenderer(), []);
  // ADR-0042 quality path: the outlined-SVG TEXT fallback and adaptive raster rungs exist only
  // when the host advertises the capability AND this scope pins a snapshot version (the hook
  // enforces the pair; without either, every request is the exact legacy scale-2 crop PNG).
  const fidelity = useHostFeature(serverId, "figmaRenderFidelity");
  // The device scale the camera is actually drawing with — written fresh each paint, consumed
  // at the raster boundary to pick the quantized rung (zoom alone would undersample on HiDPI).
  const deviceScaleRef = useRef(2);
  const assets = useFigmaAssets({
    serverId,
    fileKey,
    version,
    fidelity,
    getDeviceScale: () => deviceScaleRef.current,
  });

  const bump = useCallback(() => setTick((value) => value + 1), []);
  useEffect(() => (store ? store.subscribe(bump) : undefined), [store, bump]);
  useEffect(() => assets.subscribe(bump), [assets, bump]);

  // ── adaptive roots + lazy loading (spec 32.5.1, ADR-0039) ──────────────────────────
  // A SECTION is chrome only — background and label drawn from the real summary. Its unknown
  // children come from a shallow depth-1 read when the Section is in the viewport and large
  // enough for detail, recursively for nested Sections; the full-subtree queue only ever
  // carries leaf drawing/frame roots. The flat child summaries are the single source for
  // culling, painting, hit-testing and Inspect, so no Section tree is drawn twice.
  const revision = store ? store.revisionSnapshot() : 0;
  const drawnRoots = useMemo<SectionAwareSummary[]>(() => {
    void revision; // Cache changes keep `store`/`page` stable; only the revision re-runs this.
    if (!page) return [];
    return flattenVisibleRoots(page.frames, (id) => {
      const section = store?.sectionNode(id);
      return section ? childSummaries(section) : undefined;
    });
  }, [page, store, revision]);
  const visible = useMemo(() => {
    if (drawnRoots.length === 0 || size.width === 0 || size.height === 0) return [];
    return framesInViewport(drawnRoots, camera, size.width, size.height, 120);
  }, [drawnRoots, camera, size]);
  const loadPlan = useMemo(() => {
    const subtrees: string[] = [];
    const shallowSections: string[] = [];
    for (const frame of visible) {
      const plan = planRootLoad(frame.bounds, camera.zoom);
      if (isSectionSummary(frame)) {
        // Overview (metadata or thumbnail LOD) draws the Section's own summary box and label
        // only — its children stay unexpanded until vector detail is on screen (ADR-0039:
        // defer unknown Section children at overview).
        if (plan === "full" && frame.childrenLoaded === false) shallowSections.push(frame.id);
      } else if (plan === "full") {
        subtrees.push(frame.id);
      }
    }
    return { subtrees, shallowSections };
  }, [visible, camera]);
  useEffect(() => {
    if (!store || visible.length === 0) return;
    if (loadPlan.subtrees.length > 0) void store.load(loadPlan.subtrees);
    if (loadPlan.shallowSections.length > 0) void store.loadSections(loadPlan.shallowSections);
  }, [store, visible, loadPlan]);

  // ── SECTION drag preview (spec 32.6.2) ─────────────────────────────────────────────
  // Which ids move with the dragged Section is answered from the flat summaries already on
  // screen: the parentId closure — no full-section fetch, no fabricated metadata nodes. The
  // live preview delta and FileScreen's committed offsets (held until the refreshed outline
  // lands) share one lookup so painting stays a single map read.
  const sectionMoveOffsets = useMemo(() => {
    const map = new Map<string, SectionOffset>();
    const entries: Array<[string, SectionOffset]> = [];
    if (sectionDrag.phase === "preview")
      entries.push([sectionDrag.sectionId, { dx: sectionDrag.dx, dy: sectionDrag.dy }]);
    for (const [id, offset] of Object.entries(sectionOffsets ?? {})) entries.push([id, offset]);
    for (const [id, offset] of entries) {
      map.set(id, offset);
      for (const descendant of descendantIds(id, drawnRoots))
        if (!map.has(descendant)) map.set(descendant, offset);
    }
    return map;
  }, [drawnRoots, sectionDrag, sectionOffsets]);

  // ── camera gestures ───────────────────────────────────────────────────────────────
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const interaction = useRef({
    dragging: false,
    movedPx: 0,
    middle: false,
    lastX: 0,
    lastY: 0,
    pinchDistance: 0,
    pinchCenter: { x: 0, y: 0 } as Point,
  });

  const selectAt = useCallback(
    (point: Point) => {
      if (!page || !store) {
        onSelectNode(null);
        return;
      }
      const cursor = screenToFigma(cameraRef.current, point);
      // A Section's label and border belong to the SECTION (spec 32.6.2): a press there selects
      // it even when a child's box overlaps that strip. Its empty interior only selects it
      // when no child claims the cursor — the child pass below still wins there.
      const sectionHit = sectionHitAt(drawnRoots, cursor, cameraRef.current.zoom);
      if (sectionHit && sectionHit.region !== "empty") {
        onSelectNode(sectionHit.sectionId);
        return;
      }
      // Only the stack the cursor actually sits inside — NOT every viewport candidate. At Fit
      // the candidate list is the whole file, and loading all of it on one click defeats the
      // metadata LOD. Sections are chrome (never selectable here); frame roots under the cursor
      // are hit-tested topmost-first against their loaded trees.
      const candidates = framesInViewport(
        drawnRoots,
        cameraRef.current,
        size.width,
        size.height,
      ).filter((frame) => !isSectionSummary(frame) && containsPoint(frame.bounds, cursor));
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const frame = candidates[i];
        if (!frame) continue;
        const root = store.get(frame.id);
        if (root === null) {
          // Confirmed missing is a failure, not a life sentence: the tap that finds it retries
          // EXACTLY this root (targeted, spec 32.5.1) and clears failed asset attempts so the
          // repaint re-demands them. load() alone would skip it — the null is cached.
          void store.retry(frame.id);
          assets.retryFailed();
          bump();
          return;
        }
        if (root === undefined) {
          // The click is a detail demand for exactly ONE root: the topmost not-yet-loaded one,
          // which occludes everything below it — hit-testing a loaded lower frame would report
          // a selection the unknown root may cover. Queue it (load dedups cached/in-flight ids)
          // and stop; the next click at this spot runs against the real tree once it lands.
          void store.load([frame.id]);
          return;
        }
        const hit = renderer.hitTest(root, cursor);
        if (hit) {
          onSelectNode(hit.id);
          return;
        }
      }
      if (sectionHit) {
        // Empty interior, no child under the cursor: the Section itself is the answer.
        onSelectNode(sectionHit.sectionId);
        return;
      }
      if (assets.status().failed > 0) {
        // Empty-tap retry only while the status line promises it: failed asset attempts are
        // dropped so the next paint re-demands them (targeted — queued/ready keys untouched).
        assets.retryFailed();
        bump();
      }
      onSelectNode(null);
    },
    [assets, bump, drawnRoots, onSelectNode, page, renderer, size.height, size.width, store],
  );

  // ── painting (web/Electron) ───────────────────────────────────────────────────────
  // eslint-disable-next-line complexity
  const paint = useCallback(() => {
    if (!isWeb || typeof document === "undefined") return;
    const canvas = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Per-paint asset retention (spec 32.5.1): every draw opens a retention frame and closes
    // it, so caches drop everything this frame did not observe — culling already decided the
    // working set, "visited" alone keeps nothing alive. The frame MUST close on every path
    // past a valid ctx (empty viewport, missing page/store, mid-paint throw): an unclosed
    // frame leaves the caches permanently open, and caches reconcile even when untouched.
    assets.beginDraw();
    try {
      const dpr = window.devicePixelRatio || 1;
      const pixelsW = Math.max(1, Math.round(size.width * dpr));
      const pixelsH = Math.max(1, Math.round(size.height * dpr));
      if (canvas.width !== pixelsW || canvas.height !== pixelsH) {
        canvas.width = pixelsW;
        canvas.height = pixelsH;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = PAPER_COLOR;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!page || !store) {
        // A mounted canvas is not a ready canvas (spec 32.5.1): with the outline still on its
        // way — or absent — the paper alone looks like an empty design, so state the wait.
        if (size.width > 0) drawStatusLine(ctx, size.width, size.height, dpr, STATUS_LOADING);
        return;
      }
      if (size.width === 0) return;
      const zoom = cameraRef.current.zoom;
      // ADR-0042: record what this paint draws at so the asset layer's raster rung matches the
      // camera exactly (fallbackForNode/onMissing run synchronously inside the draw below).
      deviceScaleRef.current = zoom * dpr;
      ctx.setTransform(
        zoom * dpr,
        0,
        0,
        zoom * dpr,
        cameraRef.current.offsetX * dpr,
        cameraRef.current.offsetY * dpr,
      );
      const viewport = visibleRect(cameraRef.current, size.width, size.height);
      const mode = lodMode(zoom);
      for (const frame of visible) {
        const plan = planRootLoad(frame.bounds, zoom);
        // Drag preview (spec 32.6.2): the Section and every summary already known to hang
        // beneath it (parentId closure over metadata — no full-section fetch) move together.
        const offset = sectionMoveOffsets.get(frame.id);
        const shifted = offset ? { ...frame, bounds: shiftBounds(frame.bounds, offset) } : frame;
        // A SECTION is chrome in EVERY LOD: background and label from the summary only. Asking
        // for its thumbnail would raster a whole huge container, and its subtree is never loaded.
        if (isSectionSummary(frame)) {
          drawSectionChrome(ctx, shifted);
          continue;
        }
        if (plan === "metadata") {
          // Overview: factual summary data only — zero subtree requests, zero thumbnail rasters.
          drawMetadataBox(ctx, shifted);
          continue;
        }
        if (mode === "thumbnail") {
          const raster = assets.requestThumbnail(frame.id, 1);
          if (raster)
            ctx.drawImage(
              raster,
              shifted.bounds.x,
              shifted.bounds.y,
              shifted.bounds.width,
              shifted.bounds.height,
            );
          else drawPlaceholder(ctx, shifted.bounds, shifted.name);
          continue;
        }
        const node = store.get(frame.id);
        if (node === null) {
          drawPlaceholder(ctx, shifted.bounds, `${shifted.name} (unavailable)`);
          continue;
        }
        if (node === undefined) {
          void store.load([frame.id]);
          drawPlaceholder(ctx, shifted.bounds, shifted.name);
          continue;
        }
        ctx.save();
        if (offset) ctx.translate(offset.dx, offset.dy);
        renderer.draw(ctx, node, {
          scale: zoom * dpr,
          viewport,
          imageForRef: assets.imageForRef,
          fallbackForNode: assets.fallbackForNode,
          // ADR-0042 bounds pair: the asset layer routes known-TEXT fallbacks to the absolute-
          // bounds SVG (and its absolute PNG), so the renderer must place those at the layout
          // box; everything else stays on Figma's default crop → absoluteRenderBounds. False
          // unless the whole quality path (capability + pinned version) is on.
          fallbackTextUsesAbsoluteBounds: fidelity === true && isPinnedVersion(version),
          fontAvailable: assets.fontAvailable,
          onMissing: assets.onMissing,
          overrides: overridesRef.current,
        });
        ctx.restore();
      }
      const selectedSection = selectedNodeId
        ? drawnRoots.find((frame) => frame.id === selectedNodeId && isSectionSummary(frame))
        : undefined;
      if (selectedNodeId) {
        if (selectedSection) {
          const offset = sectionMoveOffsets.get(selectedSection.id);
          ctx.save();
          if (offset) ctx.translate(offset.dx, offset.dy);
          drawSectionSelection(ctx, selectedSection);
          ctx.restore();
        } else {
          drawSelectionBox(ctx, store, selectedNodeId);
        }
      }
      // Honest readiness over the finished frame (spec 32.5.1): one line from the real
      // ledgers — subtrees/Section expansions still queued or fetching, assets undelivered,
      // confirmed-missing roots, or a pure metadata overview waiting on a zoom. A Section
      // move owns the line while in flight, uncertain, or failed — and a selected Section on
      // a read-only surface shows "Connect editing" instead of a silent pendingSaved.
      const moveText = sectionMoveStatus ? MOVE_STATUS_LINES[sectionMoveStatus] : null;
      const editingText =
        selectedSection && sectionEditing && !sectionEditing.canEdit ? sectionEditing.notice : null;
      const statusText =
        moveText ?? editingText ?? canvasStatusText(contentLedger(visible, store, zoom, assets));
      if (statusText) drawStatusLine(ctx, size.width, size.height, dpr, statusText);
    } finally {
      assets.endDraw();
    }
  }, [
    assets,
    drawnRoots,
    fidelity,
    page,
    renderer,
    sectionEditing,
    sectionMoveOffsets,
    sectionMoveStatus,
    selectedNodeId,
    size.height,
    size.width,
    store,
    version,
    visible,
  ]);

  useEffect(() => {
    if (!isWeb) return;
    const frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [paint, tick]);

  // ── DOM input handlers (web only, attached to the host View's div) ───────────────
  const hostRef = useRef<HTMLElement | null>(null);
  const sectionDragRef = useRef<SectionDrag>(IDLE_DRAG);
  sectionDragRef.current = sectionDrag;
  const spaceHeld = useRef(false);
  const handlers = useRef({ selectAt, onCamera, drawnRoots, sectionEditing, onMoveSection });
  handlers.current = { selectAt, onCamera, drawnRoots, sectionEditing, onMoveSection };
  useEffect(() => {
    if (!isWeb || typeof document === "undefined") return;
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.id = CANVAS_ID;
    canvas.style.position = "absolute";
    canvas.style.inset = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    canvas.style.cursor = "default";
    host.appendChild(canvas);
    const cursorOf = (event: MouseEvent | PointerEvent): Point => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const { onCamera: move } = handlers.current;
      if (event.ctrlKey || event.metaKey) {
        move(zoomAroundPoint(cameraRef.current, Math.exp(-event.deltaY * 0.0025), cursorOf(event)));
      } else {
        move(panBy(cameraRef.current, -event.deltaX, -event.deltaY));
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const state = interaction.current;
      if (event.button !== 0 && event.button !== 1) return;
      state.dragging = true;
      state.movedPx = 0;
      state.middle = event.button === 1;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
      // A left press on a Section's header/border owns the gesture as a whole-subtree move
      // preview (spec 32.6.2) — unless Space is held or the middle button is down: those pan,
      // always. Without an editing surface (host capability / connected connector) Sections
      // stay select/pan only, and the canvas says "Connect editing" instead of dropping it.
      if (event.button === 1 || spaceHeld.current) return;
      const {
        drawnRoots: roots,
        sectionEditing: editing,
        onMoveSection: commit,
      } = handlers.current;
      const hit = sectionHitAt(roots, cursorOf(event), cameraRef.current.zoom);
      if (hit && hit.region !== "empty" && editing?.canEdit && commit) {
        const drag = beginSectionDrag(hit.sectionId, cursorOf(event));
        sectionDragRef.current = drag;
        setSectionDrag(drag);
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      const state = interaction.current;
      if (!state.dragging) return;
      if (isSectionDragging(sectionDragRef.current)) {
        const next = moveSectionDrag(
          sectionDragRef.current,
          cursorOf(event),
          cameraRef.current.zoom,
        );
        if (next !== sectionDragRef.current) {
          sectionDragRef.current = next;
          setSectionDrag(next); // one update per move, coalesced by rAF into one paint
        }
        return; // the Section owns this gesture: no pan under a live drag
      }
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      state.movedPx += Math.abs(dx) + Math.abs(dy);
      if (dx !== 0 || dy !== 0) handlers.current.onCamera(panBy(cameraRef.current, dx, dy));
    };
    const onPointerUp = (event: PointerEvent) => {
      const state = interaction.current;
      const dragging = isSectionDragging(sectionDragRef.current);
      const sectionCommit = dragging ? commitSectionDrag(sectionDragRef.current) : null;
      if (dragging) {
        sectionDragRef.current = cancelSectionDrag();
        setSectionDrag(sectionDragRef.current);
      }
      const click = state.dragging && state.movedPx <= 4 && !state.middle && !sectionCommit;
      state.dragging = false;
      state.middle = false;
      canvas.releasePointerCapture?.(event.pointerId);
      // One write per released drag (spec 32.6.2): the commit happens exactly here, here only.
      if (sectionCommit)
        handlers.current.onMoveSection?.(
          sectionCommit.sectionId,
          sectionCommit.dx,
          sectionCommit.dy,
        );
      else if (click) handlers.current.selectAt(cursorOf(event));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === " ") spaceHeld.current = true;
      // Esc kills the preview with ZERO writes — nothing moved, nothing was saved.
      if (event.key === "Escape" && isSectionDragging(sectionDragRef.current)) {
        sectionDragRef.current = cancelSectionDrag();
        setSectionDrag(sectionDragRef.current);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") spaceHeld.current = false;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      canvas.remove();
    };
  }, []);

  const onLayout = useCallback((event: { nativeEvent: { layout: Size } }) => {
    setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
  }, []);

  if (!isWeb) {
    const statusText =
      !page || !store
        ? STATUS_LOADING // outline still arriving: mounted ≠ ready (spec 32.5.1)
        : canvasStatusText(contentLedger(visible, store, camera.zoom, assets));
    return (
      <View style={styles.fill} onLayout={onLayout} testID="figma-canvas">
        <NativeCanvasLayer
          serverId={serverId}
          fileKey={fileKey}
          version={version}
          fidelity={fidelity}
          visible={visible}
          camera={camera}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onCamera={onCamera}
          paper={page?.backgroundColor}
          statusText={statusText}
        />
      </View>
    );
  }

  return (
    <View style={styles.fill} onLayout={onLayout} testID="figma-canvas">
      <View
        ref={hostRef as unknown as RefObject<View>}
        style={[
          styles.fill,
          page?.backgroundColor ? { backgroundColor: page.backgroundColor } : null,
        ]}
      />
    </View>
  );
}

export const CANVAS_ID = "jagentdesk-figma-canvas";

function drawPlaceholder(ctx: CanvasRenderingContext2D, bounds: FrameBounds, label: string): void {
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.strokeStyle = PLACEHOLDER_BORDER;
  ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.setLineDash([]);
  ctx.fillStyle = PLACEHOLDER_BORDER;
  ctx.font = "12px sans-serif";
  ctx.fillText(label, bounds.x + 8, bounds.y + 18);
  ctx.restore();
}

const SECTION_BORDER = "#7a7a7a";

/** The Section's real summary is the whole picture: background from the outline, plus label. */
function drawSectionChrome(ctx: CanvasRenderingContext2D, frame: SectionAwareSummary): void {
  ctx.save();
  if (frame.backgroundColor) {
    ctx.fillStyle = frame.backgroundColor;
    ctx.fillRect(frame.bounds.x, frame.bounds.y, frame.bounds.width, frame.bounds.height);
  }
  ctx.strokeStyle = SECTION_BORDER;
  ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
  ctx.strokeRect(frame.bounds.x, frame.bounds.y, frame.bounds.width, frame.bounds.height);
  ctx.fillStyle = SECTION_BORDER;
  ctx.font = "12px sans-serif";
  ctx.fillText(frame.name, frame.bounds.x + 8, frame.bounds.y + 18);
  ctx.restore();
}

/** Overview frame box from factual summary data only — bounds, real background, name. */
function drawMetadataBox(ctx: CanvasRenderingContext2D, frame: SectionAwareSummary): void {
  ctx.save();
  ctx.fillStyle = frame.backgroundColor ?? "#ffffff";
  ctx.fillRect(frame.bounds.x, frame.bounds.y, frame.bounds.width, frame.bounds.height);
  ctx.strokeStyle = PLACEHOLDER_BORDER;
  ctx.lineWidth = 1 / (ctx.getTransform().a || 1);
  ctx.strokeRect(frame.bounds.x, frame.bounds.y, frame.bounds.width, frame.bounds.height);
  ctx.fillStyle = PLACEHOLDER_BORDER;
  ctx.font = "12px sans-serif";
  ctx.fillText(frame.name, frame.bounds.x + 8, frame.bounds.y + 18);
  ctx.restore();
}

/** Summary bounds moved by a live drag preview or a committed-but-unconfirmed offset. */
function shiftBounds(bounds: FrameBounds, offset: SectionOffset): FrameBounds {
  return {
    x: bounds.x + offset.dx,
    y: bounds.y + offset.dy,
    width: bounds.width,
    height: bounds.height,
  };
}

/** Selected-Section box: same selection language as nodes, straight from the summary. */
function drawSectionSelection(ctx: CanvasRenderingContext2D, frame: SectionAwareSummary): void {
  ctx.save();
  ctx.strokeStyle = SELECTION_COLOR;
  ctx.lineWidth = 2 / (ctx.getTransform().a || 1);
  ctx.strokeRect(frame.bounds.x, frame.bounds.y, frame.bounds.width, frame.bounds.height);
  ctx.fillStyle = SELECTION_COLOR;
  ctx.fillRect(frame.bounds.x, frame.bounds.y - 16, 8 + frame.name.length * 6, 16);
  ctx.fillStyle = "#ffffff";
  ctx.font = "10px sans-serif";
  ctx.fillText(frame.name, frame.bounds.x + 4, frame.bounds.y - 4);
  ctx.restore();
}

// ── honest content status (spec 32.5.1) ──────────────────────────────────────────────
// A mounted canvas/outline is NOT content ready: while the visible viewport still waits on
// subtrees, SECTION depth-1 children, fonts, image fills or rasters, the viewer must say so —
// a silent dashed placeholder for 8 s reads as "the design is missing". The line is decided
// from the REAL ledgers (the store's queue/inflight sets and the caches' record phases), never
// from fabricated counts, and it draws in the existing paint: no extra repaints, no storm.

export const STATUS_LOADING = "Loading content…";
export const STATUS_FAILED = "Some content failed to load — tap to retry";
export const STATUS_ZOOM_HINT = "Zoom in for details";

export interface ContentLedger {
  pending: boolean;
  failed: boolean;
  metadataOnlyOverview: boolean;
}

/**
 * What the viewport is actually waiting for. Frames below the detail threshold legitimately
 * draw metadata-only — if that is ALL there is, the viewer says "zoom in" instead of going
 * silent. A queued or in-flight subtree/SECTION-depth-1 read, an undelivered asset (fill,
 * raster or font attempt still loading/decoding) is pending; a confirmed-missing root (cached
 * null) or a terminal failed asset attempt is failed.
 */
export function contentLedger(
  visible: readonly SectionAwareSummary[],
  store: FrameStore,
  zoom: number,
  assets: FigmaAssets,
): ContentLedger {
  let pending = false;
  let failed = false;
  let metadataOnlyOverview = visible.length > 0;
  for (const frame of visible) {
    if (isSectionSummary(frame)) {
      // Section chrome is the whole picture only until its depth-1 children are asked for:
      // a queued expansion is content the user is waiting on right now.
      metadataOnlyOverview = false;
      if (frame.childrenLoaded === false && store.isSectionPending(frame.id)) pending = true;
      continue;
    }
    const plan = planRootLoad(frame.bounds, zoom);
    if (plan === "metadata") continue;
    metadataOnlyOverview = false;
    if (plan === "thumbnail") continue; // its rasters show up in the asset ledger below
    const node = store.get(frame.id);
    if (node === undefined) pending = true;
    else if (node === null) failed = true;
  }
  const assetState = assets.status();
  if (assetState.pending > 0) pending = true;
  if (assetState.failed > 0) failed = true;
  return { pending, failed, metadataOnlyOverview };
}

export function canvasStatusText(ledger: ContentLedger): string | null {
  // Loading outranks failure: failed attempts can sit behind work still arriving, and the user
  // must not be told "failed" while the file is legitimately still on its way.
  if (ledger.pending) return STATUS_LOADING;
  if (ledger.failed) return STATUS_FAILED;
  if (ledger.metadataOnlyOverview) return STATUS_ZOOM_HINT;
  return null;
}

function drawStatusLine(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  text: string,
): void {
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textAlign = "center";
  ctx.font = "13px sans-serif";
  ctx.fillStyle = PLACEHOLDER_BORDER;
  ctx.fillText(text, width / 2, height - 16);
  ctx.restore();
}

function drawSelectionBox(
  ctx: CanvasRenderingContext2D,
  store: FrameStore,
  selectedNodeId: string,
): void {
  for (const id of store.loadedIds()) {
    const root = store.get(id);
    if (!root) continue;
    const node = root.id === selectedNodeId ? root : findNode(root, selectedNodeId);
    const bounds = boundsOf(node);
    if (!node || !bounds) continue;
    ctx.save();
    ctx.strokeStyle = SELECTION_COLOR;
    ctx.lineWidth = 2 / (ctx.getTransform().a || 1);
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    ctx.fillStyle = SELECTION_COLOR;
    ctx.fillRect(bounds.x, bounds.y - 16, 8 + node.name.length * 6, 16);
    ctx.fillStyle = "#ffffff";
    ctx.font = "10px sans-serif";
    ctx.fillText(node.name, bounds.x + 4, bounds.y - 4);
    ctx.restore();
    return;
  }
}

/** Keep this many rendered tiles in memory on the native viewer; visible tiles never evict. */
export const MAX_RASTER_TILES = 64;

/**
 * Cap the native raster cache: the spec keeps no drawing objects outside the viewport, so tiles
 * that scrolled away expire oldest-first once the cache outgrows `max`. Currently visible tiles
 * stay regardless (they are being painted), so retained tiles are `max(visible, max)` — a wide
 * viewport legitimately holds more than `max` tiles; only the OFF-viewport retention is capped.
 * Every dropped id is reported so the caller can forget it from its request ledger and re-fetch
 * when the frame scrolls back.
 */
export function pruneRasterCache(
  cached: Record<string, string>,
  visibleIds: readonly string[],
  max: number = MAX_RASTER_TILES,
): { rasters: Record<string, string>; dropped: string[] } {
  const keys = Object.keys(cached);
  if (keys.length <= max) return { rasters: cached, dropped: [] };
  const visible = new Set(visibleIds);
  const hidden = keys.filter((id) => !visible.has(id));
  const keepHidden = Math.max(0, max - keys.filter((id) => visible.has(id)).length);
  const keep = new Set<string>([...visible, ...hidden.slice(hidden.length - keepHidden)]);
  const rasters: Record<string, string> = {};
  const dropped: string[] = [];
  for (const id of keys) {
    if (keep.has(id)) rasters[id] = cached[id] as string;
    else dropped.push(id);
  }
  return { rasters, dropped };
}

/**
 * Merge one arrived render batch and enforce the tile cap. The ledger loses dropped ids so a
 * frame scrolled back into view is requested again. Batch ids are qualified with the rung they
 * were fetched at (`id@scale`, ADR-0042): two rungs of the same frame are distinct tiles, and
 * an old-rung response cannot overwrite the new-rung slot.
 */
function mergeRasterBatch(
  current: Record<string, string>,
  batch: readonly string[],
  images: Record<string, FigmaBytes | null>,
  visibleIds: readonly string[],
  ledger: Set<string>,
): Record<string, string> {
  const next = { ...current };
  for (const key of batch) {
    const bytes = images[keyToTileId(key)];
    // Null entries are the wire's "this id got no raster" marker: no tile, id stays pruned
    // from the caller's view of `next` and the ledger lets a re-exposure request it again.
    if (bytes) next[key] = `data:${bytes.mimeType};base64,${bytes.dataBase64}`;
  }
  // Bound the cache at arrival time, not render time: panning across a 500-frame page
  // otherwise keeps every tile's base64 payload for the whole session.
  const pruned = pruneRasterCache(next, visibleIds);
  for (const id of pruned.dropped) ledger.delete(id);
  return pruned.rasters;
}

/** A tile cache/ledger key qualified with the rung it belongs to (`id@scale`, ADR-0042). */
function tileKey(id: string, scale: number): string {
  return `${id}@${scale}`;
}

/** The wire id behind a qualified tile key: the last `@` split, ids themselves contain `:`. */
function keyToTileId(key: string): string {
  const at = key.lastIndexOf("@");
  return at < 0 ? key : key.slice(0, at);
}

/** Native (spec 32.5 mobile): same camera math, rasters + pinch/pan through PanResponder. */
export function NativeCanvasLayer(props: {
  serverId: string;
  fileKey: string;
  version: string | null;
  /** Host advertised `figmaRenderFidelity` (ADR-0042): adaptive tile rungs. PNG-only on native. */
  fidelity?: boolean;
  visible: readonly SectionAwareSummary[];
  camera: Camera;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onCamera: (next: Camera) => void;
  paper?: string;
  /** Honest readiness line from the real store/asset ledgers (spec 32.5.1). */
  statusText?: string | null;
}) {
  const { visible, camera, fileKey, version, onCamera, onSelectNode, selectedNodeId } = props;
  const client = useHostRuntimeClient(props.serverId);
  // ADR-0042 native tiles: with the capability AND a pinned version, fetch at the quantized
  // rung the pinch-zoom actually draws at (zoom × device px); the legacy path keeps the exact
  // fixed scale-2 wire. Tiles stay PNG everywhere — SVG data URIs in RN <Image> have no real-
  // device proof yet, so no SVG claim on native.
  const tileScale =
    props.fidelity === true && isPinnedVersion(version)
      ? rasterRung(camera.zoom * PixelRatio.get())
      : 2;
  const [rasters, setRasters] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());
  // The viewport as of the latest pass: an arriving batch must prune against what is visible
  // NOW, not the viewport captured when its fetch began, or a slow response evicts tiles the
  // user has since scrolled into view.
  const visibleIdsRef = useRef<string[]>([]);
  // Rasters belong to one (server, file, version) snapshot: the versions panel swaps `version`
  // on the same mounted viewer and the host switcher swaps `serverId`, and without this ledger
  // the old tiles would render forever — stale data retained as if it were the new scope, and
  // never released.
  const rasterScope = useRef<string | null>(null);
  useEffect(() => {
    // serverId is part of the identity: two hosts can serve the same fileKey at the same
    // version, and omitting it left the other host's tiles painted forever. The reset runs
    // BEFORE the client check — going offline is a scope event too, and returning early left
    // the previous host's tiles on screen with no client to ever clear them.
    const scope = `${props.serverId}|${fileKey}|${version ?? "live"}`;
    if (rasterScope.current !== scope) {
      rasterScope.current = scope;
      requested.current.clear();
      setRasters((current) => (Object.keys(current).length === 0 ? current : {}));
    }
    const detailIds = visible
      // Sections are chrome in every LOD (and overview defers their children): a raster of a
      // whole huge container is never worth requesting. Only detail-worthy frame roots get tiles.
      .filter(
        (frame) =>
          !isSectionSummary(frame) && planRootLoad(frame.bounds, camera.zoom) !== "metadata",
      )
      .map((frame) => frame.id);
    // Every cache/ledger key is rung-qualified (`id@scale`, ADR-0042): a tile fetched for one
    // zoom level never answers another, and crossing a rung boundary re-asks instead of
    // stretching stale bytes.
    const detailKeys = detailIds.map((id) => tileKey(id, tileScale));
    visibleIdsRef.current = detailKeys;
    if (!client) return;
    const missing = detailIds.filter((id) => !requested.current.has(tileKey(id, tileScale)));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(tileKey(id, tileScale));
    for (let i = 0; i < missing.length; i += 20) {
      const batch = missing.slice(i, i + 20);
      const batchKeys = batch.map((id) => tileKey(id, tileScale));
      void callFigma(client, "figma.file.render.request", {
        fileKey,
        ids: batch,
        scale: tileScale,
        ...(version ? { version } : {}),
      })
        .then((data) =>
          setRasters((current) => {
            // A response that crossed a server/file/version switch belongs to the old scope;
            // the new scope's effect already re-requested these ids, so drop the stale payload.
            if (rasterScope.current !== scope) return current;
            return mergeRasterBatch(
              current,
              batchKeys,
              data.images,
              visibleIdsRef.current,
              requested.current,
            );
          }),
        )
        .catch(() => {
          // The same scope guard as success: a rejection surfacing after a scope switch must
          // not delete the ledger ids the NEW scope's effect just re-requested — otherwise the
          // live batch's ids vanish from `requested` and the next pass double-fetches them.
          if (rasterScope.current !== scope) return;
          for (const key of batchKeys) requested.current.delete(key);
        });
    }
  }, [client, props.serverId, fileKey, version, tileScale, visible, camera]);

  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const responder = useMemo(() => {
    let startX = 0;
    let startY = 0;
    let pinchDistance = 0;
    let pinchCenter: Point = { x: 0, y: 0 };
    let movedPx = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: (event) => {
        const touch = event.nativeEvent.touches[0] ?? event.nativeEvent;
        startX = touch.pageX;
        startY = touch.pageY;
        movedPx = 0;
        pinchDistance = 0;
        if (event.nativeEvent.touches.length === 2) {
          const [a, b] = event.nativeEvent.touches;
          if (a && b) {
            pinchDistance = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
            pinchCenter = { x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 };
          }
        }
      },
      onPanResponderMove: (event) => {
        if (event.nativeEvent.touches.length === 2 && pinchDistance > 0) {
          const [a, b] = event.nativeEvent.touches;
          if (!a || !b) return;
          const distance = Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
          const center = { x: (a.pageX + b.pageX) / 2, y: (a.pageY + b.pageY) / 2 };
          const current = cameraRef.current;
          onCamera(
            panBy(
              zoomAroundPoint(current, distance / pinchDistance, center),
              center.x - pinchCenter.x,
              center.y - pinchCenter.y,
            ),
          );
          pinchDistance = distance;
          pinchCenter = center;
          return;
        }
        const touch = event.nativeEvent.touches[0];
        if (!touch) return;
        const dx = touch.pageX - startX;
        const dy = touch.pageY - startY;
        startX = touch.pageX;
        startY = touch.pageY;
        movedPx += Math.abs(dx) + Math.abs(dy);
        onCamera(panBy(cameraRef.current, dx, dy));
      },
      onPanResponderRelease: (event) => {
        if (movedPx > 8) return;
        const touch = event.nativeEvent.changedTouches[0];
        if (!touch) return;
        const current = cameraRef.current;
        // Frame-level selection goes through the flat frame roots: a SECTION covers its whole
        // area and sits earlier in the list, so matching it first made frames inside a Section
        // untappable on mobile.
        const frame = visible.find((candidate) => {
          if (isSectionSummary(candidate)) return false;
          const corner = figmaToScreen(current, { x: candidate.bounds.x, y: candidate.bounds.y });
          return (
            touch.pageX >= corner.x &&
            touch.pageY >= corner.y &&
            touch.pageX <= corner.x + candidate.bounds.width * current.zoom &&
            touch.pageY <= corner.y + candidate.bounds.height * current.zoom
          );
        });
        onSelectNode(frame?.id ?? null);
      },
    });
  }, [onCamera, onSelectNode, visible]);

  return (
    <View
      style={[styles.fill, props.paper ? { backgroundColor: props.paper } : null]}
      {...responder.panHandlers}
      testID="figma-canvas-native"
    >
      {visible.map((frame) => {
        const corner = figmaToScreen(camera, { x: frame.bounds.x, y: frame.bounds.y });
        const uri = rasters[tileKey(frame.id, tileScale)];
        return (
          <View
            key={frame.id}
            style={[
              styles.nativeFrame,
              {
                left: corner.x,
                top: corner.y,
                width: frame.bounds.width * camera.zoom,
                height: frame.bounds.height * camera.zoom,
                borderColor: selectedNodeId === frame.id ? SELECTION_COLOR : PLACEHOLDER_BORDER,
              },
            ]}
          >
            {uri ? <NativeFrameImage uri={uri} label={frame.name} /> : null}
            <View style={styles.nativeFrameLabel} pointerEvents="none">
              <Text style={styles.nativeFrameLabelText} numberOfLines={1}>
                {frame.name}
              </Text>
            </View>
          </View>
        );
      })}
      {(() => {
        // Tiles the viewport demands but has not received are real pending work: a detail-plan
        // frame with no raster yet means its render batch is queued, in flight, or mid-retry.
        const waitingOnTiles = visible.some(
          (frame) =>
            !isSectionSummary(frame) &&
            planRootLoad(frame.bounds, camera.zoom) !== "metadata" &&
            rasters[tileKey(frame.id, tileScale)] === undefined,
        );
        const text = waitingOnTiles ? STATUS_LOADING : (props.statusText ?? null);
        if (!text) return null;
        return (
          <View style={styles.statusBar} pointerEvents="none">
            <Text style={styles.statusText} testID="figma-canvas-status">
              {text}
            </Text>
          </View>
        );
      })()}
    </View>
  );
}

// The {uri} source object lives in a memo so the JSX prop stays referentially stable per tile.
function NativeFrameImage({ uri, label }: { uri: string; label: string }) {
  const source = useMemo(() => ({ uri }), [uri]);
  return (
    <Image
      source={source}
      style={styles.nativeFrameImage}
      resizeMode="stretch"
      accessibilityLabel={label}
    />
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  fill: { flex: 1, minWidth: 0, minHeight: 0 },
  nativeFrame: {
    position: "absolute",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    overflow: "hidden",
  },
  nativeFrameImage: { width: "100%", height: "100%" },
  nativeFrameLabel: { position: "absolute", left: 8, top: 6 },
  nativeFrameLabelText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  statusBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 16,
    alignItems: "center",
  },
  statusText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    backgroundColor: "rgba(255,255,255,0.85)",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
}));
