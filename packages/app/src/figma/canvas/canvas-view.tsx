import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, PanResponder, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { FigmaNode, FigmaPage } from "@jagentdesk/protocol/figma/rpc-schemas";
import { isWeb } from "@/constants/platform";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createFigmaRenderer } from "@/figma/renderer";
import { callFigma } from "./api";
import type { FrameStore } from "./frame-store";
import { useFigmaAssets } from "./use-figma-assets";
import {
  type Camera,
  type Point,
  figmaToScreen,
  framesInViewport,
  lodMode,
  panBy,
  screenToFigma,
  visibleRect,
  zoomAroundPoint,
} from "./viewport";

// The canvas viewer (spec 32.5.1). Web/Electron draw into one HTML canvas with a
// devicePixelRatio-backed store: drag or two-finger wheel pans, ctrl/cmd-wheel or pinch zooms
// around the cursor, and a click without movement runs the renderer's hitTest. Frames entering
// the viewport are requested through `figma.file.nodes` lazily (FrameStore batches ≤ 50 ids,
// LRU-caps the subtrees). Below THUMBNAIL_ZOOM the viewer swaps to cached raster thumbnails from
// figma.file.render so thousand-frame files stay smooth; above it the renderer draws vectors,
// pulling image fills, fallback rasters and fonts through the asset caches. Mobile shares the
// camera math and shows frame rasters with pinch/pan and frame-level tap selection.

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

  // ── lazy loading: frames that scroll in get their subtree requested once ──────────
  const visible = useMemo(() => {
    if (!page || size.width === 0 || size.height === 0) return [];
    return framesInViewport(page.frames, camera, size.width, size.height, 120);
  }, [page, camera, size]);
  const visibleKey = visible.map((frame) => frame.id).join(",");
  useEffect(() => {
    if (!store || visibleKey.length === 0) return;
    void store.load(visibleKey.split(","));
  }, [store, visibleKey]);

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
      const candidates = framesInViewport(page.frames, cameraRef.current, size.width, size.height);
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const frame = candidates[i];
        if (!frame) continue;
        const root = store.get(frame.id);
        if (!root) continue;
        const hit = renderer.hitTest(root, cursor);
        if (hit) {
          onSelectNode(hit.id);
          return;
        }
      }
      onSelectNode(null);
    },
    [onSelectNode, page, renderer, size.height, size.width, store],
  );

  // ── painting (web/Electron) ───────────────────────────────────────────────────────
  const paint = useCallback(() => {
    if (!isWeb || typeof document === "undefined") return;
    const canvas = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
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

const CANVAS_ID = "jagentdesk-figma-canvas";

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

/** Native (spec 32.5 mobile): same camera math, rasters + pinch/pan through PanResponder. */
function NativeCanvasLayer(props: {
  serverId: string;
  fileKey: string;
  version: string | null;
  visible: ReturnType<typeof framesInViewport>;
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
  useEffect(() => {
    if (!client) return;
    const missing = visible.map((frame) => frame.id).filter((id) => !requested.current.has(id));
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
            const next = { ...current };
            for (const id of batch) {
              const bytes = data.images[id];
              if (bytes) next[id] = `data:${bytes.mimeType};base64,${bytes.dataBase64}`;
            }
            return next;
          }),
        )
        .catch(() => {
          for (const id of batch) requested.current.delete(id);
        });
    }
  }, [client, fileKey, version, visible]);

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
        const frame = visible.find((candidate) => {
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
