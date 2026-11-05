// "Open in Figma" (spec 32.5.5): figma:// deep link when Figma desktop is around, the web URL
// otherwise. Figma's web URLs and the app's `node` route param spell node ids with dashes
// (`123:45`, `I567:12;3:45` → `123-45`, `I567-12;3-45`).

export function figmaNodeParam(nodeId: string | null | undefined): string | undefined {
  if (!nodeId) return undefined;
  return nodeId.replace(/:/g, "-");
}

export function figmaNodeIdFromParam(param: string | null | undefined): string | null {
  if (!param || !/^[\d;:\-Ii]+$/.test(param)) return null;
  return param.replace(/-/g, ":");
}

/**
 * Which node the URL's `node` param should drive focus to right now — the pure half of the
 * file screen's URL-focus effect. Both guard refs are held in the DECODED form (plain node
 * ids, "1:39"); comparing the decoded param against them keeps one form end to end. The old
 * mismatch (skipping the URL form "1-39", comparing the decoded "1:39") made every canvas
 * click re-centre the camera because the echoed param never matched the skip entry.
 * Returns null for no param, junk, a canvas-echoed selection, or an already-focused node.
 */
export function nodeParamToFocusId(
  nodeParam: string | string[] | null | undefined,
  skipUrlFocus: string | null,
  autoFocusedFor: string | null,
): string | null {
  const raw = Array.isArray(nodeParam) ? nodeParam[0] : nodeParam;
  const nodeId = figmaNodeIdFromParam(raw ?? null);
  if (!nodeId) return null;
  if (nodeId === skipUrlFocus || nodeId === autoFocusedFor) return null;
  return nodeId;
}

const FIGMA_WEB_BASE = "https://www.figma.com/design";
const FIGMA_DEEP_BASE = "figma://design";

export function figmaDesignUrl(fileKey: string, nodeId?: string | null): string {
  const node = figmaNodeParam(nodeId);
  return `${FIGMA_WEB_BASE}/${fileKey}${node ? `?node-id=${node}` : ""}`;
}

/** Desktop deep link (spec 32.5.5): opens Figma itself when it is installed. */
export function figmaDeepLink(fileKey: string, nodeId?: string | null): string {
  const node = figmaNodeParam(nodeId);
  return `${FIGMA_DEEP_BASE}/${fileKey}${node ? `?node-id=${node}` : ""}`;
}
