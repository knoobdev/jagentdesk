import { useEffect, useMemo, useRef, type ComponentRef, type ReactNode } from "react";
import { View } from "react-native";

import { ScrollView } from "@/components/ui/scroll-view";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaFileRef } from "@/figma/contracts";
import { FrameContent } from "./frame-content";
import {
  computeFitScale,
  contentBounds,
  findNodeById,
  nodeBounds,
  type Rect,
} from "./node-geometry";

// The player's viewport for one frame (spec 32.5.3): fit the frame into the given box, and
// when its content extends past the frame — the usual case for scrolling screens — make the
// overflowing axes scrollable. `renderOverlay` draws in stage space on top of the frame
// (hotspots, guides), with `boxOf` mapping any node to its css-pixel box.

export interface StageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageSpace {
  /** device pixels per Figma unit for this stage */
  scale: number;
  /** css-pixel box of a node relative to the stage origin, or null without bounds */
  boxOf: (node: FigmaNode) => StageBox | null;
}

export interface FrameStageProps {
  file: FigmaFileRef;
  root: FigmaNode;
  /** box the frame is fitted into */
  width: number;
  height: number;
  /** per-node paint overrides, keyed by node id (smart animate morphs, fades) */
  overrides?: Record<string, Partial<FigmaNode>>;
  scroll?: boolean;
  /** scroll this node into view when it changes */
  scrollToContentNodeId?: string | null;
  renderOverlay?: (space: StageSpace) => ReactNode;
}

const CENTER_STYLE = { alignItems: "center", justifyContent: "center" } as const;

export function FrameStage(props: FrameStageProps) {
  const frame = nodeBounds(props.root);
  return frame ? <FrameStageInner {...props} frame={frame} /> : null;
}

function FrameStageInner({
  file,
  root,
  width,
  height,
  overrides,
  scroll = true,
  scrollToContentNodeId,
  renderOverlay,
  frame,
}: FrameStageProps & { frame: Rect }) {
  const scrollRef = useRef<ComponentRef<typeof ScrollView> | null>(null);
  const scale = computeFitScale(frame, { width, height });

  // Content extent in frame-local units, grown past the frame's own edges when needed.
  const extent = useMemo(() => {
    const content = contentBounds(root);
    if (!content) return null;
    return {
      left: Math.min(0, content.x - frame.x),
      top: Math.min(0, content.y - frame.y),
      right: Math.max(frame.width, content.x - frame.x + content.width),
      bottom: Math.max(frame.height, content.y - frame.y + content.height),
    };
  }, [frame, root]);

  const overflowX = extent ? extent.left < 0 || extent.right > frame.width : false;
  const overflowY = extent ? extent.top < 0 || extent.bottom > frame.height : false;
  const canvasWidth = Math.max(frame.width, extent ? extent.right : 0) * scale;
  const canvasHeight = Math.max(frame.height, extent ? extent.bottom : 0) * scale;

  useEffect(() => {
    const target = scrollRef.current;
    if (!scrollToContentNodeId || !target || (!overflowX && !overflowY)) return;
    const node = findNodeById(root, scrollToContentNodeId);
    const bounds = node ? nodeBounds(node) : null;
    if (!bounds) return;
    target.scrollTo({
      x: overflowX ? Math.max(0, (bounds.x - frame.x) * scale) : 0,
      y: overflowY ? Math.max(0, (bounds.y - frame.y) * scale) : 0,
      animated: true,
    });
  }, [scrollToContentNodeId, scale, overflowX, overflowY, frame, root]);

  const stageStyle = useMemo(
    () => ({ width: canvasWidth, height: canvasHeight }),
    [canvasWidth, canvasHeight],
  );
  const boxStyle = useMemo(() => ({ width, height, ...CENTER_STYLE }), [width, height]);
  const scrollStyle = useMemo(
    () => ({ width: Math.min(canvasWidth, width), height: Math.min(canvasHeight, height) }),
    [canvasWidth, canvasHeight, width, height],
  );

  const space: StageSpace = useMemo(
    () => ({
      scale,
      boxOf: (node: FigmaNode) => {
        const bounds = nodeBounds(node);
        return bounds ? toStageBox(bounds, frame, scale) : null;
      },
    }),
    [scale, frame],
  );

  if (scale <= 0) return null;

  const overlay = renderOverlay ? renderOverlay(space) : null;
  const stage = (
    <View style={stageStyle}>
      <FrameContent file={file} root={root} scale={scale} overrides={overrides} />
      {overlay}
    </View>
  );
  const scrollable = scroll && (overflowX || overflowY);

  return (
    <View style={boxStyle}>
      {scrollable ? (
        <ScrollView
          ref={scrollRef}
          style={scrollStyle}
          horizontal={overflowX && !overflowY}
          scrollEnabled
          showsHorizontalScrollIndicator={overflowX}
          showsVerticalScrollIndicator={overflowY}
        >
          {stage}
        </ScrollView>
      ) : (
        stage
      )}
    </View>
  );
}

function toStageBox(bounds: Rect, frame: Rect, scale: number): StageBox {
  return {
    x: (bounds.x - frame.x) * scale,
    y: (bounds.y - frame.y) * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
}
