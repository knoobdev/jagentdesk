import { describe, expect, it } from "vitest";
import {
  colorToCss,
  figmaColorFromHex,
  firstSolidColor,
  generateNodeCss,
  gradientCss,
  gradientFills,
  isTextLike,
  paddingShorthand,
} from "./css";
import { makeNode } from "./__fixtures__/figma";

function solid(color: Record<string, number>, opacity?: number) {
  return { type: "SOLID", color, ...(opacity === undefined ? {} : { opacity }), visible: true };
}

describe("generateNodeCss", () => {
  it("maps solid fills and geometry", () => {
    const css = generateNodeCss(
      makeNode({
        absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 50 },
        fills: [solid({ r: 1, g: 0, b: 0 })],
        opacity: 0.5,
      }),
    );
    expect(css).toContain("width: 100px;");
    expect(css).toContain("height: 50px;");
    expect(css).toContain("position: absolute;");
    expect(css).toContain("left: 10px;");
    expect(css).toContain("top: 20px;");
    expect(css).toContain("background: rgba(255, 0, 0, 1);");
    expect(css).toContain("opacity: 0.5;");
  });

  it("multiplies paint opacity into the alpha channel", () => {
    const css = generateNodeCss(makeNode({ fills: [solid({ r: 0, g: 0.5, b: 1 }, 0.4)] }));
    expect(css).toContain("background: rgba(0, 128, 255, 0.4);");
  });

  it("skips hidden paints and full-opacity default", () => {
    const css = generateNodeCss(
      makeNode({ fills: [{ ...solid({ r: 0, g: 0, b: 0 }), visible: false }] }),
    );
    expect(css).not.toContain("background");
    expect(css).not.toContain("opacity:");
  });

  it("emits linear and radial gradients with stops", () => {
    const css = generateNodeCss(
      makeNode({
        fills: [
          {
            type: "GRADIENT_LINEAR",
            gradientTransform: [
              [1, 0, 0],
              [0, 1, 0],
            ],
            gradientStops: [
              { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
              { position: 1, color: { r: 0, g: 0, b: 0, a: 1 } },
            ],
            visible: true,
          },
        ],
      }),
    );
    expect(css).toMatch(
      /background: linear-gradient\(\d+deg, rgba\(255, 255, 255, 1\) 0%, rgba\(0, 0, 0, 1\) 100%\);/,
    );
    const radial = generateNodeCss(
      makeNode({
        fills: [
          {
            type: "GRADIENT_RADIAL",
            gradientStops: [{ position: 0.5, color: { r: 1, g: 0, b: 0, a: 1 } }],
            visible: true,
          },
        ],
      }),
    );
    expect(radial).toContain("background: radial-gradient(circle, rgba(255, 0, 0, 1) 50%);");
  });

  it("derives the CSS angle from REST gradientHandlePositions (left→right = 90deg)", () => {
    const css = generateNodeCss(
      makeNode({
        fills: [
          {
            type: "GRADIENT_LINEAR",
            visible: true,
            gradientHandlePositions: [
              { x: 0, y: 0.5 },
              { x: 1, y: 0.5 },
              { x: 0, y: 0 },
            ],
            gradientStops: [
              { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
              { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
            ],
          },
        ],
      }),
    );
    expect(css).toContain(
      "background: linear-gradient(90deg, rgba(255, 0, 0, 1) 0%, rgba(0, 0, 255, 1) 100%);",
    );
  });

  it("derives top→bottom handles as 180deg", () => {
    const css = generateNodeCss(
      makeNode({
        fills: [
          {
            type: "GRADIENT_LINEAR",
            visible: true,
            gradientHandlePositions: [
              { x: 0.5, y: 0 },
              { x: 0.5, y: 1 },
              { x: 0, y: 0 },
            ],
            gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }],
          },
        ],
      }),
    );
    expect(css).toContain("background: linear-gradient(180deg,");
  });

  it("prefers gradientHandlePositions over a stale gradientTransform", () => {
    const css = generateNodeCss(
      makeNode({
        fills: [
          {
            type: "GRADIENT_LINEAR",
            visible: true,
            gradientHandlePositions: [
              { x: 0, y: 0.5 },
              { x: 1, y: 0.5 },
              { x: 0, y: 0 },
            ],
            gradientTransform: [
              [0, -1, 1],
              [1, 0, 0],
            ],
            gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }],
          },
        ],
      }),
    );
    expect(css).toContain("background: linear-gradient(90deg,");
  });

  it("renders radial gradients with a center from handle positions", () => {
    const css = generateNodeCss(
      makeNode({
        fills: [
          {
            type: "GRADIENT_RADIAL",
            visible: true,
            gradientHandlePositions: [
              { x: 0.5, y: 0.5 },
              { x: 1, y: 0.5 },
              { x: 0.5, y: 1 },
            ],
            gradientStops: [
              { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
              { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
            ],
          },
        ],
      }),
    );
    expect(css).toContain("background: radial-gradient(circle at 50% 50%, rgba(255, 0, 0, 1) 0%");
  });

  it("renders angular gradients as conic-gradient", () => {
    const css = generateNodeCss(
      makeNode({
        fills: [
          {
            type: "GRADIENT_ANGULAR",
            visible: true,
            gradientHandlePositions: [
              { x: 0.5, y: 0.5 },
              { x: 1, y: 0.5 },
              { x: 0.5, y: 0 },
            ],
            gradientStops: [
              { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
              { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
            ],
          },
        ],
      }),
    );
    expect(css).toContain("background: conic-gradient(from 90deg at 50% 50%,");
  });

  it("renders diamond gradients as a linear approximation", () => {
    const css = generateNodeCss(
      makeNode({
        fills: [
          {
            type: "GRADIENT_DIAMOND",
            visible: true,
            gradientHandlePositions: [
              { x: 0.5, y: 0 },
              { x: 0.5, y: 1 },
              { x: 0, y: 0.5 },
            ],
            gradientStops: [{ position: 0, color: { r: 1, g: 1, b: 1, a: 1 } }],
          },
        ],
      }),
    );
    expect(css).toContain("background: linear-gradient(180deg,");
  });

  it("gradientCss returns null for non-gradient paints", () => {
    expect(gradientCss({ type: "SOLID", color: { r: 1, g: 1, b: 1 } })).toBeNull();
    expect(gradientCss({ type: "IMAGE", imageRef: "abc" })).toBeNull();
  });

  it("gradientFills exposes gradient type, css and stops for the inspect panel", () => {
    const fills = gradientFills(
      makeNode({
        fills: [
          {
            type: "GRADIENT_LINEAR",
            visible: true,
            gradientHandlePositions: [
              { x: 0, y: 0.5 },
              { x: 1, y: 0.5 },
              { x: 0, y: 0 },
            ],
            gradientStops: [
              { position: 0, color: { r: 0.494, g: 0.827, b: 0.129, a: 1 } },
              { position: 1, color: { r: 0, g: 0.56, b: 0.22, a: 1 } },
            ],
          },
          { type: "SOLID", visible: true, color: { r: 1, g: 1, b: 1, a: 1 } },
        ],
      }),
    );
    expect(fills).toHaveLength(1);
    expect(fills[0].type).toBe("GRADIENT_LINEAR");
    expect(fills[0].css).toContain("linear-gradient(90deg");
    expect(fills[0].stops).toBe("rgba(126, 211, 33, 1) 0%, rgba(0, 143, 56, 1) 100%");
  });

  it("maps corner radii, uniform and per-corner", () => {
    expect(generateNodeCss(makeNode({ cornerRadius: 8 }))).toContain("border-radius: 8px;");
    expect(generateNodeCss(makeNode({ rectangleCornerRadii: [1, 2, 3, 4] }))).toContain(
      "border-radius: 1px 2px 3px 4px;",
    );
  });

  it("maps strokes to borders and dashed patterns", () => {
    const css = generateNodeCss(
      makeNode({
        strokes: [solid({ r: 0, g: 0, b: 0 })],
        strokeWeight: 2,
        dashPattern: [4, 4],
      }),
    );
    expect(css).toContain("border: 2px solid rgba(0, 0, 0, 1);");
    expect(css).toContain("box-sizing: border-box;");
    expect(css).toContain("border-style: dashed;");
    expect(
      generateNodeCss(makeNode({ strokes: [solid({ r: 0, g: 0, b: 0 })], strokeWeight: 0 })),
    ).not.toContain("border:");
  });

  it("maps shadows from the REST radius field, spread defaults to 0", () => {
    const css = generateNodeCss(
      makeNode({
        effects: [
          {
            type: "DROP_SHADOW",
            visible: true,
            color: { r: 0, g: 0, b: 0, a: 0.25 },
            offset: { x: 0, y: 6 },
            radius: 16,
          },
        ],
      }),
    );
    expect(css).toContain("box-shadow: 0px 6px 16px 0px rgba(0, 0, 0, 0.25);");
  });

  it("maps inner shadows with inset, spread and multiple shadows", () => {
    const css = generateNodeCss(
      makeNode({
        effects: [
          {
            type: "INNER_SHADOW",
            visible: true,
            color: { r: 0, g: 0, b: 0, a: 1 },
            offset: { x: 1, y: 1 },
            radius: 2,
            spread: 3,
          },
          {
            type: "DROP_SHADOW",
            visible: true,
            color: { r: 0, g: 0, b: 0, a: 0.1 },
            offset: { x: 0, y: 4 },
            radius: 12,
            spread: 1,
          },
          { type: "DROP_SHADOW", visible: false, color: { r: 0, g: 0, b: 0, a: 1 } },
        ],
      }),
    );
    expect(css).toContain("box-shadow: inset 1px 1px 2px 3px rgba(0, 0, 0, 1),");
    expect(css).toContain("0px 4px 12px 1px rgba(0, 0, 0, 0.1);");
  });

  it("maps layer blur to filter and background blur to backdrop-filter", () => {
    const css = generateNodeCss(
      makeNode({
        effects: [
          { type: "LAYER_BLUR", visible: true, radius: 5 },
          { type: "BACKGROUND_BLUR", visible: true, radius: 8 },
        ],
      }),
    );
    expect(css).toContain("filter: blur(5px);");
    expect(css).toContain("backdrop-filter: blur(8px);");
  });

  it("maps auto layout to flex", () => {
    const css = generateNodeCss(
      makeNode({
        layoutMode: "HORIZONTAL",
        itemSpacing: 8,
        paddingLeft: 16,
        paddingRight: 16,
        paddingTop: 16,
        paddingBottom: 16,
        primaryAxisAlignItems: "SPACE_BETWEEN",
        counterAxisAlignItems: "CENTER",
        layoutWrap: "WRAP",
      }),
    );
    expect(css).toContain("display: flex;");
    expect(css).toContain("flex-direction: row;");
    expect(css).toContain("gap: 8px;");
    expect(css).toContain("padding: 16px;");
    expect(css).toContain("justify-content: space-between;");
    expect(css).toContain("align-items: center;");
    expect(css).toContain("flex-wrap: wrap;");
  });

  it("collapses padding to the shortest CSS shorthand", () => {
    expect(paddingShorthand(16, 16, 16, 16)).toBe("16px");
    expect(paddingShorthand(10, 20, 10, 20)).toBe("10px 20px");
    expect(paddingShorthand(10, 20, 30, 40)).toBe("10px 20px 30px 40px");
    expect(paddingShorthand(undefined, 8, undefined, 8)).toBe("0px 8px");
    const css = generateNodeCss(
      makeNode({
        layoutMode: "VERTICAL",
        paddingTop: 12,
        paddingRight: 24,
        paddingBottom: 12,
        paddingLeft: 24,
      }),
    );
    expect(css).toContain("padding: 12px 24px;");
    const asymmetric = generateNodeCss(
      makeNode({
        layoutMode: "HORIZONTAL",
        paddingTop: 4,
        paddingRight: 8,
        paddingBottom: 12,
        paddingLeft: 16,
      }),
    );
    expect(asymmetric).toContain("padding: 4px 8px 12px 16px;");
  });

  it("maps text styles and uses fills for the text color", () => {
    const css = generateNodeCss(
      makeNode({
        type: "TEXT",
        characters: "hi",
        fills: [solid({ r: 0.1, g: 0.2, b: 0.3 })],
        style: {
          fontName: { family: "Inter", style: "Bold Italic" },
          fontSize: 16,
          lineHeightPx: 24,
          letterSpacing: 0.5,
          textAlignHorizontal: "CENTER",
          textDecoration: "UNDERLINE",
          textCase: "UPPER",
        },
      }),
    );
    expect(css).toContain('font-family: "Inter";');
    expect(css).toContain("font-weight: 700;");
    expect(css).toContain("font-style: italic;");
    expect(css).toContain("font-size: 16px;");
    expect(css).toContain("line-height: 24px;");
    expect(css).toContain("letter-spacing: 0.5px;");
    expect(css).toContain("text-align: center;");
    expect(css).toContain("text-decoration: underline;");
    expect(css).toContain("text-transform: uppercase;");
    expect(css).toContain("color: rgba(26, 51, 77, 1);");
    expect(css).not.toContain("background:");
  });

  it("supports PERCENT letter-spacing and lineHeight", () => {
    const css = generateNodeCss(
      makeNode({
        type: "TEXT",
        style: {
          fontSize: 20,
          letterSpacing: { unit: "PERCENT", value: 5 },
          lineHeightPercent: 150,
        },
      }),
    );
    expect(css).toContain("letter-spacing: 0.05em;");
    expect(css).toContain("line-height: 30px;");
  });

  it("maps blend modes and skips NORMAL", () => {
    expect(generateNodeCss(makeNode({ blendMode: "MULTIPLY" }))).toContain(
      "mix-blend-mode: multiply;",
    );
    expect(generateNodeCss(makeNode({ blendMode: "NORMAL" }))).not.toContain("mix-blend-mode");
    expect(generateNodeCss(makeNode({ blendMode: "NOT_A_MODE" }))).not.toContain("mix-blend-mode");
  });

  it("tolerates partial nodes", () => {
    expect(generateNodeCss(makeNode({}))).toBe("");
  });
});

describe("color helpers", () => {
  it("clamps channels and rounds alpha", () => {
    expect(colorToCss({ r: 2, g: -1, b: 0.5019607843 }, 0.1234)).toBe("rgba(255, 0, 128, 0.12)");
  });

  it("parses hex colors", () => {
    expect(figmaColorFromHex("#ff0000")).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    const withAlpha = figmaColorFromHex("#00ff0080");
    expect(withAlpha?.r).toBe(0);
    expect(withAlpha?.g).toBeCloseTo(1, 3);
    expect(withAlpha?.a).toBeCloseTo(0.5, 2);
    expect(() => figmaColorFromHex("nope")).toThrow(/hex/);
  });

  it("reads the first visible solid fill", () => {
    const node = makeNode({
      fills: [
        { type: "SOLID", color: { r: 0, g: 0, b: 0 }, visible: false },
        { type: "SOLID", color: { r: 1, g: 1, b: 1 } },
      ],
    });
    expect(firstSolidColor(node)).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(firstSolidColor(makeNode({ fills: [] }))).toBeNull();
  });

  it("flags text nodes", () => {
    expect(isTextLike(makeNode({ type: "TEXT" }))).toBe(true);
    expect(isTextLike(makeNode({ type: "FRAME" }))).toBe(false);
  });
});
