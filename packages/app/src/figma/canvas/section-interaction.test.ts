// Pure tests for SECTION selection + drag (spec 32.6.2 / acceptance 19): the hit regions, the
// metadata-only subtree preview, the one-write state machine, and the read-only gating. The
// pointer wiring itself is exercised against CanvasView in canvas-view.test.tsx.

import { describe, expect, it } from "vitest";
import type { SectionAwareSummary } from "./section-outline";
import {
  beginSectionDrag,
  cancelSectionDrag,
  commitSectionDrag,
  CONNECT_EDITING_NOTICE,
  descendantIds,
  IDLE_DRAG,
  isSectionDragging,
  moveSectionDrag,
  SECTION_BORDER_TOLERANCE_PX,
  SECTION_LABEL_BAND_PX,
  sectionEditing,
  sectionHitAt,
} from "./section-interaction";

function section(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
): SectionAwareSummary {
  return { id, name: `Section ${id}`, type: "SECTION", bounds: { x, y, width, height } };
}

function child(id: string, parentId: string): SectionAwareSummary {
  return {
    id,
    name: `Frame ${id}`,
    type: "FRAME",
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    parentId,
  };
}

describe("sectionHitAt (select via label/border/empty area)", () => {
  const big = section("40:1", 0, 0, 1000, 800);

  it("the header band above the top edge is the label region", () => {
    const hit = sectionHitAt([big], { x: 500, y: 8 }, 1);
    expect(hit).toEqual({ sectionId: "40:1", region: "label" });
  });

  it("near an edge (screen-constant tolerance) is the border region", () => {
    const y = SECTION_LABEL_BAND_PX + 100; // below the header band
    const hit = sectionHitAt([big], { x: SECTION_BORDER_TOLERANCE_PX / 2, y }, 1);
    expect(hit).toEqual({ sectionId: "40:1", region: "border" });
  });

  it("deep interior is the empty-area region", () => {
    expect(sectionHitAt([big], { x: 500, y: 400 }, 1)).toEqual({
      sectionId: "40:1",
      region: "empty",
    });
  });

  it("outside every Section hits nothing", () => {
    expect(sectionHitAt([big], { x: 1500, y: 400 }, 1)).toBeNull();
    expect(sectionHitAt([], { x: 5, y: 5 }, 1)).toBeNull();
  });

  it("tolerances are SCREEN constants: zooming in shrinks the figma-unit border band", () => {
    // 4 figma units from the edge: at zoom 1 that is inside the 8px border band…
    expect(sectionHitAt([big], { x: 4, y: 100 }, 1)?.region).toBe("border");
    // …at zoom 4 the same distance is 16 screen px — outside the 8px band, so it is empty.
    expect(sectionHitAt([big], { x: 4, y: 100 }, 4)?.region).toBe("empty");
  });

  it("the topmost drawn Section wins — paint order is back-to-front", () => {
    const under = section("40:0", 0, 0, 1000, 800);
    const over = section("40:2", 400, 300, 1000, 800); // drawn later ⇒ on top
    expect(sectionHitAt([under, over], { x: 500, y: 400 }, 1)).toEqual({
      sectionId: "40:2",
      region: "empty",
    });
  });

  it("frames in the list are not Sections", () => {
    const frame: SectionAwareSummary = { ...section("9:9", 0, 0, 100, 100), type: "FRAME" };
    expect(sectionHitAt([frame], { x: 50, y: 50 }, 1)).toBeNull();
  });
});

