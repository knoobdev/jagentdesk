// Ported from Paseo v0.18.0 packages/app/src/components/explorer-sidebar-layout.ts (width
// resolution and dock sizes). The default is the Gumloop inspector's 525 px (spec 38 §4.5);
// the minimum and the room kept for the workspace body are Paseo's.
const DEFAULT_EXPLORER_SIDEBAR_WIDTH = 525;
const MIN_EXPLORER_SIDEBAR_WIDTH = 240;
const MIN_WORKSPACE_BODY_WIDTH = 360;
export const EXPLORER_WORKSPACE_MIN_WIDTH = MIN_EXPLORER_SIDEBAR_WIDTH + MIN_WORKSPACE_BODY_WIDTH;

export function resolveExplorerSidebarWidth(input: {
  requestedWidth?: number | null;
  containerWidth: number;
}): number {
  "worklet";
  const requestedWidth = input.requestedWidth ?? DEFAULT_EXPLORER_SIDEBAR_WIDTH;
  const maximumVisibleWidth =
    input.containerWidth > 0
      ? Math.max(MIN_EXPLORER_SIDEBAR_WIDTH, input.containerWidth - MIN_WORKSPACE_BODY_WIDTH)
      : requestedWidth;
  return Math.max(MIN_EXPLORER_SIDEBAR_WIDTH, Math.min(maximumVisibleWidth, requestedWidth));
}

export function resolveExplorerSidebarDockSizes(input: {
  requestedWidth?: number | null;
  containerWidth: number;
}): number[] {
  if (input.containerWidth <= 0) {
    return [1, 0];
  }
  const width = resolveExplorerSidebarWidth(input);
  const ratio = width / input.containerWidth;
  return [1 - ratio, ratio];
}
