import { describe, expect, it, vi } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { makeFrameSummary, makeNode } from "./__fixtures__/figma";
import {
  childSummaries,
  flattenVisibleRoots,
  isSectionSummary,
  type SectionAwareSummary,
} from "./section-outline";

// ADR-0039: a SECTION is background + label, never a full-tree load unit. Its direct children
// are derived from a real depth-1 payload, and the flattening that feeds painting, culling,
// hit-testing and Inspect happens exactly once per id.

function child(id: string, type: string, bounds = { x: 10, y: 20, width: 100, height: 80 }) {
  return makeNode({ id, name: `Child ${id}`, type, absoluteBoundingBox: bounds });
}

describe("childSummaries", () => {
  it("derives real geometry, identity and parentId from the depth-1 payload", () => {
    const section = makeNode({
      id: "10:1",
      type: "SECTION",
      children: [child("10:2", "FRAME"), child("10:3", "TEXT")] as FigmaNode[],
    });
    const summaries = childSummaries(section);
    expect(summaries).toEqual([
      {
        id: "10:2",
        name: "Child 10:2",
        type: "FRAME",
        bounds: { x: 10, y: 20, width: 100, height: 80 },
        parentId: "10:1",
      },
      {
        id: "10:3",
        name: "Child 10:3",
        type: "TEXT",
        bounds: { x: 10, y: 20, width: 100, height: 80 },
        parentId: "10:1",
      },
    ]);
  });

  it("marks a child SECTION as a truncation boundary without touching its own children", () => {
    const section = makeNode({
      id: "10:1",
      type: "SECTION",
      children: [child("10:9", "SECTION")] as FigmaNode[],
    });
    const summaries = childSummaries(section);
    expect(summaries[0]).toMatchObject({ id: "10:9", type: "SECTION", childrenLoaded: false });
    // The FRAME sibling keeps no childrenLoaded flag: its subtree arrives via a full load.
    const framesOnly = childSummaries(
      makeNode({ id: "10:1", type: "SECTION", children: [child("10:2", "FRAME")] as FigmaNode[] }),
    );
    expect(framesOnly[0]).not.toHaveProperty("childrenLoaded");
  });

  it("skips children without a real bounding box — nothing is fabricated", () => {
    const section = makeNode({
      id: "10:1",
      type: "SECTION",
      children: [makeNode({ id: "10:2", type: "FRAME" }), child("10:3", "FRAME")] as FigmaNode[],
    });
    expect(childSummaries(section).map((s) => s.id)).toEqual(["10:3"]);
  });

  it("drops malformed children instead of inventing fields for them", () => {
    const section = makeNode({
      id: "10:1",
      type: "SECTION",
      children: [
        null,
        { id: "10:4" }, // no name
        { name: "no id" },
        child("10:5", "FRAME"),
      ] as unknown as FigmaNode[],
    });
    expect(childSummaries(section).map((s) => s.id)).toEqual(["10:5"]);
  });

  it("returns nothing for a section with no children array", () => {
    expect(childSummaries(makeNode({ id: "10:1", type: "SECTION" }))).toEqual([]);
  });
});

describe("flattenVisibleRoots", () => {
  const section = (id: string, extra: Partial<SectionAwareSummary> = {}): SectionAwareSummary =>
    ({
      ...makeFrameSummary(id, 0, 0, 1000, 800),
      type: "SECTION",
      ...extra,
    }) as SectionAwareSummary;

  it("keeps non-SECTION roots as-is and Sections unexpanded while children are unknown", () => {
    const frames = [makeFrameSummary("1:1", 0, 0, 100, 100), section("10:1")];
    const roots = flattenVisibleRoots(frames, () => undefined);
    expect(roots.map((r) => r.id)).toEqual(["1:1", "10:1"]);
    expect(roots[1]).toMatchObject({ type: "SECTION" });
  });

  it("expands a boundary Section in place and recurses into nested Sections", () => {
    const outer = section("10:1", { childrenLoaded: false });
    const inner = section("10:9", { childrenLoaded: false });
    const c1 = { ...makeFrameSummary("10:2", 5, 5, 100, 80), parentId: "10:1" };
    const byId: Record<string, ReturnType<typeof childSummaries> | undefined> = {
      "10:1": [c1, inner],
      "10:9": [{ ...makeFrameSummary("10:10", 6, 6, 50, 50), parentId: "10:9" }],
    };
    const roots = flattenVisibleRoots([outer], (id) => byId[id]);
    expect(roots.map((r) => r.id)).toEqual(["10:1", "10:2", "10:9", "10:10"]);
  });

  it("never draws an id twice when the outline already flattened a Section child", () => {
    const outer = section("10:1", { childrenLoaded: false });
    const listed = { ...makeFrameSummary("10:2", 5, 5, 100, 80), parentId: "10:1" };
    const roots = flattenVisibleRoots([outer, listed], () => [listed]);
    expect(roots.map((r) => r.id)).toEqual(["10:1", "10:2"]);
  });

  it("does not expand a Section whose childrenLoaded is true or absent", () => {
    const loaded = section("10:1", { childrenLoaded: true });
    const unknown = section("10:2");
    const reader = vi.fn(() => undefined);
    const roots = flattenVisibleRoots([loaded, unknown], reader);
    expect(roots.map((r) => r.id)).toEqual(["10:1", "10:2"]);
    expect(reader).not.toHaveBeenCalled();
  });

  it("isSectionSummary keys on the wire type", () => {
    expect(isSectionSummary({ type: "SECTION" })).toBe(true);
    expect(isSectionSummary({ type: "FRAME" })).toBe(false);
  });
});
