import { useCallback, useMemo, useRef, useState } from "react";
import { type PointerEvent as RNPointerEvent, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";

// Shared drag-to-resize primitives for the Workbench splits. All panes (HTTP history detail, Target
// site map, the request/response message editor…) use these so a divider always behaves the same:
// a visible grip, the right cursor, and pointer capture so the drag keeps tracking even when the
// pointer leaves the thin handle. We use W3C Pointer Events because `event.currentTarget` is the real
// DOM node (a View ref under unistyles is not) and setPointerCapture is the robust cross-pane pattern.

type Axis = "x" | "y";

// `cursor`/`touchAction` are web-only style keys RN's ViewStyle types omit; merge them in as a plain
// object on web only.
function webResizeCursor(axis: Axis): object | null {
  if (!isWeb) return null;
  return { cursor: axis === "x" ? "col-resize" : "row-resize", touchAction: "none" } as object;
}

function attachDrag(
  event: RNPointerEvent,
  axis: Axis,
  onDelta: (deltaPx: number, containerPx: number) => void,
) {
  if (typeof window === "undefined") return;
  const handle = event.currentTarget as unknown as HTMLElement | null;
  const container = handle?.parentElement ?? null;
  const rect = container?.getBoundingClientRect();
  let containerPx = 0;
  if (rect) containerPx = axis === "x" ? rect.width : rect.height;
  const { pointerId } = event.nativeEvent;
  const start = axis === "x" ? event.nativeEvent.clientX : event.nativeEvent.clientY;
  event.preventDefault();
  event.stopPropagation();
  handle?.setPointerCapture?.(pointerId);

  const onMove = (move: PointerEvent) => {
    if (move.pointerId !== pointerId) return;
    move.preventDefault();
    const cur = axis === "x" ? move.clientX : move.clientY;
    onDelta(cur - start, containerPx);
  };
  const onUp = (up: PointerEvent) => {
    if (up.pointerId !== pointerId) return;
    if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

// Pixel-sized pane (a fixed-width sidebar, a fixed-height editor). `invert` flips the sign so a
// handle mounted at the top/left of the pane it resizes still grows the pane when dragged inward.
export function useDragSize(opts: {
  initial: number;
  min: number;
  max: number;
  axis: Axis;
  invert?: boolean;
}) {
  const { initial, min, max, axis, invert } = opts;
  const [size, setSize] = useState(initial);
  const ref = useRef(initial);
  const onPointerDown = useCallback(
    (event: RNPointerEvent) => {
      const startSize = ref.current;
      attachDrag(event, axis, (deltaPx) => {
        const raw = invert ? -deltaPx : deltaPx;
        const next = Math.max(min, Math.min(max, startSize + raw));
        ref.current = next;
        setSize(next);
      });
    },
    [axis, min, max, invert],
  );
  return { size, onPointerDown };
}

// Ratio split (two panes sharing the container, e.g. request | response). Returns the first pane's
// fraction 0..1; feed it to flexGrow with flexBasis:0 on both panes.
export function useSplitRatio(opts: { initial: number; min: number; max: number; axis: Axis }) {
  const { initial, min, max, axis } = opts;
  const [ratio, setRatio] = useState(initial);
  const ref = useRef(initial);
  const onPointerDown = useCallback(
    (event: RNPointerEvent) => {
      const startRatio = ref.current;
      attachDrag(event, axis, (deltaPx, containerPx) => {
        if (containerPx <= 0) return;
        const next = Math.max(min, Math.min(max, startRatio + deltaPx / containerPx));
        ref.current = next;
        setRatio(next);
      });
    },
    [axis, min, max],
  );
  return { ratio, onPointerDown };
}

export function WbSplitBar({
  axis,
  onPointerDown,
}: {
  axis: Axis;
  onPointerDown: (event: RNPointerEvent) => void;
}) {
  const barStyle = useMemo(
    () => [axis === "x" ? styles.barX : styles.barY, webResizeCursor(axis)],
    [axis],
  );
  return (
    <View
      role="separator"
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      style={barStyle}
      onPointerDown={onPointerDown}
    >
      <View style={axis === "x" ? styles.gripX : styles.gripY} />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  barX: {
    width: 8,
    alignSelf: "stretch",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  barY: {
    height: 10,
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  gripX: {
    width: 3,
    height: 36,
    borderRadius: 2,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.5,
  },
  gripY: {
    width: 36,
    height: 3,
    borderRadius: 2,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.5,
  },
}));
