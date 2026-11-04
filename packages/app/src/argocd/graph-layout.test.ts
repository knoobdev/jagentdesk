import { describe, expect, it } from "vitest";
import {
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  GRAPH_PADDING,
  layoutResourceGraph,
  type GraphNodePlacement,
} from "./graph-layout";

const children = new Map<string, readonly string[]>([
  ["app", ["svc", "deploy", "cm"]],
  ["svc", ["slice"]],
  ["deploy", ["rs"]],
  ["rs", ["pod-a", "pod-b", "pod-c"]],
]);
const edges = [
  { from: "app", to: "svc" },
  { from: "app", to: "deploy" },
  { from: "app", to: "cm" },
  { from: "svc", to: "slice" },
  { from: "deploy", to: "rs" },
  { from: "rs", to: "pod-a" },
  { from: "rs", to: "pod-b" },
  { from: "rs", to: "pod-c" },
];

function overlaps(a: GraphNodePlacement, b: GraphNodePlacement): boolean {
  const apart =
    a.x + GRAPH_NODE_WIDTH <= b.x ||
    b.x + GRAPH_NODE_WIDTH <= a.x ||
    a.y + GRAPH_NODE_HEIGHT <= b.y ||
    b.y + GRAPH_NODE_HEIGHT <= a.y;
  return !apart;
}

describe("layoutResourceGraph", () => {
  const layout = layoutResourceGraph({ rootId: "app", children, edges });
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));

  it("puts the app at the left and every child in a column to the right of its owner", () => {
    expect(byId.get("app")).toMatchObject({ depth: 0, x: GRAPH_PADDING });
    for (const edge of edges) {
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      expect(from && to && to.x > from.x + GRAPH_NODE_WIDTH).toBe(true);
    }
  });

  it("never overlaps two cards", () => {
    for (const a of layout.nodes) {
      for (const b of layout.nodes) {
        if (a.id !== b.id) expect(overlaps(a, b)).toBe(false);
      }
    }
  });

  it("centres an owner on its children", () => {
    const pods = ["pod-a", "pod-b", "pod-c"].map((id) => byId.get(id)?.y ?? Number.NaN);
    expect(byId.get("rs")?.y).toBe(pods[1]);
  });

  it("sizes the canvas to hold every card and draws one path per edge", () => {
    for (const node of layout.nodes) {
      expect(node.x + GRAPH_NODE_WIDTH).toBeLessThanOrEqual(layout.width - GRAPH_PADDING);
      expect(node.y + GRAPH_NODE_HEIGHT).toBeLessThanOrEqual(layout.height - GRAPH_PADDING);
    }
    expect(layout.edges).toHaveLength(edges.length);
    expect(layout.edges[0]?.path).toMatch(/^M [\d.]+ [\d.]+ C /);
  });

  it("lays out an app without resources as a single card", () => {
    const empty = layoutResourceGraph({ rootId: "app", children: new Map(), edges: [] });
    expect(empty.nodes).toEqual([{ id: "app", depth: 0, x: GRAPH_PADDING, y: GRAPH_PADDING }]);
    expect(empty.width).toBe(GRAPH_PADDING * 2 + GRAPH_NODE_WIDTH);
    expect(empty.height).toBe(GRAPH_PADDING * 2 + GRAPH_NODE_HEIGHT);
  });
});
