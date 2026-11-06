// The one mapping from a Figma text style name ("Semi Bold", "Bold Italic", …) to a CSS font
// descriptor. Shared pure helpers for the renderer's text drawing and the player's font loading:
// neither side may keep its own token list, or the font the player loads and the font the
// renderer asks the canvas for drift apart.

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
