import type {
  FigmaEditOp,
  FigmaFrameSummary,
  FigmaNode,
  FigmaPendingOp,
} from "@jagentdesk/protocol/figma/rpc-schemas";

// Fakes for the canvas unit tests: Figma-shaped objects, no network, no DOM. Only what the pure
// modules consume is spelled out; FigmaNode passes unknown properties through, so patches stay
// free-form.

export function makeNode(partial: Partial<FigmaNode> & { id?: string } = {}): FigmaNode {
  return {
    id: partial.id ?? "1:1",
    name: partial.name ?? "Node",
    type: partial.type ?? "FRAME",
    ...partial,
  };
}

export function makeFrameSummary(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): FigmaFrameSummary {
  return {
    id,
    name: `Frame ${id}`,
    type: "FRAME",
    bounds: { x, y, width, height },
  };
}

let pendingCounter = 0;

export function makePendingOp(
  op: FigmaEditOp,
  overrides: Partial<FigmaPendingOp> = {},
): FigmaPendingOp {
  pendingCounter += 1;
  return {
    id: `fpo_${pendingCounter}`,
    op,
    baseVersion: "1",
    previous: {},
    createdAt_ms: 0,
    origin: "user",
    state: "pending",
    ...overrides,
  };
}
