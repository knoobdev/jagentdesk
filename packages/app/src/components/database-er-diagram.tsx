import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { G, Line, Rect, Text as SvgText } from "react-native-svg";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Maximize2, ZoomIn, ZoomOut } from "lucide-react-native";
import type { DbColumn, DbForeignKey, DbObject } from "@jagentdesk/protocol/database/rpc-schemas";
import { isNative, isWeb } from "@/constants/platform";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDatabaseNavStore } from "@/stores/database-nav-store";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { Theme } from "@/styles/theme";

// Theme-token hex — SVG props take color strings (matches the dark design system).
const BOX_FILL = "#1E2120";
const HEADER_FILL = "#20744A";
const BOX_STROKE = "#252B2A";
const ROW_SEP = "#252B2A";
const EDGE = "#7ccba0";
const TEXT = "#fafafa";
const TEXT_MUTED = "#A1A5A4";
const PK_COLOR = "#e3b341";
const FK_COLOR = "#7ccba0";

const BOX_W = 240;
const HEADER_H = 30;
const ROW_H = 20;
const PAD = 28;
const GAP_X = 72;
const GAP_Y = 40;
const MAX_ROWS = 16;
const MAX_COLS = 5;

// Zoom bounds — matches the mermaid diagram host's lower clamp; capped at 3x.
const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const ZOOM_STEP = 1.2;
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

const ThemedSpinner = withUnistyles(LoadingSpinner);
const ThemedZoomIn = withUnistyles(ZoomIn);
const ThemedZoomOut = withUnistyles(ZoomOut);
const ThemedZoomReset = withUnistyles(Maximize2);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type DbClientLike = NonNullable<ReturnType<typeof useHostRuntimeClient>>;

/** Fetch one table's columns (kept out of the effect to bound callback nesting). */
async function loadColumns(
  client: DbClientLike,
  databaseId: string,
  schema: string,
  table: string,
): Promise<readonly [string, DbColumn[]]> {
  const res = await client.databaseColumns({ id: databaseId, schema, table }).catch(() => null);
  return [table, res && !res.error ? res.columns : []] as const;
}

function keyMarker(c: DbColumn): { text: string; color: string } {
  if (c.isPrimaryKey) return { text: "PK", color: PK_COLOR };
  if (c.isForeignKey) return { text: "FK", color: FK_COLOR };
  return { text: "", color: FK_COLOR };
}

interface TableBox {
  name: string;
  columns: DbColumn[];
  shown: DbColumn[];
  x: number;
  y: number;
  h: number;
  rowIndex: Map<string, number>;
}

/** Live position of a card in world (diagram) coordinates. */
interface Pos {
  x: number;
  y: number;
}

/** Viewport transform applied to the whole canvas: pan (tx,ty px) + zoom (scale). */
interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}

/** In-flight drag: either panning the canvas or moving one card. */
type DragState =
  | { mode: "pan"; startTx: number; startTy: number; startCX: number; startCY: number }
  | { mode: "card"; name: string; startPos: Pos; startCX: number; startCY: number };

/**
 * A DataGrip-style entity-relationship diagram on an interactive canvas: each
 * table is a draggable card listing its columns (with PK/FK markers + type),
 * foreign keys drawn as edges from the FK column's row to the referenced table's
 * header. A viewport transform ({tx,ty,scale}) applied to an inner <G> gives pan
 * + zoom; the container clips. Universal (react-native-svg → desktop + mobile):
 * web uses pointer events + wheel-to-zoom, native uses gesture-handler.
 */
