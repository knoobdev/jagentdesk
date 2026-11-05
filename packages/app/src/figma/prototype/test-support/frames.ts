import type {
  FigmaFrameSummary,
  FigmaInteraction,
  FigmaNode,
  FigmaOutline,
  FigmaPage,
  FigmaPrototype,
} from "@jagentdesk/protocol/figma/rpc-schemas";

export interface NodeSpec {
  id: string;
  name: string;
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Solid fill as Figma floats 0–1; omit for no fill. */
  color?: [number, number, number, number];
  opacity?: number;
  cornerRadius?: number;
  visible?: boolean;
  overflowDirection?: string;
  children?: FigmaNode[];
}

export function node(spec: NodeSpec): FigmaNode {
  const built: FigmaNode = {
    id: spec.id,
    name: spec.name,
    type: spec.type ?? "FRAME",
  };
  built.absoluteBoundingBox = {
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    width: spec.width ?? 100,
    height: spec.height ?? 100,
  };
  if (spec.color) {
    const [r, g, b, a] = spec.color;
    built.fills = [{ type: "SOLID", color: { r, g, b, a } }];
  }
  if (spec.opacity !== undefined) built.opacity = spec.opacity;
  if (spec.cornerRadius !== undefined) built.cornerRadius = spec.cornerRadius;
  if (spec.visible !== undefined) built.visible = spec.visible;
  if (spec.overflowDirection) built.overflowDirection = spec.overflowDirection;
  if (spec.children) built.children = spec.children;
  return built;
}

/** Two frames sharing a card header + button by name path, for smart-animate matching. */
export function smartAnimatePair(): { from: FigmaNode; to: FigmaNode } {
  const from = node({
    id: "1:1",
    name: "A",
    x: 0,
    y: 0,
    width: 300,
    height: 400,
    color: [1, 1, 1, 1],
    children: [
      node({
        id: "1:2",
        name: "Card",
        type: "GROUP",
        x: 20,
        y: 20,
        width: 260,
        height: 120,
        children: [
          node({
            id: "1:3",
            name: "Title",
            type: "TEXT",
            x: 30,
            y: 30,
            width: 240,
            height: 24,
            color: [0, 0, 0, 1],
          }),
          node({
            id: "1:4",
            name: "Button",
            type: "RECTANGLE",
            x: 30,
            y: 90,
            width: 100,
            height: 40,
            color: [0, 0, 1, 1],
            cornerRadius: 4,
            opacity: 1,
          }),
        ],
      }),
      node({
        id: "1:5",
        name: "Only In A",
        type: "RECTANGLE",
        x: 0,
        y: 380,
        width: 60,
        height: 20,
      }),
    ],
  });
  const to = node({
    id: "2:1",
    name: "B",
    x: 500,
    y: 0,
    width: 300,
    height: 400,
    color: [1, 1, 1, 1],
    children: [
      node({
        id: "2:2",
        name: "Card",
        type: "GROUP",
        x: 520,
        y: 60,
        width: 260,
        height: 200,
        children: [
          node({
            id: "2:3",
            name: "Title",
            type: "TEXT",
            x: 530,
            y: 110,
            width: 240,
            height: 24,
            color: [0, 0, 0, 1],
          }),
          node({
            id: "2:4",
            name: "Button",
            type: "RECTANGLE",
            x: 530,
            y: 190,
            width: 200,
            height: 40,
            color: [1, 0, 0, 1],
            cornerRadius: 20,
            opacity: 0.5,
          }),
        ],
      }),
      node({
        id: "2:6",
        name: "Only In B",
        type: "RECTANGLE",
        x: 500,
        y: 380,
        width: 60,
        height: 20,
      }),
    ],
  });
  return { from, to };
}

/** A frame with a button (click → B, hover → C), a press hotspot, and a timeout hop. */
export function hotspotFrame(): FigmaNode {
  return node({
    id: "10:1",
    name: "Home",
    x: 0,
    y: 0,
    width: 375,
    height: 600,
    color: [1, 1, 1, 1],
    children: [
      node({
        id: "10:2",
        name: "Open detail",
        type: "RECTANGLE",
        x: 20,
        y: 100,
        width: 120,
        height: 44,
      }),
      node({ id: "10:3", name: "Peek", type: "RECTANGLE", x: 20, y: 200, width: 80, height: 30 }),
      node({ id: "10:4", name: "Hold", type: "RECTANGLE", x: 20, y: 300, width: 80, height: 30 }),
      node({
        id: "10:5",
        name: "Auto",
        type: "FRAME",
        x: 0,
        y: 0,
        width: 375,
        height: 600,
        visible: false,
      }),
    ],
  });
}

export function scrollFrame(): FigmaNode {
  return node({
    id: "11:1",
    name: "Long",
    x: 0,
    y: 0,
    width: 375,
    height: 600,
    overflowDirection: "VERTICAL",
    children: [
      node({
        id: "11:2",
        name: "Bottom",
        type: "RECTANGLE",
        x: 0,
        y: 540,
        width: 375,
        height: 200,
      }),
    ],
  });
}

export function interaction(
  nodeId: string,
  trigger: { type: string; delayMs?: number },
  action: FigmaInteraction["action"],
): FigmaInteraction {
  return { nodeId, trigger, action };
}

export const NAVIGATE_B: FigmaInteraction["action"] = {
  type: "NODE",
  navigation: "NAVIGATE",
  destinationId: "2:1",
};

export function frameSummary(id: string, name: string, x = 0, y = 0): FigmaFrameSummary {
  return { id, name, type: "FRAME", bounds: { x, y, width: 375, height: 600 } };
}

export function page(spec: Partial<FigmaPage> & { id: string; name: string }): FigmaPage {
  return { backgroundColor: undefined, frames: [], flowStartingPoints: [], ...spec };
}

export function outline(pages: FigmaPage[]): FigmaOutline {
  return {
    fileKey: "file-1",
    name: "Mobile App",
    version: "v1",
    lastModified_ms: 1_700_000_000_000,
    editorType: "figma",
    pages,
    source: "rest",
  };
}

export function flow(nodeId: string, name: string, pageId = "p1"): FigmaPrototype["flows"][number] {
  return { nodeId, name, pageId };
}
