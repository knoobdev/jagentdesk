import {
  SSH_WORKSPACE_MAX_PANES,
  type SshLayoutNode,
  type SshPaneTarget,
  type SshSplitDirection,
  type SshWorkspaceLayout,
} from "@jagentdesk/protocol/ssh/snippets-schemas";

// Pure model of an SSH workspace (spec 25.4): a split tree of up to 16 panes, the
// focused ("main") pane and broadcast input. The owner maps each pane to a real
// terminal; this module only decides layout, focus and where input goes.

export type SplitNode = SshLayoutNode;
export type PaneNode = Extract<SshLayoutNode, { kind: "pane" }>;
export type SplitContainer = Extract<SshLayoutNode, { kind: "split" }>;

export interface PaneSpec {
  id: string;
  target: SshPaneTarget;
  tabTitle?: string;
}

export interface SplitWorkspace {
  rootId: string;
  nodes: Readonly<Record<string, SplitNode>>;
  focusedPaneId: string;
  broadcast: boolean;
}

export type FocusDirection = "left" | "right" | "up" | "down";

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class PaneLimitError extends Error {
  constructor() {
    super(`A workspace holds at most ${SSH_WORKSPACE_MAX_PANES} panes`);
  }
}

const MIN_SIZE = 0.05;

function paneNode(spec: PaneSpec): PaneNode {
  return {
    kind: "pane",
    id: spec.id,
    target: spec.target,
    ...(spec.tabTitle ? { tabTitle: spec.tabTitle } : {}),
  };
}

function evenSizes(count: number): number[] {
  return Array.from({ length: count }, () => 1 / count);
}

/** Lays panes out in a near-square grid: rows top to bottom, panes left to right. */
export function createWorkspace(panes: readonly PaneSpec[]): SplitWorkspace {
  if (panes.length === 0) throw new Error("A workspace needs at least one pane");
  if (panes.length > SSH_WORKSPACE_MAX_PANES) throw new PaneLimitError();
  const nodes: Record<string, SplitNode> = {};
  for (const spec of panes) nodes[spec.id] = paneNode(spec);
  const columns = Math.ceil(Math.sqrt(panes.length));
  const rowIds: string[] = [];
  for (let start = 0; start < panes.length; start += columns) {
    const rowPanes = panes.slice(start, start + columns).map((spec) => spec.id);
    if (rowPanes.length === 1) {
      rowIds.push(rowPanes[0]!);
      continue;
    }
    const rowId = `row_${rowIds.length}`;
    nodes[rowId] = {
      kind: "split",
      id: rowId,
      direction: "row",
      children: rowPanes,
      sizes: evenSizes(rowPanes.length),
    };
    rowIds.push(rowId);
  }
  let rootId = rowIds[0]!;
  if (rowIds.length > 1) {
    rootId = "grid";
    nodes[rootId] = {
      kind: "split",
      id: rootId,
      direction: "column",
      children: rowIds,
      sizes: evenSizes(rowIds.length),
    };
  }
  return { rootId, nodes, focusedPaneId: panes[0]!.id, broadcast: false };
}

/** Panes in reading order (depth-first, first child first). */
export function paneIds(workspace: SplitWorkspace): string[] {
  const result: string[] = [];
  const visit = (id: string) => {
    const node = workspace.nodes[id]!;
    if (node.kind === "pane") {
      result.push(id);
    } else {
      node.children.forEach(visit);
    }
  };
  visit(workspace.rootId);
  return result;
}

export function getPane(workspace: SplitWorkspace, paneId: string): PaneNode {
  const node = workspace.nodes[paneId];
  if (!node || node.kind !== "pane") throw new Error(`Unknown pane ${paneId}`);
  return node;
}

function parentOf(workspace: SplitWorkspace, childId: string): SplitContainer | null {
  for (const node of Object.values(workspace.nodes)) {
    if (node.kind === "split" && node.children.includes(childId)) return node;
  }
  return null;
}

function replaceChild(
  nodes: Record<string, SplitNode>,
  parent: SplitContainer | null,
  oldId: string,
  newId: string,
): string | null {
  if (!parent) return newId;
  nodes[parent.id] = {
    ...parent,
    children: parent.children.map((child) => (child === oldId ? newId : child)),
  };
  return null;
}