export function DatabaseErDiagram({
  serverId,
  databaseId,
}: {
  serverId: string;
  databaseId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const selectedSchema = useDatabaseNavStore((s) => s.selectedSchema);
  const [objects, setObjects] = useState<DbObject[]>([]);
  const [fks, setFks] = useState<DbForeignKey[]>([]);
  const [columnsByTable, setColumnsByTable] = useState<Record<string, DbColumn[]>>({});
  const [loading, setLoading] = useState(true);
  const schema = selectedSchema ?? "public";

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const [objRes, fkRes] = await Promise.all([
        client.databaseObjects({ id: databaseId, schema }).catch(() => null),
        client.databaseForeignKeys({ id: databaseId, schema }).catch(() => null),
      ]);
      if (cancelled) return;
      const tables =
        objRes && !objRes.error ? objRes.objects.filter((o) => o.kind === "table") : [];
      setObjects(tables);
      if (fkRes && !fkRes.error) setFks(fkRes.foreignKeys);
      // Fetch each table's columns in parallel so boxes can list their fields.
      const entries = await Promise.all(
        tables.map((t) => loadColumns(client, databaseId, schema, t.name)),
      );
      if (cancelled) return;
      setColumnsByTable(Object.fromEntries(entries));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [client, databaseId, schema]);

  const layout = useMemo(() => {
    const tables = objects;
    if (tables.length === 0) return { boxes: [], byName: new Map<string, TableBox>() };
    const cols = Math.max(1, Math.min(MAX_COLS, Math.ceil(Math.sqrt(tables.length))));
    const colHeights = Array.from({ length: cols }, () => PAD);
    const boxes: TableBox[] = [];
    const byName = new Map<string, TableBox>();
    for (const t of tables) {
      const columns = columnsByTable[t.name] ?? [];
      const shown = columns.slice(0, MAX_ROWS);
      const rowIndex = new Map<string, number>();
      shown.forEach((c, i) => rowIndex.set(c.name, i));
      const h =
        HEADER_H + Math.max(shown.length, 1) * ROW_H + (columns.length > MAX_ROWS ? ROW_H : 0);
      // Bin-pack into the shortest column for a compact starting layout.
      let col = 0;
      for (let i = 1; i < cols; i++) if (colHeights[i] < colHeights[col]) col = i;
      const x = PAD + col * (BOX_W + GAP_X);
      const y = colHeights[col];
      colHeights[col] = y + h + GAP_Y;
      const box: TableBox = { name: t.name, columns, shown, x, y, h, rowIndex };
      boxes.push(box);
      byName.set(t.name, box);
    }
    return { boxes, byName };
  }, [objects, columnsByTable]);

  // Per-table live positions, seeded from the bin-pack layout. When the layout
  // recomputes (schema change, columns loaded), non-moved cards snap to the new
  // auto-layout; cards the user has dragged keep their placement (movedRef).
  const [positions, setPositions] = useState<Record<string, Pos>>({});
  const movedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    setPositions((prev) => {
      const next: Record<string, Pos> = {};
      for (const b of layout.boxes) {
        const kept = movedRef.current.has(b.name) ? prev[b.name] : undefined;
        next[b.name] = kept ?? { x: b.x, y: b.y };
      }
      // Drop moved-flags for tables no longer present.
      for (const name of movedRef.current)
        if (!layout.byName.has(name)) movedRef.current.delete(name);
      return next;
    });
  }, [layout]);

  const posOf = useCallback(
    (b: TableBox): Pos => positions[b.name] ?? { x: b.x, y: b.y },
    [positions],
  );

  const edges = useMemo(() => {
    const out: Array<{ key: string; x1: number; y1: number; x2: number; y2: number }> = [];
    for (const fk of fks) {
      const src = layout.byName.get(fk.table);
      const dst = layout.byName.get(fk.refTable);
      if (!src || !dst || src === dst) continue;
      const sp = positions[src.name] ?? { x: src.x, y: src.y };
      const dp = positions[dst.name] ?? { x: dst.x, y: dst.y };
      const ri = src.rowIndex.get(fk.column);
      const y1 = ri === undefined ? sp.y + HEADER_H / 2 : sp.y + HEADER_H + ri * ROW_H + ROW_H / 2;
      // Exit from whichever side faces the target.
      const srcRight = dp.x >= sp.x;
      const x1 = srcRight ? sp.x + BOX_W : sp.x;
      const x2 = srcRight ? dp.x : dp.x + BOX_W;
      const y2 = dp.y + HEADER_H / 2;
      out.push({ key: `${fk.table}.${fk.column}->${fk.refTable}`, x1, y1, x2, y2 });
    }
    return out;
  }, [fks, layout, positions]);

  // ---- Viewport transform + shared drag state ----------------------------
  const [viewport, setViewport] = useState<Viewport>({ tx: 0, ty: 0, scale: 1 });
  // Refs mirror the latest state so DOM/UI-thread handlers read current values
  // without re-subscribing.
  const viewportRef = useRef(viewport);
  const positionsRef = useRef(positions);
  const boxesRef = useRef(layout.boxes);
  const dragRef = useRef<DragState | null>(null);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  useEffect(() => {
    positionsRef.current = positions;
  }, [positions]);
  useEffect(() => {
    boxesRef.current = layout.boxes;
  }, [layout]);

  // Hit-test container-relative pixel point (cx,cy) against the cards, topmost
  // first (render order last = on top). Returns the box under the point or null.
  const hitTest = useCallback((cx: number, cy: number): TableBox | null => {
    const v = viewportRef.current;
    const wx = (cx - v.tx) / v.scale;
    const wy = (cy - v.ty) / v.scale;
    const boxes = boxesRef.current;
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      const p = positionsRef.current[b.name] ?? { x: b.x, y: b.y };
      if (wx >= p.x && wx <= p.x + BOX_W && wy >= p.y && wy <= p.y + b.h) return b;
    }
    return null;
  }, []);

  // Begin a drag at container-relative pixel (cx,cy): a card if one is hit, else
  // a background pan.
  const beginDrag = useCallback(
    (cx: number, cy: number) => {
      const box = hitTest(cx, cy);
      if (box) {
        const p = positionsRef.current[box.name] ?? { x: box.x, y: box.y };
        dragRef.current = { mode: "card", name: box.name, startPos: p, startCX: cx, startCY: cy };
      } else {
        const v = viewportRef.current;
        dragRef.current = { mode: "pan", startTx: v.tx, startTy: v.ty, startCX: cx, startCY: cy };
      }
    },
    [hitTest],
  );

  // Continue the active drag to container-relative pixel (cx,cy).
  const moveDrag = useCallback((cx: number, cy: number) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === "card") {
      const scale = viewportRef.current.scale;
      const nx = d.startPos.x + (cx - d.startCX) / scale;
      const ny = d.startPos.y + (cy - d.startCY) / scale;
      movedRef.current.add(d.name);
      setPositions((prev) => ({ ...prev, [d.name]: { x: nx, y: ny } }));
    } else {
      setViewport((prev) => ({
        ...prev,
        tx: d.startTx + (cx - d.startCX),
        ty: d.startTy + (cy - d.startCY),
      }));
    }
  }, []);

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Zoom keeping the world point under (cx,cy) fixed: t' = c - (c - t)·(new/old).
  const zoomAt = useCallback((factor: number, cx: number, cy: number) => {
    setViewport((v) => {
      const scale = clampScale(v.scale * factor);
      const k = scale / v.scale;
      return { tx: cx - (cx - v.tx) * k, ty: cy - (cy - v.ty) * k, scale };
    });
  }, []);

  // ---- Web: wheel-to-zoom + pointer pan/drag -----------------------------
  // The canvas only mounts once data is ready (loading/empty return early), so the
  // pointer/wheel effect keys off this to attach after the node exists.
  const ready = !loading && layout.boxes.length > 0;
  const canvasRef = useRef<View | null>(null);
  useEffect(() => {
    if (!isWeb) return;
    const raw: unknown = canvasRef.current;
    if (!(raw instanceof HTMLElement)) return;
    const node = raw;
    // Suppress native scroll/selection so drags and wheel-zoom feel like a canvas.
    node.style.touchAction = "none";
    node.style.userSelect = "none";

    // Plain wheel zooms centered on the cursor (trackpad pinch reports ctrlKey —
    // same behavior). No modifier required.
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * 0.0015), event.clientX - rect.left, event.clientY - rect.top);
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const rect = node.getBoundingClientRect();
      beginDrag(event.clientX - rect.left, event.clientY - rect.top);
      node.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    };
    const onMove = (event: PointerEvent) => {
      if (!dragRef.current) return;
      const rect = node.getBoundingClientRect();
      moveDrag(event.clientX - rect.left, event.clientY - rect.top);
    };
    const onUp = (event: PointerEvent) => {
      if (!dragRef.current) return;
      endDrag();
      node.releasePointerCapture?.(event.pointerId);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("pointerdown", onDown);
    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerup", onUp);
    node.addEventListener("pointercancel", onUp);
    return () => {
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", onDown);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerup", onUp);
      node.removeEventListener("pointercancel", onUp);
    };
    // `ready` re-runs this once the canvas node actually mounts — the loading/empty
    // early-returns mean canvasRef is null on the first pass, and the handler
    // callbacks are otherwise stable, so without it the listeners never attach.
  }, [beginDrag, moveDrag, endDrag, zoomAt, ready]);

  // ---- Native: pinch to zoom + one-finger pan/card-drag ------------------
  const pinchBaseRef = useRef<Viewport>(viewport);
  const onPinchStart = useCallback(() => {
    pinchBaseRef.current = viewportRef.current;
  }, []);
  const onPinchUpdate = useCallback((factor: number, fx: number, fy: number) => {
    setViewport(() => {
      const base = pinchBaseRef.current;
      const scale = clampScale(base.scale * factor);
      const k = scale / base.scale;
      return { tx: fx - (fx - base.tx) * k, ty: fy - (fy - base.ty) * k, scale };
    });
  }, []);
  const gesture = useMemo(() => {
    const pinch = Gesture.Pinch()
      .onStart(() => runOnJS(onPinchStart)())
      .onUpdate((e) => runOnJS(onPinchUpdate)(e.scale, e.focalX, e.focalY));
    const pan = Gesture.Pan()
      .maxPointers(1)
      .onStart((e) => runOnJS(beginDrag)(e.x, e.y))
      .onUpdate((e) => runOnJS(moveDrag)(e.x, e.y))
      .onFinalize(() => runOnJS(endDrag)());
    return Gesture.Simultaneous(pinch, pan);
  }, [onPinchStart, onPinchUpdate, beginDrag, moveDrag, endDrag]);

  // ---- Zoom buttons (web only) — zoom about the canvas center ------------
  const centerOf = useCallback((): [number, number] => {
    const raw: unknown = canvasRef.current;
    if (raw instanceof HTMLElement) {
      const rect = raw.getBoundingClientRect();
      return [rect.width / 2, rect.height / 2];
    }
    return [0, 0];
  }, []);
  const zoomIn = useCallback(() => zoomAt(ZOOM_STEP, ...centerOf()), [zoomAt, centerOf]);
  const zoomOut = useCallback(() => zoomAt(1 / ZOOM_STEP, ...centerOf()), [zoomAt, centerOf]);
  const zoomReset = useCallback(() => setViewport({ tx: 0, ty: 0, scale: 1 }), []);

  if (loading) {
    return (
      <View style={styles.center}>
        <ThemedSpinner size="small" uniProps={mutedColor} />
      </View>
    );
  }
  if (layout.boxes.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>No tables in {schema} to diagram.</Text>
      </View>
    );
  }

  const transform = `translate(${viewport.tx} ${viewport.ty}) scale(${viewport.scale})`;
  const svg = (
    <Svg width="100%" height="100%">
      <G transform={transform}>
        {edges.map((e) => (
          <Line
            key={e.key}
            x1={e.x1}
            y1={e.y1}
            x2={e.x2}
            y2={e.y2}
            stroke={EDGE}
            strokeWidth={1.25}
            opacity={0.65}
          />
        ))}
        {layout.boxes.map((b) => {
          const p = posOf(b);
          return (
            <G key={b.name} transform={`translate(${p.x} ${p.y})`}>
              <TableCard box={b} />
            </G>
          );
        })}
      </G>
    </Svg>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.header}>
        ER diagram · {schema} · {layout.boxes.length} tables · {edges.length} relationships
      </Text>
      <View style={styles.canvas} ref={canvasRef}>
        {isNative ? <GestureDetector gesture={gesture}>{svg}</GestureDetector> : svg}
      </View>
      {isWeb ? (
        <View style={styles.zoomControls}>
          <Pressable
            style={styles.zoomBtn}
            onPress={zoomIn}
            accessibilityLabel="Zoom in"
            hitSlop={6}
          >
            <ThemedZoomIn size={16} uniProps={mutedColor} />
          </Pressable>
          <Pressable
            style={styles.zoomBtn}
            onPress={zoomOut}
            accessibilityLabel="Zoom out"
            hitSlop={6}
          >
            <ThemedZoomOut size={16} uniProps={mutedColor} />
          </Pressable>
          <Pressable
            style={styles.zoomBtn}
            onPress={zoomReset}
            accessibilityLabel="Reset zoom"
            hitSlop={6}
          >
            <ThemedZoomReset size={15} uniProps={mutedColor} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Renders one table card at the local origin (0,0); the caller translates it. */
function TableCard({ box }: { box: TableBox }) {
  const extra = box.columns.length - box.shown.length;
  return (
    <>
      <Rect
        x={0}
        y={0}
        width={BOX_W}
        height={box.h}
        rx={8}
        fill={BOX_FILL}
        stroke={BOX_STROKE}
        strokeWidth={1}
      />
      <Rect x={0} y={0} width={BOX_W} height={HEADER_H} rx={8} fill={HEADER_FILL} />
      {/* square off the header's bottom corners */}
      <Rect x={0} y={HEADER_H - 8} width={BOX_W} height={8} fill={HEADER_FILL} />
      <SvgText x={12} y={20} fill={TEXT} fontSize={13} fontWeight="600">
        {box.name.length > 28 ? `${box.name.slice(0, 27)}…` : box.name}
      </SvgText>
      {box.shown.map((c, i) => {
        const rowY = HEADER_H + i * ROW_H;
        const midY = rowY + ROW_H / 2 + 4;
        const marker = keyMarker(c);
        const nameColor = c.isPrimaryKey ? PK_COLOR : TEXT;
        return (
          <Fragment key={c.name}>
            {i > 0 ? (
              <Line x1={0} y1={rowY} x2={BOX_W} y2={rowY} stroke={ROW_SEP} strokeWidth={0.5} />
            ) : null}
            {marker.text ? (
              <SvgText x={10} y={midY} fill={marker.color} fontSize={9} fontWeight="700">
                {marker.text}
              </SvgText>
            ) : null}
            <SvgText x={34} y={midY} fill={nameColor} fontSize={11}>
              {c.name.length > 20 ? `${c.name.slice(0, 19)}…` : c.name}
            </SvgText>
            <SvgText x={BOX_W - 10} y={midY} fill={TEXT_MUTED} fontSize={10} textAnchor="end">
              {c.dataType.length > 14 ? `${c.dataType.slice(0, 13)}…` : c.dataType}
            </SvgText>
          </Fragment>
        );
      })}
      {extra > 0 ? (
        <SvgText
          x={12}
          y={HEADER_H + box.shown.length * ROW_H + 14}
          fill={TEXT_MUTED}
          fontSize={10}
          fontStyle="italic"
        >
          +{extra} more columns
        </SvgText>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  header: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  canvas: { flex: 1, minHeight: 0, overflow: "hidden" },
  zoomControls: {
    position: "absolute",
    right: theme.spacing[3],
    bottom: theme.spacing[3],
    flexDirection: "column",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  zoomBtn: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[4] },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
}));
