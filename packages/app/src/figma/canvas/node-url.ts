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
