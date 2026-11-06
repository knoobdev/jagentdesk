import type { FigmaFrameSummary, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { absoluteBoundingBoxOf } from "./viewport";

// ADR-0039 Section outline helpers. The daemon's depth-3 outline delivers flat,
// ordered frame summaries that carry an OPTIONAL `parentId` (child-of-SECTION)
// and a SECTION-only `childrenLoaded` flag; the protocol fields arrive with
// the W4/W5 build, so the shape is declared additively here and the old wire
// stays valid (a summary without the fields reads as "children unknown").

/** A summary as the ADR-0039 outline delivers it. */
export type OutlineSectionSummary = FigmaFrameSummary & {
  parentId?: string | null;
  childrenLoaded?: boolean;
};

/** Solid paint of a node in the summary's `#RRGGBBAA` form, when one exists. */
function backgroundColorOf(node: FigmaNode): string | undefined {
  const fills = node.fills;
  if (!Array.isArray(fills)) return undefined;
  for (const entry of fills) {
    if (typeof entry !== "object" || entry === null) continue;
    const fill = entry as Record<string, unknown>;
    if (fill.type !== "SOLID" || fill.visible === false) continue;
    const color = fill.color;
    if (typeof color !== "object" || color === null) continue;
    const { r, g, b } = color as Record<string, unknown>;
    const a = typeof fill.opacity === "number" ? fill.opacity : 1;
    if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") continue;
    const hex = (v: number) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, "0");
    return `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
  }
  return undefined;
}

/**
 * Turn a depth-1 SECTION node (root + DIRECT children only, per ADR-0039) into
 * the summaries the sidebar/canvas render, preserving Figma's sibling order and
 * reparenting every child to the section. Nested SECTIONs are marked
 * `childrenLoaded: false` — their own children are still unknown (a further
 * expand reads them with another depth-1 request); real frames keep their
 * subtree unloaded until the user expands the frame itself.
 */
export function childSummaries(section: FigmaNode): OutlineSectionSummary[] {
  const children = Array.isArray(section.children) ? (section.children as FigmaNode[]) : [];
  return children
    .filter((child) => typeof child?.id === "string" && typeof child?.type === "string")
    .map((child) => {
      const summary: OutlineSectionSummary = {
        id: child.id,
        name: child.name ?? child.id,
        type: child.type,
        bounds: absoluteBoundingBoxOf(child) ?? { x: 0, y: 0, width: 0, height: 0 },
        parentId: section.id,
      };
      if (child.type === "SECTION") summary.childrenLoaded = false;
      const background = backgroundColorOf(child);
      if (background) summary.backgroundColor = background;
      return summary;
    });
}