/**
 * Splits `paneId` and puts `pane` after it. A split in the same direction as the parent
 * joins the parent and halves the pane's share; otherwise the pane is wrapped.
 */
export function splitPane(
  workspace: SplitWorkspace,
  params: { paneId: string; direction: SshSplitDirection; pane: PaneSpec },
): SplitWorkspace {
  if (paneIds(workspace).length >= SSH_WORKSPACE_MAX_PANES) throw new PaneLimitError();
  if (workspace.nodes[params.pane.id]) throw new Error(`Pane ${params.pane.id} already exists`);
  getPane(workspace, params.paneId);
  const nodes: Record<string, SplitNode> = { ...workspace.nodes };
  nodes[params.pane.id] = paneNode(params.pane);
  const parent = parentOf(workspace, params.paneId);
  let rootId = workspace.rootId;
  if (parent && parent.direction === params.direction) {
    const index = parent.children.indexOf(params.paneId);
    const half = parent.sizes[index]! / 2;
    const children = [...parent.children];
    const sizes = [...parent.sizes];
    children.splice(index + 1, 0, params.pane.id);
    sizes.splice(index, 1, half, half);
    nodes[parent.id] = { ...parent, children, sizes };
  } else {
    const splitId = `split_${params.pane.id}`;
    nodes[splitId] = {
      kind: "split",
      id: splitId,
      direction: params.direction,
      children: [params.paneId, params.pane.id],
      sizes: [0.5, 0.5],
    };
    rootId = replaceChild(nodes, parent, params.paneId, splitId) ?? rootId;
  }
  return { ...workspace, rootId, nodes, focusedPaneId: params.pane.id };
}

/** Removes a pane; returns null when it was the last one (the workspace closes). */
export function closePane(workspace: SplitWorkspace, paneId: string): SplitWorkspace | null {
  getPane(workspace, paneId);
  const order = paneIds(workspace);
  if (order.length === 1) return null;
  const nodes: Record<string, SplitNode> = { ...workspace.nodes };
  delete nodes[paneId];
  const parent = parentOf(workspace, paneId)!;
  const index = parent.children.indexOf(paneId);
  const children = parent.children.filter((child) => child !== paneId);
  const remaining = parent.sizes.filter((_, i) => i !== index);
  const total = remaining.reduce((sum, size) => sum + size, 0);
  let rootId = workspace.rootId;
  if (children.length === 1) {
    delete nodes[parent.id];
    const grandparent = parentOf(workspace, parent.id);
    rootId = replaceChild(nodes, grandparent, parent.id, children[0]!) ?? rootId;
  } else {
    nodes[parent.id] = { ...parent, children, sizes: remaining.map((size) => size / total) };
  }
  const position = order.indexOf(paneId);
  const nextFocus =
    workspace.focusedPaneId === paneId
      ? (order[position + 1] ?? order[position - 1]!)
      : workspace.focusedPaneId;
  return { ...workspace, rootId, nodes, focusedPaneId: nextFocus };
}

export function focusPane(workspace: SplitWorkspace, paneId: string): SplitWorkspace {
  getPane(workspace, paneId);
  return { ...workspace, focusedPaneId: paneId };
}

export function toggleBroadcast(workspace: SplitWorkspace): SplitWorkspace {
  return { ...workspace, broadcast: !workspace.broadcast };
}

/** Panes that receive input typed into `fromPaneId`: all panes while broadcasting. */
export function inputTargets(workspace: SplitWorkspace, fromPaneId: string): string[] {
  getPane(workspace, fromPaneId);
  return workspace.broadcast ? paneIds(workspace) : [fromPaneId];
}

/** Sets a split's sizes, clamping each to at least 5 % and renormalizing to 1. */
export function resizeSplit(
  workspace: SplitWorkspace,
  splitId: string,
  sizes: readonly number[],
): SplitWorkspace {
  const node = workspace.nodes[splitId];
  if (!node || node.kind !== "split") throw new Error(`Unknown split ${splitId}`);
  if (sizes.length !== node.children.length) throw new Error("One size per child");
  const clamped = sizes.map((size) => Math.max(MIN_SIZE, size));
  const total = clamped.reduce((sum, size) => sum + size, 0);
  return {
    ...workspace,
    nodes: { ...workspace.nodes, [splitId]: { ...node, sizes: clamped.map((s) => s / total) } },
  };
}

