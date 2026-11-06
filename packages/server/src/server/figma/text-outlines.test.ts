import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { extractFrameTextOutlines } from "./text-outlines.js";
import { prepareFrameTextOutlines } from "./prepare-text-outlines.js";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80" viewBox="0 0 100 80" fill="none"><defs><clipPath id="clip"><rect width="100" height="80"/></clipPath><g id="unused"><path d="M0 0"/></g></defs><g data-node-id="frame_a"><g data-node-id="text_a" clip-path="url(#clip)"><path d="M10 15h20v10H10Z" fill="#112233"/></g></g></svg>`;
const text: FigmaNode = {
  id: "text_a",
  type: "TEXT",
  name: "<text-layer>",
  absoluteBoundingBox: { x: 210, y: 315, width: 30, height: 20 },
  fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } }],
};
const root: FigmaNode = {
  id: "frame_a",
  type: "FRAME",
  name: "<frame>",
  absoluteBoundingBox: { x: 200, y: 300, width: 100, height: 80 },
  children: [text],
};

describe("frame SVG text outlines", () => {
  it("isolates the exact text ID in its absolute layout box and copies only referenced definitions", () => {
    const result = extractFrameTextOutlines(SVG, root);
    expect([...result.keys()]).toEqual(["text_a"]);
    const glyph = result.get("text_a")!;
    expect(glyph).toContain('viewBox="0 0 30 20"');
    expect(glyph).toContain("translate(-10 -15)");
    expect(glyph).toContain('d="M10 15h20v10H10Z"');
    expect(glyph).toContain('<clipPath id="clip">');
    expect(glyph).not.toContain('id="unused"');
    expect(glyph).not.toContain('data-node-id="frame_a"');
  });

  it("keeps SVG ancestor translations while excluding opacity already applied by the layer renderer", () => {
    const input = SVG.replace(
      '<g data-node-id="frame_a">',
      '<g data-node-id="frame_a" transform="translate(4 6)" opacity="0.5">',
    );
    const glyph = extractFrameTextOutlines(input, root).get("text_a")!;
    expect(glyph).toContain('transform="translate(4 6)"');
    expect(glyph).not.toContain('opacity="0.5"');
  });

  it("preserves Figma's rounded-up export viewport for fractional text layout dimensions", () => {
    const glyph = extractFrameTextOutlines(SVG, {
      ...root,
      children: [{ ...text, absoluteBoundingBox: { x: 210, y: 315, width: 30.25, height: 20.5 } }],
    }).get("text_a");
    expect(glyph).toContain('viewBox="0 0 31 21"');
    expect(glyph).toContain("translate(-10 -15)");
  });

  it("leaves text under a rotated or scaled ancestor on the normal per-node export path", () => {
    const rotated: FigmaNode = {
      id: "group_a",
      name: "<group>",
      type: "GROUP",
      relativeTransform: [
        [0, -1, 40],
        [1, 0, 20],
      ],
      children: [text],
    };
    expect(extractFrameTextOutlines(SVG, { ...root, children: [rotated] }).size).toBe(0);
    const translated = {
      ...rotated,
      relativeTransform: [
        [1, 0, 40],
        [0, 1, 20],
      ],
    };
    expect(extractFrameTextOutlines(SVG, { ...root, children: [translated] }).has("text_a")).toBe(
      true,
    );
  });

  it("does not manufacture a glyph for a missing ID, mismatched viewport, SECTION, or complex text", () => {
    expect(
      extractFrameTextOutlines(SVG.replace('data-node-id="text_a"', 'data-node-id="text_b"'), root)
        .size,
    ).toBe(0);
    expect(
      extractFrameTextOutlines(SVG.replace('viewBox="0 0 100 80"', 'viewBox="0 0 101 80"'), root)
        .size,
    ).toBe(0);
    expect(extractFrameTextOutlines(SVG, { ...root, type: "SECTION" }).size).toBe(0);
    expect(
      extractFrameTextOutlines(SVG, { ...root, children: [{ ...text, opacity: 0.5 }] }).size,
    ).toBe(0);
    expect(
      extractFrameTextOutlines(
        SVG.replace('clip-path="url(#clip)"', 'transform="rotate(30)"'),
        root,
      ).size,
    ).toBe(0);
  });

  it.each([
    '<!DOCTYPE svg [<!ENTITY remote SYSTEM "file:///etc/passwd">]>',
    SVG.replace('clip-path="url(#clip)"', 'onload="alert(1)"'),
    SVG.replace('<path d="M10 15h20v10H10Z" fill="#112233"/>', "<script/>"),
    SVG.replace('<path d="M10 15h20v10H10Z" fill="#112233"/>', '<use href="https://figma.com/"/>'),
    SVG.replace('clip-path="url(#clip)"', 'clip-path="url(https://figma.com/)"'),
    SVG.replace('data-node-id="frame_a"', 'data-node-id="text_a"'),
    SVG.replace('fill="none"', 'fill="url(https://figma.com/)"'),
  ])("rejects unsafe, executable, externally referenced or ambiguous SVG", (input) => {
    expect(extractFrameTextOutlines(input, root).size).toBe(0);
  });
});

describe("parallel text preparation", () => {
  it("does not hold a node response while the frame export is pending, then warms exact glyph IDs", async () => {
    let finishExport!: (svg: string) => void;
    let cached!: () => void;
    const written = new Promise<void>((resolve) => {
      cached = resolve;
    });
    const glyphs = new Map<string, string>();
    const work = prepareFrameTextOutlines({
      exportSvg: () =>
        new Promise((resolve) => {
          finishExport = resolve;
        }),
      cacheGlyph: async (id, svg) => {
        glyphs.set(id, svg);
        cached();
      },
    });
    await work.finish(root);
    expect(glyphs.size).toBe(0);
    finishExport(SVG);
    await written;
    expect([...glyphs.keys()]).toEqual(["text_a"]);
  });

  it("leaves the normal render path available when the speculative export fails", async () => {
    let writes = 0;
    const work = prepareFrameTextOutlines({
      exportSvg: async () => {
        throw new Error("Export failed.");
      },
      cacheGlyph: async () => {
        writes++;
      },
    });
    await work.finish(root);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writes).toBe(0);
  });
});
