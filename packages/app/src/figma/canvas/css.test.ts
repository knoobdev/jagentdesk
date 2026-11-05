import { describe, expect, it } from "vitest";
import { colorToCss, figmaColorFromHex, firstSolidColor, generateNodeCss, isTextLike } from "./css";
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

  it("maps shadows and layer blur", () => {
    const css = generateNodeCss(
      makeNode({
        effects: [
          {
            type: "DROP_SHADOW",
            visible: true,
            color: { r: 0, g: 0, b: 0, a: 0.25 },
            offset: { x: 0, y: 4 },
            blur: 12,
            spread: 1,
          },
          {
            type: "INNER_SHADOW",
            visible: true,
            color: { r: 0, g: 0, b: 0, a: 1 },
            offset: { x: 1, y: 1 },
            blur: 2,
            spread: 0,
          },
          { type: "LAYER_BLUR", visible: true, radius: 5 },
        ],
      }),
    );
    expect(css).toContain("box-shadow: 0px 4px 12px 1px rgba(0, 0, 0, 0.25)");
    expect(css).toContain("inset 1px 1px 2px 0px rgba(0, 0, 0, 1)");
    expect(css).toContain("filter: blur(5px);");
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
    expect(css).toContain("padding: 16px 16px 16px 16px;");
    expect(css).toContain("justify-content: space-between;");
    expect(css).toContain("align-items: center;");
    expect(css).toContain("flex-wrap: wrap;");
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