/** Fractional rectangle of every pane inside the unit square. */
export function computePaneRects(workspace: SplitWorkspace): Map<string, PaneRect> {
  const rects = new Map<string, PaneRect>();
  const visit = (id: string, rect: PaneRect) => {
    const node = workspace.nodes[id]!;
    if (node.kind === "pane") {
      rects.set(id, rect);
      return;
    }
    let offset = 0;
    node.children.forEach((child, index) => {
      const share = node.sizes[index]!;
      const childRect =
        node.direction === "row"
          ? {
              x: rect.x + offset * rect.width,
              y: rect.y,
              width: share * rect.width,
              height: rect.height,
            }
          : {
              x: rect.x,
              y: rect.y + offset * rect.height,
              width: rect.width,
              height: share * rect.height,
            };
      visit(child, childRect);
      offset += share;
    });
  };
  visit(workspace.rootId, { x: 0, y: 0, width: 1, height: 1 });
  return rects;
}

const EPSILON = 1e-9;

function overlaps(aStart: number, aLength: number, bStart: number, bLength: number): boolean {
  return aStart < bStart + bLength - EPSILON && bStart < aStart + aLength - EPSILON;
}

/**
 * Moves focus to the adjacent pane in a direction (Termius: Cmd/Ctrl+Opt/Alt+arrows).
 * Among panes that touch the focused edge, the one with the largest shared edge wins.
 */
export function focusNeighbor(
  workspace: SplitWorkspace,
  direction: FocusDirection,
): SplitWorkspace {
  const rects = computePaneRects(workspace);
  const from = rects.get(workspace.focusedPaneId)!;
  let best: { id: string; shared: number } | null = null;
  for (const [id, rect] of rects) {
    if (id === workspace.focusedPaneId) continue;
    const horizontal = direction === "left" || direction === "right";
    const touches =
      (direction === "right" && Math.abs(rect.x - (from.x + from.width)) < EPSILON) ||
      (direction === "left" && Math.abs(rect.x + rect.width - from.x) < EPSILON) ||
      (direction === "down" && Math.abs(rect.y - (from.y + from.height)) < EPSILON) ||
      (direction === "up" && Math.abs(rect.y + rect.height - from.y) < EPSILON);
    if (!touches) continue;
    const aligned = horizontal
      ? overlaps(rect.y, rect.height, from.y, from.height)
      : overlaps(rect.x, rect.width, from.x, from.width);
    if (!aligned) continue;
    const shared = horizontal
      ? Math.min(rect.y + rect.height, from.y + from.height) - Math.max(rect.y, from.y)
      : Math.min(rect.x + rect.width, from.x + from.width) - Math.max(rect.x, from.x);
    if (!best || shared > best.shared) best = { id, shared };
  }
  return best ? { ...workspace, focusedPaneId: best.id } : workspace;
}

/** The persisted shape for `ssh.workspaces.save` (spec 25.2 `layout`). */
export function toTemplateLayout(workspace: SplitWorkspace): SshWorkspaceLayout {
  const order: string[] = [];
  const visit = (id: string) => {
    order.push(id);
    const node = workspace.nodes[id]!;
    if (node.kind === "split") node.children.forEach(visit);
  };
  visit(workspace.rootId);
  return { rootId: workspace.rootId, nodes: order.map((id) => workspace.nodes[id]!) };
}

/** Reopens a saved template; every pane still needs a fresh connection from the owner. */
export function fromTemplateLayout(layout: SshWorkspaceLayout): SplitWorkspace {
  const nodes: Record<string, SplitNode> = {};
  for (const node of layout.nodes) nodes[node.id] = node;
  const workspace: SplitWorkspace = {
    rootId: layout.rootId,
    nodes,
    focusedPaneId: "",
    broadcast: false,
  };
  return { ...workspace, focusedPaneId: paneIds(workspace)[0]! };
}
