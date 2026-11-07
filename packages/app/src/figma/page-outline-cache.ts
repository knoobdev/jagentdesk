import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { FigmaOutline, FigmaRequestParams } from "@jagentdesk/protocol/figma/rpc-schemas";

export type ReadParams = FigmaRequestParams<"figma.file.outline.request">;
export const pageOutlineKeys = {
  index: (serverId: string, fileKey: string, version: string | null) =>
    ["figma", serverId, fileKey, "page-index", version ?? "live"] as const,
  page: (serverId: string, fileKey: string, version: string | null, pageId: string | null) =>
    ["figma", serverId, fileKey, "page-outline", version, pageId] as const,
};

// A second observer mounts with refetchOnMount=always (shared query policy). An immutable
// snapshot already in this query cache needs neither another RPC nor another JSON decode.
// Explicit invalidation still wins; live indexes may only reuse the metadata polling window.
export async function readOutlineSnapshot(
  queries: QueryClient,
  key: QueryKey,
  params: ReadParams,
  load: (params: ReadParams) => Promise<FigmaOutline>,
  now = Date.now(),
): Promise<FigmaOutline> {
  const state = queries.getQueryState<FigmaOutline>(key);
  if (
    state?.data &&
    state.status === "success" &&
    !state.isInvalidated &&
    (params.version || now - state.dataUpdatedAt < 60_000)
  )
    return state.data;
  const outline = await load(params);
  if (!outline.version.trim() || (params.version && outline.version !== params.version))
    throw new Error("The page belongs to another file version. Refresh the file to continue.");
  if (outline.fileKey !== params.fileKey) throw new Error("The page belongs to another file.");
  if (
    params.pagesOnly &&
    outline.pages.some((page) => page.childrenLoaded !== false || page.frames.length !== 0)
  )
    throw new Error("The page index is incomplete. Update the host and retry.");
  if (
    params.pageId &&
    (outline.pages.length !== 1 ||
      outline.pages[0]?.id !== params.pageId ||
      outline.pages[0]?.childrenLoaded !== true)
  )
    throw new Error("The requested page content is unavailable.");
  return outline;
}
