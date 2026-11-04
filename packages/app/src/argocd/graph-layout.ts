import type { ArgoCdResourceEdge } from "./resources";

// Left → right layout of the resource tree, like the Argo CD web UI's Tree view (which uses
// dagre with rankdir LR). Columns are tree depth; each leaf takes its own row and an owner
// sits centred on the rows of its subtree, so cards never overlap and edges never cross
// inside one owner's fan-out.

export const GRAPH_NODE_WIDTH = 248;
export const GRAPH_NODE_HEIGHT = 64;
export const GRAPH_COLUMN_GAP = 56;
export const GRAPH_ROW_GAP = 16;
export const GRAPH_PADDING = 24;

export interface GraphNodePlacement {
  id: string;
  depth: number;
  x: number;
  y: number;
}

export interface GraphEdgePlacement {
  from: string;
  to: string;
  path: string;
}

export interface GraphLayout {
  nodes: GraphNodePlacement[];
  edges: GraphEdgePlacement[];
  width: number;
  height: number;
}

const ROW_PITCH = GRAPH_NODE_HEIGHT + GRAPH_ROW_GAP;
const COLUMN_PITCH = GRAPH_NODE_WIDTH + GRAPH_COLUMN_GAP;

/** A horizontal S-curve from the owner's right edge to the child's left edge. */
export function edgePath(from: GraphNodePlacement, to: GraphNodePlacement): string {
  const startX = from.x + GRAPH_NODE_WIDTH;
  const startY = from.y + GRAPH_NODE_HEIGHT / 2;
  const endX = to.x;
  const endY = to.y + GRAPH_NODE_HEIGHT / 2;
  const bend = Math.max(GRAPH_COLUMN_GAP / 2, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

export function layoutResourceGraph(input: {
  rootId: string;
  children: ReadonlyMap<string, readonly string[]>;
  edges: readonly ArgoCdResourceEdge[];
}): GraphLayout {
  const placements = new Map<string, GraphNodePlacement>();
  let nextRow = 0;
  let maxDepth = 0;

  function place(id: string, depth: number): number {
    maxDepth = Math.max(maxDepth, depth);
    const ids = input.children.get(id) ?? [];
    let row: number;
    if (ids.length === 0) {
      row = nextRow;
      nextRow += 1;
    } else {
      const rows = ids.map((child) => place(child, depth + 1));
      row = (rows[0] + rows[rows.length - 1]) / 2;
    }
    placements.set(id, {
      id,
      depth,
      x: GRAPH_PADDING + depth * COLUMN_PITCH,
      y: GRAPH_PADDING + row * ROW_PITCH,
    });
    return row;
  }
  place(input.rootId, 0);

  const edges: GraphEdgePlacement[] = [];
  for (const edge of input.edges) {
    const from = placements.get(edge.from);
    const to = placements.get(edge.to);
    if (from && to) edges.push({ from: edge.from, to: edge.to, path: edgePath(from, to) });
  }

  const rowCount = Math.max(nextRow, 1);
  return {
    nodes: [...placements.values()],
    edges,
    width: GRAPH_PADDING * 2 + (maxDepth + 1) * COLUMN_PITCH - GRAPH_COLUMN_GAP,
    height: GRAPH_PADDING * 2 + rowCount * ROW_PITCH - GRAPH_ROW_GAP,
  };
}
