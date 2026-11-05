import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaFileRef } from "@/figma/contracts";
import { buildPaintPlan } from "./paint-plan";

// Native frame surface: the paint-plan renderer (solid boxes) until W9's Skia adapter lands.
// The web sibling (`frame-content.web.tsx`) draws through the renderer contract instead.

export interface FrameContentProps {
  file: FigmaFileRef;
  root: FigmaNode;
  /** Device pixels per Figma unit; the stage owns the outer fit mapping. */
  scale: number;
  overrides?: Record<string, Partial<FigmaNode>>;
}

const styles = StyleSheet.create({
  box: {
    position: "absolute",
  },
});

export function FrameContent({ root, scale, overrides }: FrameContentProps) {
  const boxes = buildPaintPlan(root, { overrides, scale });
  return (
    <>
      {boxes.map((box) => (
        <View
          key={box.id}
          style={[
            styles.box,
            {
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
              backgroundColor: box.color,
              opacity: box.opacity,
              borderRadius: box.cornerRadius,
            },
          ]}
        />
      ))}
    </>
  );
}
