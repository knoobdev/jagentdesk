import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, PanResponder, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { FigmaBytes, FigmaNode, FigmaPage } from "@jagentdesk/protocol/figma/rpc-schemas";
import { isWeb } from "@/constants/platform";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createFigmaRenderer } from "@/figma/renderer";
import { callFigma } from "./api";
import type { FrameStore } from "./frame-store";
import {
  childSummaries,
  flattenVisibleRoots,
  isSectionSummary,
  type SectionAwareSummary,
} from "./section-outline";
import { useFigmaAssets } from "./use-figma-assets";
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
  } = props;
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  const [tick, setTick] = useState(0);
  const renderer = useMemo(() => createFigmaRenderer(), []);
  const assets = useFigmaAssets({ serverId, fileKey, version });

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

  // ── camera gestures ───────────────────────────────────────────────────────────────
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const overridesRef = useRef(overrides);
  overridesRef.current = overrides;
  const interaction = useRef({
    dragging: false,
    movedPx: 0,
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
        if (!root) {
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
      onSelectNode(null);
    },
    [drawnRoots, onSelectNode, page, renderer, size.height, size.width, store],
  );

  // ── painting (web/Electron) ───────────────────────────────────────────────────────
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
      if (!page || !store || size.width === 0) return;
      const zoom = cameraRef.current.zoom;
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
        // A SECTION is chrome in EVERY LOD: background and label from the summary only. Asking
        // for its thumbnail would raster a whole huge container, and its subtree is never loaded.
        if (isSectionSummary(frame)) {
          drawSectionChrome(ctx, frame);
          continue;
        }
        if (plan === "metadata") {
          // Overview: factual summary data only — zero subtree requests, zero thumbnail rasters.
          drawMetadataBox(ctx, frame);
          continue;
        }
        if (mode === "thumbnail") {
          const raster = assets.requestThumbnail(frame.id, 1);
          if (raster)
            ctx.drawImage(
              raster,
              frame.bounds.x,
              frame.bounds.y,
              frame.bounds.width,
              frame.bounds.height,
            );
          else drawPlaceholder(ctx, frame.bounds, frame.name);
          continue;
        }
        const node = store.get(frame.id);
        if (node === null) {
          drawPlaceholder(ctx, frame.bounds, `${frame.name} (unavailable)`);
          continue;
        }
        if (node === undefined) {
          void store.load([frame.id]);
          drawPlaceholder(ctx, frame.bounds, frame.name);
          continue;
        }
        renderer.draw(ctx, node, {
          scale: zoom * dpr,
          viewport,
          imageForRef: assets.imageForRef,
          fallbackForNode: assets.fallbackForNode,
          fontAvailable: assets.fontAvailable,
          onMissing: assets.onMissing,
          overrides: overridesRef.current,
        });
      }
      if (selectedNodeId) drawSelectionBox(ctx, store, selectedNodeId);
    } finally {
      assets.endDraw();
    }
  }, [assets, page, renderer, selectedNodeId, size.height, size.width, store, visible]);

  useEffect(() => {
    if (!isWeb) return;
    const frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [paint, tick]);

  // ── DOM input handlers (web only, attached to the host View's div) ───────────────
  const hostRef = useRef<HTMLElement | null>(null);
  const handlers = useRef({ selectAt, onCamera });
  handlers.current = { selectAt, onCamera };
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
      if (event.button !== 0) return;
      const state = interaction.current;
      state.dragging = true;
      state.movedPx = 0;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      const state = interaction.current;
      if (!state.dragging) return;
      const dx = event.clientX - state.lastX;
      const dy = event.clientY - state.lastY;
      state.lastX = event.clientX;
      state.lastY = event.clientY;
      state.movedPx += Math.abs(dx) + Math.abs(dy);
      if (dx !== 0 || dy !== 0) handlers.current.onCamera(panBy(cameraRef.current, dx, dy));
    };
    const onPointerUp = (event: PointerEvent) => {
      const state = interaction.current;
      const click = state.dragging && state.movedPx <= 4;
      state.dragging = false;
      canvas.releasePointerCapture?.(event.pointerId);
      if (click) handlers.current.selectAt(cursorOf(event));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    return () => {
      canvas.remove();
    };
  }, []);

  const onLayout = useCallback((event: { nativeEvent: { layout: Size } }) => {
    setSize({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height });
  }, []);

  if (!isWeb) {
    return (
      <View style={styles.fill} onLayout={onLayout} testID="figma-canvas">
        <NativeCanvasLayer
          serverId={serverId}
          fileKey={fileKey}
          version={version}
          visible={visible}
          camera={camera}
          selectedNodeId={selectedNodeId}
          onSelectNode={onSelectNode}
          onCamera={onCamera}
          paper={page?.backgroundColor}
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
 * frame scrolled back into view is requested again.
 */
function mergeRasterBatch(
  current: Record<string, string>,
  batch: readonly string[],
  images: Record<string, FigmaBytes | null>,
  visibleIds: readonly string[],
  ledger: Set<string>,
): Record<string, string> {
  const next = { ...current };
  for (const id of batch) {
    const bytes = images[id];
    // Null entries are the wire's "this id got no raster" marker: no tile, id stays pruned
    // from the caller's view of `next` and the ledger lets a re-exposure request it again.
    if (bytes) next[id] = `data:${bytes.mimeType};base64,${bytes.dataBase64}`;
  }
  // Bound the cache at arrival time, not render time: panning across a 500-frame page
  // otherwise keeps every tile's base64 payload for the whole session.
  const pruned = pruneRasterCache(next, visibleIds);
  for (const id of pruned.dropped) ledger.delete(id);
  return pruned.rasters;
}

/** Native (spec 32.5 mobile): same camera math, rasters + pinch/pan through PanResponder. */
export function NativeCanvasLayer(props: {
  serverId: string;
  fileKey: string;
  version: string | null;
  visible: readonly SectionAwareSummary[];
  camera: Camera;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string | null) => void;
  onCamera: (next: Camera) => void;
  paper?: string;
}) {
  const { visible, camera, fileKey, version, onCamera, onSelectNode, selectedNodeId } = props;
  const client = useHostRuntimeClient(props.serverId);
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
    visibleIdsRef.current = detailIds;
    if (!client) return;
    const missing = detailIds.filter((id) => !requested.current.has(id));
    if (missing.length === 0) return;
    for (const id of missing) requested.current.add(id);
    for (let i = 0; i < missing.length; i += 20) {
      const batch = missing.slice(i, i + 20);
      void callFigma(client, "figma.file.render.request", {
        fileKey,
        ids: batch,
        scale: 2,
        ...(version ? { version } : {}),
      })
        .then((data) =>
          setRasters((current) => {
            // A response that crossed a server/file/version switch belongs to the old scope;
            // the new scope's effect already re-requested these ids, so drop the stale payload.
            if (rasterScope.current !== scope) return current;
            return mergeRasterBatch(
              current,
              batch,
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
          for (const id of batch) requested.current.delete(id);
        });
    }
  }, [client, props.serverId, fileKey, version, visible, camera]);

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
        const uri = rasters[frame.id];
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
}));
