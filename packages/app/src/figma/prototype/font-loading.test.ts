import { describe, expect, it, vi } from "vitest";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  collectRequiredFonts,
  createFontGate,
  googleFontsCssHref,
  isItalicStyle,
  weightForStyle,
  type FontLoadDeps,
} from "./font-loading";
import { node } from "./test-support/frames";

function textNode(
  id: string,
  fontName: { family: string; style: string },
  characters = "hello",
): ReturnType<typeof node> {
  const built = node({ id, name: id, type: "TEXT", width: 120, height: 16 });
  built.characters = characters;
  built.style = { fontFamily: fontName.family, fontStyle: fontName.style, fontSize: 16 };
  return built;
}

describe("collectRequiredFonts", () => {
  it("lists every family/style the visible TEXT nodes ask for, deduplicated", () => {
    const frame = node({
      id: "1:1",
      name: "Home",
      children: [
        textNode("1:2", { family: "Inter", style: "Regular" }),
        textNode("1:3", { family: "Inter", style: "Regular" }),
        textNode("1:4", { family: "Roboto", style: "Bold" }),
        node({ id: "1:5", name: "Hidden", visible: false }),
      ],
    });
    expect(collectRequiredFonts(frame)).toEqual([
      { family: "Inter", style: "Regular" },
      { family: "Roboto", style: "Bold" },
    ]);
  });

  it("includes per-character style overrides", () => {
    const built = textNode("1:2", { family: "Inter", style: "Regular" }, "ab");
    built.characterStyleOverrides = [0, 1];
    built.styleOverrideTable = {
      "1": { fontFamily: "Inter", fontStyle: "Medium", fontSize: 16 },
    };
    expect(collectRequiredFonts(built)).toEqual([
      { family: "Inter", style: "Regular" },
      { family: "Inter", style: "Medium" },
    ]);
  });

  it("skips nodes with no text and the generic stack", () => {
    expect(collectRequiredFonts(node({ id: "1:1", name: "F" }))).toEqual([]);
    expect(
      collectRequiredFonts(textNode("1:2", { family: "sans-serif", style: "Regular" })),
    ).toEqual([]);
  });
});

describe("weightForStyle / isItalicStyle", () => {
  it("maps style names onto css weights and italics", () => {
    expect(weightForStyle("Bold")).toBe(700);
    expect(weightForStyle("Semi Bold")).toBe(600);
    expect(weightForStyle("Weird Custom Name")).toBe(400);
    expect(isItalicStyle("Italic")).toBe(true);
    expect(isItalicStyle("Bold Italic")).toBe(true);
    expect(isItalicStyle("Regular")).toBe(false);
  });
});

describe("googleFontsCssHref", () => {
  it("builds a css2 URL with the weights the file uses", () => {
    const href = googleFontsCssHref([
      { family: "Inter", style: "Regular" },
      { family: "Inter", style: "Bold" },
      { family: "Roboto", style: "Medium" },
    ]);
    expect(href).toBe(
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;700&family=Roboto:wght@500&display=swap",
    );
  });

  it("returns null when no family is served by Google Fonts", () => {
    expect(googleFontsCssHref([{ family: "Helvetica Now Display", style: "Regular" }])).toBeNull();
    expect(googleFontsCssHref([])).toBeNull();
  });
});

function depsWith(overrides: Partial<FontLoadDeps> = {}): FontLoadDeps {
  return {
    appendStylesheet: vi.fn(async () => undefined),
    loadFontBytes: vi.fn(async (): Promise<FigmaBytes | null> => null),
    registerFontFace: vi.fn(async () => true),
    isFontLoaded: vi.fn(() => false),
    fontsReady: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("createFontGate", () => {
  it("loads Google families via CSS, unknown families via font bytes, and waits for the browser", async () => {
    const deps = depsWith({
      // The stylesheet mock stands in for a successful Google load: Inter is usable afterwards,
      // so the bytes path must only run for the family Google does not serve.
      isFontLoaded: vi.fn((family: string) => family === "Inter"),
      loadFontBytes: vi.fn(
        async (family): Promise<FigmaBytes | null> =>
          family === "Helvetica Now Display"
            ? { mimeType: "font/woff2", dataBase64: "AAAA" }
            : null,
      ),
    });
    const gate = createFontGate(deps);
    await gate.load([
      { family: "Inter", style: "Regular" },
      { family: "Helvetica Now Display", style: "Regular" },
    ]);
    expect(deps.appendStylesheet).toHaveBeenCalledWith(
      "https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap",
    );
    expect(deps.loadFontBytes).toHaveBeenCalledWith("Helvetica Now Display", "Regular");
    expect(deps.loadFontBytes).not.toHaveBeenCalledWith("Inter", "Regular");
    expect(deps.fontsReady).toHaveBeenCalled();
  });

  it("reports availability honestly: false while nothing loaded, true only once usable", async () => {
    const deps = depsWith({
      loadFontBytes: vi.fn(
        async (): Promise<FigmaBytes | null> => ({
          mimeType: "font/woff2",
          dataBase64: "AAAA",
        }),
      ),
    });
    const gate = createFontGate(deps);
    expect(gate.fontAvailable("Inter", "Regular")).toBe(false);
    await gate.load([{ family: "Inter", style: "Regular" }]);
    expect(gate.fontAvailable("Inter", "Regular")).toBe(true);
    expect(gate.fontAvailable("Unknown Family", "Regular")).toBe(false);
  });

  it("falls back to the generic stack when the bytes are missing, never to a lie", async () => {
    const deps = depsWith({ loadFontBytes: vi.fn(async () => null) });
    const gate = createFontGate(deps);
    await gate.load([{ family: "Proxima Nova", style: "Regular" }]);
    expect(gate.fontAvailable("Proxima Nova", "Regular")).toBe(false);
    expect(deps.registerFontFace).not.toHaveBeenCalled();
  });

  it("treats already-usable families as available without fetching them", async () => {
    const deps = depsWith({ isFontLoaded: vi.fn(() => true) });
    const gate = createFontGate(deps);
    await gate.load([{ family: "Arial", style: "Regular" }]);
    expect(deps.loadFontBytes).not.toHaveBeenCalled();
    expect(gate.fontAvailable("Arial", "Regular")).toBe(true);
  });

  it("survives a failing stylesheet and failing bytes without rejecting", async () => {
    const deps = depsWith({
      appendStylesheet: vi.fn(async () => {
        throw new Error("offline");
      }),
      loadFontBytes: vi.fn(async () => {
        throw new Error("500");
      }),
    });
    const gate = createFontGate(deps);
    await expect(gate.load([{ family: "Inter", style: "Regular" }])).resolves.toBeUndefined();
    expect(gate.fontAvailable("Inter", "Regular")).toBe(false);
  });
});
