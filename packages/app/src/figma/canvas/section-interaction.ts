// SECTION selection + drag (spec 32.6.2 / acceptance 19 / ADR-0039 update): a Section is a real
// Figma block, not just painted chrome. Selecting happens through its label, border or empty
// area; a click on a child still selects the child. Dragging the header/border of the SELECTED
// section previews the entire subtree by offsetting the metadata it already has — no full-section
// fetch — and the subtree moves with EXACTLY ONE write on pointerup. Esc/cancel writes nothing.
// Historical (pinned version), locked or connectorless files stay select/pan only and say
// "Connect editing" — a move that cannot happen is never silently swallowed as pendingSaved.
//
// All decisions here are pure; CanvasView owns the pointer plumbing and FileScreen owns the
// write. Coordinates: points are canvas-local pixels, deltas become Figma units via `/ zoom`.

import type { SectionAwareSummary } from "./section-outline";
import { isSectionSummary } from "./section-outline";
import type { Point } from "./viewport";

/** Movement below this (px) is a click, not a drag — matches the viewer's tap threshold. */
export const SECTION_DRAG_THRESHOLD_PX = 4;
/** The header band inside the Section's top edge (px on screen, zoom-compensated). */
export const SECTION_LABEL_BAND_PX = 24;
/** How close to an edge (px on screen) still counts as "on the border". */
export const SECTION_BORDER_TOLERANCE_PX = 8;

export const CONNECT_EDITING_NOTICE = "Connect editing";
/** In-flight and failed move lines (spec 32.6.2): never a silent pendingSaved. */
export const STATUS_SAVING_MOVE = "Saving move…";
export const STATUS_MOVE_FAILED = "Move failed — tap to retry";
export const STATUS_MOVE_UNVERIFIED = "Move not confirmed";

export type SectionRegion = "label" | "border" | "empty";

export interface SectionHit {
  sectionId: string;
  region: SectionRegion;
}

/**
 * Which Section (if any) the Figma-space cursor is on, and on which part. Topmost drawn wins:
 * the visible list is in paint order, so it is scanned back-to-front. The label band and the
 * border tolerance are constant in SCREEN pixels, hence divided by zoom.
 */
export function sectionHitAt(
  summaries: readonly SectionAwareSummary[],
  cursor: Point,
  zoom: number,
): SectionHit | null {
  const tol = SECTION_BORDER_TOLERANCE_PX / zoom;
  const labelBand = SECTION_LABEL_BAND_PX / zoom;
  for (let i = summaries.length - 1; i >= 0; i -= 1) {
    const section = summaries[i];
    if (!section || !isSectionSummary(section)) continue;
    const { x, y, width, height } = section.bounds;
    if (cursor.x < x || cursor.x > x + width || cursor.y < y || cursor.y > y + height) continue;
    if (cursor.y <= y + Math.min(labelBand, height))
      return { sectionId: section.id, region: "label" };
    const onBorder =
      cursor.x <= x + tol ||
      cursor.x >= x + width - tol ||
      cursor.y <= y + tol ||
      cursor.y >= y + height - tol;
    return { sectionId: section.id, region: onBorder ? "border" : "empty" };
  }
  return null;
}

export interface SectionOffset {
  dx: number;
  dy: number;
}

/**
 * Transitive descendants of a Section among the flat summaries ALREADY held (parentId closure) —
 * the whole subtree the drag must preview without a full-section fetch. Cycle-guarded: parentId
 * data is trusted input, not a proof.
 */
export function descendantIds(
  sectionId: string,
  summaries: readonly SectionAwareSummary[],
): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const summary of summaries) {
    const parent = summary.parentId;
    if (!parent) continue;
    const list = childrenOf.get(parent);
    if (list) list.push(summary.id);
    else childrenOf.set(parent, [summary.id]);
  }
  const found = new Set<string>();
  const stack = [sectionId];
  while (stack.length > 0) {
    for (const child of childrenOf.get(stack.pop() as string) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      stack.push(child);
    }
  }
  return found;
}

// ── drag state machine ─────────────────────────────────────────────────────────────────
// press → (past threshold) preview → commit writes once / cancel writes nothing.

export type SectionDrag =
  | { phase: "idle" }
  | { phase: "press"; sectionId: string; origin: Point }
  | { phase: "preview"; sectionId: string; origin: Point; dx: number; dy: number };

export const IDLE_DRAG: SectionDrag = { phase: "idle" };

/** Begin a press-to-move on the already-selected Section's header/border. */
export function beginSectionDrag(sectionId: string, point: Point): SectionDrag {
  return { phase: "press", sectionId, origin: point };
}

/**
 * Track the pointer. Past the threshold the drag enters preview with the delta converted to
 * Figma units; below it the press is still a candidate click.
 */
export function moveSectionDrag(drag: SectionDrag, point: Point, zoom: number): SectionDrag {
  if (drag.phase === "idle") return drag;
  const dx = point.x - drag.origin.x;
  const dy = point.y - drag.origin.y;
  if (Math.abs(dx) + Math.abs(dy) <= SECTION_DRAG_THRESHOLD_PX) return drag;
  return {
    phase: "preview",
    sectionId: drag.sectionId,
    origin: drag.origin,
    dx: dx / zoom,
    dy: dy / zoom,
  };
}

/**
 * Resolve a release. A preview past the threshold commits exactly one move and reports it; a
 * plain press is a click (no commit — the caller selects instead). Always leaves the idle phase.
 */
export type SectionCommit = (SectionOffset & { sectionId: string }) | null;

export function commitSectionDrag(drag: SectionDrag): SectionCommit {
  if (drag.phase === "preview") return { sectionId: drag.sectionId, dx: drag.dx, dy: drag.dy };
  return null;
}

/** Esc / cancel: the preview disappears and NOTHING is written. */
export function cancelSectionDrag(): SectionDrag {
  return IDLE_DRAG;
}

export function isSectionDragging(drag: SectionDrag): boolean {
  return drag.phase !== "idle";
}

// ── editability (spec 32.6.2: read-only states must speak up, never silently drop the move) ──

export interface SectionEditingInput {
  /** server_info.features.figmaRemoteWrites — an old host cannot run the execute RPC. */
  capability: boolean;
  /** figma.remote.status observed `connected` (W10's hook; never assume it). */
  remoteConnected: boolean;
  /** A pinned (historical/playback) version is read-only. */
  versionPinned: boolean;
  locked?: boolean;
}

export interface SectionEditing extends SectionEditingInput {
  canEdit: boolean;
  /** The line the canvas shows instead of pretending a move saved. */
  notice: string | null;
}

export function sectionEditing(input: SectionEditingInput): SectionEditing {
  const canEdit =
    input.capability && input.remoteConnected && !input.versionPinned && input.locked !== true;
  return { ...input, canEdit, notice: canEdit ? null : CONNECT_EDITING_NOTICE };
}
