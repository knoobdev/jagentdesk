import { describe, expect, it } from "vitest";
import { interpolateLayer, matchLayers, smartAnimateOverrides } from "./smart-animate";
import { node, smartAnimatePair } from "./test-support/frames";

describe("matchLayers", () => {
  it("pairs layers by name path below the frame", () => {
    const { from, to } = smartAnimatePair();
    const paths = matchLayers(from, to).map((pair) => pair.path);
    expect(paths).toEqual(expect.arrayContaining(["Card", "Card/Title", "Card/Button"]));
    expect(paths).not.toContain("Only In A");
  });

  it("pairs duplicate paths in document order", () => {
    const shared = (ids: string[]): ReturnType<typeof node>[] =>
      ids.map((id) => node({ id, name: "Chip", type: "RECTANGLE" }));
    const from = node({ id: "1:0", name: "A", children: shared(["1:1", "1:2"]) });
    const to = node({ id: "2:0", name: "B", children: shared(["2:1", "2:2", "2:3"]) });
    expect(matchLayers(from, to)).toEqual([
      { fromId: "1:1", toId: "2:1", path: "Chip" },
      { fromId: "1:2", toId: "2:2", path: "Chip" },
    ]);
  });

  it("ignores invisible layers", () => {
    const from = node({
      id: "1:0",
      name: "A",
      children: [node({ id: "1:1", name: "Ghost", visible: false })],
    });
    const to = node({ id: "2:0", name: "B", children: [node({ id: "2:1", name: "Ghost" })] });
    expect(matchLayers(from, to)).toEqual([]);
  });
});

describe("interpolateLayer", () => {
  it("blends position, size, opacity, radius and colour at the midpoint", () => {
    const from = node({
      id: "1:1",
      name: "Button",
      type: "RECTANGLE",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      color: [0, 0, 1, 1],
      cornerRadius: 4,
      opacity: 1,
    });
    const to = node({
      id: "2:1",
      name: "Button",
      type: "RECTANGLE",
      x: 200,
      y: 80,
      width: 200,
      height: 40,
      color: [1, 0, 0, 1],
      cornerRadius: 20,
      opacity: 0.5,
    });
    expect(interpolateLayer(from, to, 0.5)).toEqual({
      x: 100,
      y: 40,
      width: 150,
      height: 40,
      opacity: 0.75,
      cornerRadius: 12,
      color: { r: 0.5, g: 0, b: 0.5, a: 1 },
    });
  });

  it("takes the endpoints exactly", () => {
    const { from, to } = smartAnimatePair();
    const fromButton = from.children?.[0].children?.[1];
    const toButton = to.children?.[0].children?.[1];
    if (!fromButton || !toButton) throw new Error("fixture missing buttons");
    expect(interpolateLayer(fromButton, toButton, 0).x).toBe(30);
    expect(interpolateLayer(fromButton, toButton, 1).x).toBe(530);
  });

  it("leaves colour null when either side has no solid fill", () => {
    const plain = node({ id: "9:1", name: "Text", type: "TEXT" });
    const { to } = smartAnimatePair();
    const button = to.children?.[0].children?.[1];
    if (!button) throw new Error("fixture missing button");
    expect(interpolateLayer(plain, button, 0.5).color).toBeNull();
  });
});

describe("smartAnimateOverrides", () => {
  it("gives matched layers mid-frame values on the incoming side at t=0.5", () => {
    const { from, to } = smartAnimatePair();
    const frame = smartAnimateOverrides(from, to, 0.5);
    const button = frame.to["2:4"];
    const box = button?.absoluteBoundingBox as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    expect(box).toBeDefined();
    // Frame-local blend: Button sits at (30, 90) in A and (30, 190) in B (both relative to the
    // frame origin), so mid-frame the morph lands at (30, 140) local → (530, 140) absolute.
    expect(box.x).toBeCloseTo(530, 5);
    expect(box.y).toBeCloseTo(140, 5);
    expect(box.width).toBeCloseTo(150, 5);
    expect(button.opacity).toBeCloseTo(0.75, 5);
    expect(button.cornerRadius).toBeCloseTo(12, 5);
    const fills = button.fills as { type: string; color: { r: number; g: number; b: number } }[];
    expect(fills[0].color).toMatchObject({ r: 0.5, g: 0, b: 0.5 });
  });

  it("hides matched layers on the outgoing frame", () => {
    const { from, to } = smartAnimatePair();
    const frame = smartAnimateOverrides(from, to, 0.5);
    expect(frame.from["1:4"]).toEqual({ opacity: 0 });
    expect(frame.to["1:4"]).toBeUndefined();
  });

  it("crossfades unmatched layers", () => {
    const { from, to } = smartAnimatePair();
    const frame = smartAnimateOverrides(from, to, 0.75);
    expect(frame.from["1:5"]?.opacity).toBeCloseTo(0.25, 5);
    expect(frame.to["2:6"]?.opacity).toBeCloseTo(0.75, 5);
  });

  it("resolves to plain geometry at t=1", () => {
    const { from, to } = smartAnimatePair();
    const frame = smartAnimateOverrides(from, to, 1);
    const button = frame.to["2:4"]?.absoluteBoundingBox as { x: number; y: number };
    expect(button.x).toBe(530);
    expect(button.y).toBe(190);
  });
});
