import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { childSummaries } from "./section-outline";

// A depth-1 nodes response carries the SECTION root with its DIRECT children
// only (ADR-0039 — REST verified: children, no grandchildren).
function node(id: string, type: string, extra: Record<string, unknown> = {}): FigmaNode {
  return { id, name: `${type} ${id}`, type, ...extra } as FigmaNode;
}

function section(children: FigmaNode[]): FigmaNode {
  return node("10:1", "SECTION", { children });
}

describe("childSummaries (ADR-0039)", () => {
  it("maps direct children to ordered summaries reparented to the section", () => {
    const summaries = childSummaries(
      section([
        node("10:2", "FRAME", { absoluteBoundingBox: { x: 4, y: 8, width: 100, height: 50 } }),
        node("10:3", "TEXT"),
      ]),
    );
    expect(summaries.map((s) => s.id)).toEqual(["10:2", "10:3"]);
    expect(summaries.every((s) => s.parentId === "10:1")).toBe(true);
    expect(summaries[0].bounds).toEqual({ x: 4, y: 8, width: 100, height: 50 });
  });

  it("marks nested SECTIONs childrenLoaded:false so the sidebar fetches them lazily", () => {
    const summaries = childSummaries(section([node("10:2", "SECTION"), node("10:3", "FRAME")]));
    expect(summaries[0].childrenLoaded).toBe(false);
    expect(summaries[1].childrenLoaded).toBeUndefined();
  });

  it("keeps a real frame a leaf summary — the full tree comes only from expanding it", () => {
    const [frame] = childSummaries(
      section([node("10:9", "INSTANCE", { children: [node("10:10", "RECTANGLE")] })]),
    );
    expect(frame.type).toBe("INSTANCE");
    expect(frame.childrenLoaded).toBeUndefined();
  });

  it("carries the first visible solid fill as #RRGGBBAA", () => {
    const [frame] = childSummaries(
      section([
        node("10:4", "FRAME", {
          fills: [
            { type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1 },
            { type: "SOLID", color: { r: 0, g: 1, b: 0 } },
          ],
        }),
        node("10:5", "FRAME", {
          fills: [{ type: "SOLID", visible: false, color: { r: 0, g: 0, b: 0 } }],
        }),
      ]),
    );
    expect(frame.backgroundColor).toBe("#ff0000ff");
    expect(
      childSummaries(
        section([
          node("10:5", "FRAME", {
            fills: [{ type: "SOLID", visible: false, color: { r: 0, g: 0, b: 0 } }],
          }),
        ]),
      )[0].backgroundColor,
    ).toBeUndefined();
  });

  it("falls back to a zero box when the node carries no absolute bounds", () => {
    const [row] = childSummaries(section([node("10:6", "FRAME")]));
    expect(row.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("ignores malformed children", () => {
    expect(
      childSummaries(section([undefined as unknown as FigmaNode, node("", "RECTANGLE")])),
    ).toHaveLength(1);
    expect(childSummaries(node("10:1", "SECTION", { children: "nope" }) as FigmaNode)).toEqual([]);
  });
});