describe("descendantIds (preview the subtree from metadata alone)", () => {
  const summaries: SectionAwareSummary[] = [
    section("40:1", 0, 0, 100, 100),
    child("41:1", "40:1"),
    child("41:2", "40:1"),
    child("42:1", "41:1"), // nested under a direct child
    child("99:1", "40:2"), // a different Section
    child("99:2", "99:1"),
  ];

  it("walks the parentId closure transitively, siblings included", () => {
    expect([...descendantIds("40:1", summaries)].sort()).toEqual(["41:1", "41:2", "42:1"]);
  });

  it("never leaks past the Section and survives a parentId cycle", () => {
    expect([...descendantIds("40:2", summaries)].sort()).toEqual(["99:1", "99:2"]);
    const looped = [child("a", "b"), child("b", "a")];
    expect([...descendantIds("a", looped)].sort()).toEqual(["a", "b"]);
  });

  it("an unknown Section has no known descendants (no fabricated nodes)", () => {
    expect(descendantIds("77:7", summaries).size).toBe(0);
  });
});

describe("section drag state machine (one write on pointerup, zero on Esc)", () => {
  it("a press below the threshold is not a drag — it commits nothing", () => {
    let drag = beginSectionDrag("40:1", { x: 100, y: 100 });
    drag = moveSectionDrag(drag, { x: 102, y: 101 }, 1);
    expect(drag.phase).toBe("press");
    expect(commitSectionDrag(drag)).toBeNull();
  });

  it("past the threshold the drag previews with the delta in FIGMA units (screen px / zoom)", () => {
    let drag = beginSectionDrag("40:1", { x: 100, y: 100 });
    drag = moveSectionDrag(drag, { x: 140, y: 60 }, 2);
    expect(drag.phase).toBe("preview");
    if (drag.phase !== "preview") throw new Error("unreachable");
    expect(drag.dx).toBe(20); // 80 screen px at zoom 2
    expect(drag.dy).toBe(-20);
    const commit = commitSectionDrag(drag);
    expect(commit).toEqual({ sectionId: "40:1", dx: 20, dy: -20 });
  });

  it("an idle drag tracks nothing, commits nothing, and stays idle", () => {
    expect(isSectionDragging(IDLE_DRAG)).toBe(false);
    expect(moveSectionDrag(IDLE_DRAG, { x: 9, y: 9 }, 1)).toBe(IDLE_DRAG);
    expect(commitSectionDrag(IDLE_DRAG)).toBeNull();
  });

  it("Esc cancels from any active phase with zero writes", () => {
    const drag = beginSectionDrag("40:1", { x: 0, y: 0 });
    expect(isSectionDragging(drag)).toBe(true);
    expect(cancelSectionDrag()).toBe(IDLE_DRAG);
  });

  it("a moving pointer that never crosses the threshold still commits once when it does", () => {
    let drag = beginSectionDrag("40:1", { x: 0, y: 0 });
    drag = moveSectionDrag(drag, { x: 2, y: 0 }, 1); // below
    drag = moveSectionDrag(drag, { x: 3, y: 0 }, 1); // below
    drag = moveSectionDrag(drag, { x: 50, y: 0 }, 1); // past
    expect(drag.phase).toBe("preview");
    expect(commitSectionDrag(drag)).not.toBeNull();
    // The release consumes the preview: a second resolve writes nothing.
    expect(commitSectionDrag(cancelSectionDrag())).toBeNull();
  });
});

describe("sectionEditing (read-only surfaces must speak up)", () => {
  const live = { capability: true, remoteConnected: true, versionPinned: false };

  it("only capability + connector + not-historical + not-locked can write", () => {
    expect(sectionEditing(live)).toMatchObject({ canEdit: true, notice: null });
    expect(sectionEditing({ ...live, capability: false })).toMatchObject({
      canEdit: false,
      notice: CONNECT_EDITING_NOTICE,
    });
    expect(sectionEditing({ ...live, remoteConnected: false })).toMatchObject({
      canEdit: false,
      notice: CONNECT_EDITING_NOTICE,
    });
    expect(sectionEditing({ ...live, versionPinned: true })).toMatchObject({ canEdit: false });
    expect(sectionEditing({ ...live, locked: true })).toMatchObject({ canEdit: false });
  });

  it("the input is carried through so the caller can build the execute request", () => {
    expect(sectionEditing(live)).toMatchObject({ ...live });
  });
});
