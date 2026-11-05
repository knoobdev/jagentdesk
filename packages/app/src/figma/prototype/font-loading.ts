import type { FigmaBytes, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { textRuns } from "../renderer/node-props";
import { walkNodes } from "./node-geometry";

// Font loading for the player (spec 32.5.3): the renderer never loads fonts — it asks
// `fontAvailable` per family and falls back to its generic stack, so the player must load what
// the frame uses before the first paint or every TEXT node lands on the browser default (serif).
// Families Google Fonts serves come from its CSS; everything else rides the daemon's
// `figma.fonts.get` bytes (32.8) registered through the FontFace API. DOM access stays behind
// the injected deps so this module runs, and is tested, without one.

export interface RequiredFont {
  family: string;
  style: string;
}

/** Google Fonts families the player can pull by CSS URL; keys are lowercased family names. */
const GOOGLE_FONTS: Record<string, string> = {
  roboto: "Roboto",
  "roboto mono": "Roboto Mono",
  "roboto condensed": "Roboto Condensed",
  inter: "Inter",
  "open sans": "Open Sans",
  lato: "Lato",
  "source sans 3": "Source Sans 3",
  "source sans pro": "Source Sans Pro",
  "source serif pro": "Source Serif Pro",
  montserrat: "Montserrat",
  poppins: "Poppins",
  nunito: "Nunito",
  "nunito sans": "Nunito Sans",
  "work sans": "Work Sans",
  manrope: "Manrope",
  "dm sans": "DM Sans",
  "space grotesk": "Space Grotesk",
  "space mono": "Space Mono",
  "ibm plex sans": "IBM Plex Sans",
  "ibm plex mono": "IBM Plex Mono",
  "ibm plex serif": "IBM Plex Serif",
  "jetbrains mono": "JetBrains Mono",
  "fira sans": "Fira Sans",
  "fira code": "Fira Code",
  karla: "Karla",
  rubik: "Rubik",
  oswald: "Oswald",
  raleway: "Raleway",
  merriweather: "Merriweather",
  "playfair display": "Playfair Display",
  "libre franklin": "Libre Franklin",
  "pt sans": "PT Sans",
  ubuntu: "Ubuntu",
  barlow: "Barlow",
  figtree: "Figtree",
  sora: "Sora",
  "plus jakarta sans": "Plus Jakarta Sans",
  outfit: "Outfit",
};

const STYLE_WEIGHTS: [string, number][] = [
  ["thin", 100],
  ["hairline", 100],
  ["extralight", 200],
  ["ultralight", 200],
  ["light", 300],
  ["regular", 400],
  ["normal", 400],
  ["medium", 500],
  ["semibold", 600],
  ["demibold", 600],
  ["bold", 700],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["black", 900],
  ["heavy", 900],
];

export function weightForStyle(styleName: string): number {
  // "Semi Bold" must not hit the "Bold" token: normalise spacing, then take the LONGEST matching
  // token so "semibold"/"extrabold"/"demibold" win over "bold".
  const compact = styleName.toLowerCase().replace(/[\s_-]+/g, "");
  const tokens = [...STYLE_WEIGHTS].sort((a, b) => b[0].length - a[0].length);
  for (const [token, value] of tokens) {
    if (compact.includes(token)) return value;
  }
  return 400;
}

export function isItalicStyle(styleName: string): boolean {
  return /italic|oblique/.test(styleName.toLowerCase());
}

/** Every family/style the subtree's TEXT nodes ask for, in document order, deduplicated. */
export function collectRequiredFonts(root: FigmaNode): RequiredFont[] {
  const seen = new Map<string, RequiredFont>();
  walkNodes(root, (node) => {
    if (node.type !== "TEXT") return;
    for (const run of textRuns(node)) {
      const family = run.style.fontFamily;
      const fontSize = run.style.fontSize;
      if (!family || family === "sans-serif" || (typeof fontSize === "number" && fontSize <= 0))
        continue;
      const style = run.style.fontStyle ?? "Regular";
      const key = `${family}\u0000${style}`;
      if (!seen.has(key)) seen.set(key, { family, style });
    }
  });
  return [...seen.values()];
}

function googleFamily(family: string): string | null {
  return GOOGLE_FONTS[family.toLowerCase()] ?? null;
}

/** The css2 URL for the subset this file can serve from Google Fonts, or null when none. */
export function googleFontsCssHref(fonts: readonly RequiredFont[]): string | null {
  const weightsByFamily = new Map<string, Set<number>>();
  for (const font of fonts) {
    const family = googleFamily(font.family);
    if (!family) continue;
    const weights = weightsByFamily.get(family) ?? new Set<number>();
    weights.add(weightForStyle(font.style));
    weightsByFamily.set(family, weights);
  }
  if (weightsByFamily.size === 0) return null;
  const families = [...weightsByFamily.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([family, weights]) =>
        `family=${family.replace(/ /g, "+")}:wght@${[...weights].sort((a, b) => a - b).join(";")}`,
    )
    .join("&");
  return `https://fonts.googleapis.com/css2?${families}&display=swap`;
}

export interface FontLoadDeps {
  /** Inject a Google Fonts stylesheet and resolve when the browser has it. */
  appendStylesheet: (href: string) => Promise<void>;
  /** Fetch font bytes for one family/style from the daemon (`figma.fonts.get`). */
  loadFontBytes: (family: string, style: string) => Promise<FigmaBytes | null>;
  /** Register one fetched face for canvas use; false when the platform cannot take it. */
  registerFontFace: (font: RequiredFont, bytes: FigmaBytes) => Promise<boolean>;
  /** True when the family/style is already usable (system font or a previously added face). */
  isFontLoaded: (family: string, style: string) => boolean;
  /** Resolve once the browser has finished loading every queued webfont. */
  fontsReady: () => Promise<void>;
}

export interface PrototypeFontGate {
  /** Load the given fonts (Google CSS first, `figma.fonts.get` for the rest); never rejects. */
  load: (fonts: readonly RequiredFont[]) => Promise<void>;
  /** The honest answer for the renderer: only true once a face is actually usable. */
  fontAvailable: (family: string, style: string) => boolean;
}

export function createFontGate(deps: FontLoadDeps): PrototypeFontGate {
  const loaded = new Map<string, boolean>();
  const loading = new Set<string>();

  const loadOne = async (font: RequiredFont): Promise<void> => {
    const key = `${font.family}\u0000${font.style}`;
    if (deps.isFontLoaded(font.family, font.style)) {
      loaded.set(key, true);
      return;
    }
    if (loaded.get(key) === true || loading.has(key)) return;
    loading.add(key);
    try {
      const bytes = await deps.loadFontBytes(font.family, font.style);
      loaded.set(key, bytes ? await deps.registerFontFace(font, bytes) : false);
    } catch {
      loaded.set(key, false);
    } finally {
      loading.delete(key);
    }
  };

  return {
    async load(fonts) {
      if (fonts.length === 0) return;
      const href = googleFontsCssHref(fonts);
      if (href) await deps.appendStylesheet(href).catch(() => undefined);
      // Anything the stylesheet did not deliver (unknown families, offline CSS) comes from the
      // daemon's font bytes; loadOne short-circuits when the family is already usable.
      await Promise.all(fonts.map(loadOne));
      await deps.fontsReady().catch(() => undefined);
    },
    fontAvailable(family, style) {
      return loaded.get(`${family}\u0000${style}`) === true || deps.isFontLoaded(family, style);
    },
  };
}
