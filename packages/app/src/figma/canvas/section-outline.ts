import type { FigmaFrameSummary, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { absoluteBoundingBoxOf } from "./viewport";

// Section granularity for the canvas (spec 32.5.1, ADR-0039): a SECTION is never a full-tree
// load unit. The outline (W5, depth 3) and shallow depth-1 reads (W4, `figmaNodeDepth`) hand
// `parentId`/`childrenLoaded` summary fields; the protocol schema lands in its own build, so
// these types INTERSECT the protocol summary rather than shadow it.

export interface SectionSummaryFields {
  parentId?: string;
  /** False at a truncation boundary: this Section's children are not in the summary yet. */
  childrenLoaded?: boolean;
}

export type SectionAwareSummary = FigmaFrameSummary & SectionSummaryFields;

export function isSectionSummary(frame: { type: string }): boolean {
  return frame.type === "SECTION";
}

/**
 * SHARED EXPORT (canvas + W2 sidebar): the SECTION's direct children as frame summaries from a
 * depth-1 payload. Only facts that exist in the payload become summaries — real id, name, type
 * and absoluteBoundingBox, `parentId` = section.id, document order preserved. A child with no
 * real bbox is skipped (nothing is fabricated), and a child SECTION is a boundary node: its own
 * children are unknown, so `childrenLoaded: false` and recursion happens via its own depth-1
 * read when it enters the viewport.
 */
export function childSummaries(section: FigmaNode): SectionAwareSummary[] {
  const summaries: SectionAwareSummary[] = [];
  const children = Array.isArray(section.children) ? (section.children as unknown[]) : [];
  for (const raw of children) {
    if (!raw || typeof raw !== "object") continue;
    const child = raw as Partial<FigmaNode>;
    if (typeof child.id !== "string" || typeof child.name !== "string") continue;
    const bounds = absoluteBoundingBoxOf(child as FigmaNode);
    if (!bounds) continue;
    const summary: SectionAwareSummary = {
      id: child.id,
      name: child.name,
      // Unknown child types still paint from their own subtree load; keep the wire value.
      type: typeof child.type === "string" ? child.type : "FRAME",
      bounds,
      parentId: section.id,
    };
    if (isSectionSummary(child as { type: string })) summary.childrenLoaded = false;
    summaries.push(summary);
  }
  return summaries;
}

/**
 * The roots the canvas draws: every non-SECTION root as-is, SECTIONs chrome-only (background
 * and label from the summary; never `store.load(section.id)` — that was the full-tree flaw).
 * A SECTION whose depth-1 children have arrived is flattened in place, recursively for nested
 * Sections; unknown children stay unexpanded (the caller queues the shallow read). `seen`
 * dedupes ids so a server-flattened child is never drawn twice — once from the outline and
 * once from the section's own depth-1 expansion.
 */
export function flattenVisibleRoots(
  frames: readonly FigmaFrameSummary[],
  readChildSummaries: (sectionId: string) => SectionAwareSummary[] | undefined,
): SectionAwareSummary[] {
  const roots: SectionAwareSummary[] = [];
  const seen = new Set<string>();
  const walk = (list: readonly SectionAwareSummary[]): void => {
    for (const frame of list) {
      if (seen.has(frame.id)) continue;
      seen.add(frame.id);
      roots.push(frame);
      if (isSectionSummary(frame) && frame.childrenLoaded === false) {
        const children = readChildSummaries(frame.id);
        if (children) walk(children);
      }
    }
  };
  walk(frames);
  return roots;
}
