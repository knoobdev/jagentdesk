import type { FigmaOutline, FigmaPrototype } from "@jagentdesk/protocol/figma/rpc-schemas";

// ADR-0043 flow-page selection, as pure helpers: which flows the player lists, and which flow
// names the session remembers for label lookup. Kept free of React so the rules are testable
// with plain unit tests (docs/testing.md: real dependencies over mocks).
export type FlowEntry = FigmaPrototype["flows"][number];

export type FlowPageReadStatus = "loaded" | "pending" | "failed" | "unread";

export interface FlowPageOption {
  id: string;
  name: string;
  loaded: boolean;
  status: FlowPageReadStatus;
}

/** A paged host's depth-1 index lists every page by name, but unread pages carry no flow data. */
export function outlineIsPaged(outline: FigmaOutline): boolean {
  return outline.pages.some((page) => page.childrenLoaded === false);
}

/** The first page whose content the outline actually carries — the player's default listing. */
export function firstReadPageId(outline: FigmaOutline): string | null {
  return outline.pages.find((page) => page.childrenLoaded !== false)?.id ?? null;
}

function flowsOfPage(page: FigmaOutline["pages"][number]): FlowEntry[] {
  return page.flowStartingPoints.map((point) => ({
    nodeId: point.nodeId,
    name: point.name,
    pageId: page.id,
  }));
}

/**
 * The flows the player lists. LEGACY (fully-read) outlines list EVERY page's flows — the
 * original aggregate behavior, unchanged. Paged hosts list ONE page's flows: the browsed page
 * when the outline carries it read, otherwise the on-demand page read's snapshot. An unread or
 * still-loading page yields an empty list — never a silent all-file masquerade.
 */
export function flowsForListing(
  outline: FigmaOutline,
  paged: boolean,
  pageId: string | null,
  pageOutline: FigmaOutline | undefined,
): FlowEntry[] {
  if (!paged) return outline.pages.flatMap(flowsOfPage);
  if (!pageId) return [];
  const listed = outline.pages.find((page) => page.id === pageId);
  if (listed && listed.childrenLoaded !== false) return flowsOfPage(listed);
  return (pageOutline?.pages ?? []).flatMap(flowsOfPage);
}

/**
 * Merge the flows the session has listed so far, keyed by node id — the label of a PLAYING flow
 * must survive browsing to a page that does not list it. Bounded by the file's flow count.
 */
export function mergeSeenFlows(previous: FlowEntry[], flows: FlowEntry[]): FlowEntry[] {
  if (flows.length === 0) return previous;
  const seen = new Map(previous.map((flow) => [flow.nodeId, flow]));
  for (const flow of flows) seen.set(flow.nodeId, flow);
  return Array.from(seen.values());
}

/**
 * Remembered flow names are scoped to one player identity (server|file|pinned version): a new
 * snapshot starts a fresh lookup, so an old snapshot's names/node ids can never resolve labels
 * for the new one.
 */
export function seenFlowsForIdentity(
  stored: { identity: string; flows: FlowEntry[] } | null,
  identity: string,
  flows: FlowEntry[],
): FlowEntry[] {
  return stored && stored.identity === identity ? mergeSeenFlows(stored.flows, flows) : flows;
}
