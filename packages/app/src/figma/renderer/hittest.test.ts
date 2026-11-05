// Geometric hit testing (spec 32.5.1): topmost node in paint order, visibility, opacity, parent
// clipping, masks and exact shape geometry. Runs against the fixture nodes in __fixtures__/nodes.
import { describe, expect, it } from "vitest";
import { createFigmaRenderer } from "./index";
import { loadNode } from "./renderer-fixtures.test";

const renderer = createFigmaRenderer();
const hit = (name: string, x: number, y: number) => renderer.hitTest(loadNode(name), { x, y });

describe("hitTest paint order", () => {
  it("returns the topmost overlapping node", () => {
    expect(hit("hit-order", 30, 30)?.id).toBe("20:3");
  });

  it("returns the lower node where only it is under the point", () => {
    expect(hit("hit-order", 12, 12)?.id).toBe("20:2");
  });

  it("falls back to the parent frame when no child covers the point", () => {
    expect(hit("hit-order", 5, 5)?.id).toBe("20:1");
  });

  it("returns null outside every node", () => {
    expect(hit("hit-order", 200, 200)).toBeNull();
    expect(hit("hit-order", Number.NaN, 10)).toBeNull();
  });
});

describe("hitTest shape geometry", () => {
  it("tests an ellipse against its curve, not its box", () => {
    expect(hit("hit-ellipse", 50, 50)?.id).toBe("21:1");
    expect(hit("hit-ellipse", 95, 95)).toBeNull();
  });

  it("tests vector paths with their winding rule", () => {
    // The fixture is an even-odd ring: outside r5 the point hits, inside the hole it does not.
    expect(hit("vector-evenodd", 2, 10)?.id).toBe("1:9");
    expect(hit("vector-evenodd", 10, 10)).toBeNull();
    expect(hit("vector-evenodd", 1, 1)).toBeNull();
  });

  it("respects node rotation", () => {
    expect(hit("rotated-rectangle", 13.64, 13.64)?.id).toBe("11:1");
    expect(hit("rotated-rectangle", -13, -13)).toBeNull();
  });
});

describe("hitTest visibility and opacity", () => {
  it("skips invisible nodes", () => {
    expect(hit("hit-hidden", 25, 25)?.id).toBe("24:2");
  });

  it("skips fully transparent nodes", () => {
    expect(hit("hit-zero-opacity", 20, 20)?.id).toBe("25:1");
  });
});

describe("hitTest clipping and masks", () => {
  it("does not return children clipped out of their frame", () => {
    expect(hit("hit-clipped", 120, 120)).toBeNull();
    expect(hit("hit-clipped", 90, 90)?.id).toBe("22:2");
  });

  it("never returns the mask itself, and masks clip siblings", () => {
    // 10:3 is the 80x40 rectangle, 10:2 the 100x60 mask; nothing is hit outside the mask box.
    expect(hit("mask-alpha-clips-siblings", 90, 10)?.id).toBe("10:1");
    expect(hit("mask-alpha-clips-siblings", 40, 20)?.id).toBe("10:3");
    const probe = (x: number, y: number) => hit("mask-alpha-clips-siblings", x, y);
    for (const [x, y] of [
      [5, 5],
      [50, 30],
      [99, 59],
    ]) {
      expect(probe(x, y)?.id).not.toBe("10:2");
    }
  });
});
