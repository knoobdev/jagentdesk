import type { SplitNode, SplitPane } from "@/stores/workspace-layout-store";

export function resolveSplitContainerRoot(input: {
  root: SplitNode;
  focusedPaneId: string | null;
  focusModeEnabled: boolean | undefined;
}): { root: SplitNode; usesFallbackStrip: boolean } {
  if (!input.focusModeEnabled) return { root: input.root, usesFallbackStrip: false };
  const focusedPane = input.focusedPaneId ? findPane(input.root, input.focusedPaneId) : null;
  if (!focusedPane) return { root: input.root, usesFallbackStrip: true };
  return { root: { kind: "pane", pane: focusedPane }, usesFallbackStrip: false };
}

/** Whether a workspace pane has another visible pane it can be maximized over. */
export function hasMultipleVisiblePanes(node: SplitNode): boolean {
  let visiblePaneCount = 0;
  const visit = (current: SplitNode): void => {
    if (current.kind === "pane") {
      if (current.pane.hidden !== true) visiblePaneCount += 1;
      return;
    }
    for (const child of current.group.children) {
      visit(child);
      if (visiblePaneCount > 1) return;
    }
  };
  visit(node);
  return visiblePaneCount > 1;
}

function findPane(node: SplitNode, paneId: string): SplitPane | null {
  if (node.kind === "pane") return node.pane.id === paneId ? node.pane : null;
  for (const child of node.group.children) {
    const pane = findPane(child, paneId);
    if (pane) return pane;
  }
  return null;
}
