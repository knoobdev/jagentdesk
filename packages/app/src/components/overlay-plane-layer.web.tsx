import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import { createPortal } from "react-dom";
import { getOverlayRoot } from "@/lib/overlay-root";

interface OverlayPlaneLayerProps {
  /** Where the layer sits in its parent, as for an absolutely positioned view. */
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Renders `children` at the bounds `style` gives inside the parent, but in the overlay plane.
 * Agentic browser pages paint on the resident browser plane above the app's DOM
 * (`desktop/browser/resident-webviews.ts`); controls drawn over a page, or a resize handle on a
 * page's edge, go here so the page does not cover them.
 */
export function OverlayPlaneLayer({ style, children }: OverlayPlaneLayerProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const setAnchorNode = useCallback((node: unknown) => {
    setAnchor(node instanceof HTMLElement ? node : null);
  }, []);

  useLayoutEffect(() => {
    if (!anchor) {
      setBounds(null);
      return;
    }
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setBounds((current) =>
        current &&
        current.left === rect.left &&
        current.top === rect.top &&
        current.width === rect.width &&
        current.height === rect.height
          ? current
          : { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      );
    };
    update();
    // The parent resizing moves an anchor of constant size (an edge handle).
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [anchor]);

  const layerStyle = useMemo(() => [styles.layer, bounds], [bounds]);
  const visible = bounds !== null && bounds.width > 0 && bounds.height > 0;
  return (
    <>
      <View ref={setAnchorNode} style={style} pointerEvents="none" />
      {visible
        ? createPortal(
            <View style={layerStyle} pointerEvents="box-none">
              {children}
            </View>,
            getOverlayRoot(),
          )
        : null}
    </>
  );
}

const styles = {
  layer: { position: "absolute", overflow: "visible" },
} satisfies Record<string, ViewStyle>;
