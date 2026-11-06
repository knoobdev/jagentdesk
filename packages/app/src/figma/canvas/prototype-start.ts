import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";

// W6 handoff (spec 32.5.3 / ADR-0039): the player renders whatever frame id it is handed as the
// whole screen. A canvas selection is usually a descendant — a TEXT or button inside a frame —
// and playing that subtree shows a lone button, not a screen. Map the selection up to the root
// FRAME the canvas already caches. Outline starts (a SECTION-scoped starting point, whose
// resolution the player owns) pass through verbatim; an uncached or cyclic parent chain falls
// back to the current page's flow rather than guessing a subtree.

export interface PrototypeStartInput {
  selectedNodeId: string | null;
  /** Root frame summaries of the current page — only the ids matter here. */
  frames: readonly { id: string }[];
  /** The CURRENT PAGE's flow starting points, in outline order. */
  flowStartingPoints: readonly { nodeId: string }[];
  /** Cached parent chain from the frame store; null/undefined when the node is not cached. */
  parentOf: (nodeId: string) => FigmaNode | null | undefined;
}

export function resolvePrototypeStartNode({
  selectedNodeId,
  frames,
  flowStartingPoints,
  parentOf,
}: PrototypeStartInput): string | null {
  const pageFlowStart = flowStartingPoints[0]?.nodeId ?? null;
  if (!selectedNodeId) return pageFlowStart;
  const roots = new Set(frames.map((frame) => frame.id));
  // Already a screen: a root frame of this page, or an outline start the player knows how to
  // resolve (SECTION-scoped starts included).
  if (roots.has(selectedNodeId)) return selectedNodeId;
  if (flowStartingPoints.some((point) => point.nodeId === selectedNodeId)) return selectedNodeId;
  // A descendant: climb the cached chain to the root FRAME that owns it. Anything leaving the
  // cache (or cycling) must not play as a text/button subtree — hand the flow start instead.
  const seen = new Set<string>([selectedNodeId]);
  let parent = parentOf(selectedNodeId);
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    if (roots.has(parent.id)) return parent.id;
    parent = parentOf(parent.id);
  }
  return pageFlowStart;
}
