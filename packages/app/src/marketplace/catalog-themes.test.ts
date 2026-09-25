import { describe, expect, it } from "vitest";
import {
  displayThemeName,
  filterThemeEntries,
  normalizePlugin,
  themeVariants,
  type MarketplacePlugin,
} from "./catalog";

// Shaped like an entry of the public plugin catalog (paseo.cafe/api/plugins).
function themePlugin(overrides: Record<string, unknown>): MarketplacePlugin {
  const plugin = normalizePlugin({
    id: "paseo-tokyo-night-storm-theme",
    name: "paseo-tokyo-night-storm-theme",
    repo: "owner/paseo-themes",
    url: "https://github.com/owner/paseo-themes/tree/main/packages/paseo-tokyo-night-storm-theme",
    categories: ["theme"],
    themes: [],
    ...overrides,
  });
  if (!plugin) throw new Error("fixture did not normalize");
  return plugin;
}

const PALETTE = {
  background: "#24283b",
  foreground: "#c0caf5",
  raised: "#1f2335",
  control: "#292e42",
  border: "#3b4261",
  accent: "#7aa2f7",
  mutedForeground: "#a9b1d6",
  ring: "#545c7e",
};

describe("themeVariants", () => {
  it("reads each published variant with its palette and appearance", () => {
    const plugin = themePlugin({
      themes: [
        { id: "storm", name: "Storm", appearance: "dark", colors: PALETTE },
        {
          id: "day",
          name: "Day",
          appearance: "light",
          colors: { ...PALETTE, background: "#e1e2e7" },
        },
      ],
    });
    const variants = themeVariants(plugin);
    expect(variants.map((variant) => [variant.id, variant.appearance])).toEqual([
      ["storm", "dark"],
      ["day", "light"],
    ]);
    expect(variants[0]?.colors.accent).toBe("#7aa2f7");
  });

  it("skips variants whose palette is incomplete or not hex, and falls back accent to foreground", () => {
    const { accent: _accent, ...withoutAccent } = PALETTE;
    const plugin = themePlugin({
      themes: [
        {
          id: "broken",
          name: "Broken",
          appearance: "dark",
          colors: { ...PALETTE, raised: "blue" },
        },
        { id: "partial", name: "Partial", appearance: "dark", colors: { background: "#000000" } },
        { id: "no-accent", name: "No accent", appearance: "dark", colors: withoutAccent },
      ],
    });
    const variants = themeVariants(plugin);
    expect(variants.map((variant) => variant.id)).toEqual(["no-accent"]);
    expect(variants[0]?.colors.accent).toBe(PALETTE.foreground);
  });
});

describe("displayThemeName", () => {
  it("drops the ecosystem prefix and -theme suffix and title-cases the rest", () => {
    expect(displayThemeName(themePlugin({}))).toBe("Tokyo Night Storm");
    expect(displayThemeName(themePlugin({ name: "gruvbox" }))).toBe("Gruvbox");
    expect(displayThemeName(themePlugin({ name: "catppuccin-theme" }))).toBe("Catppuccin");
  });
});

describe("filterThemeEntries", () => {
  const storm = themePlugin({
    themes: [{ id: "storm", name: "Storm", appearance: "dark", colors: PALETTE }],
  });
  const latte = themePlugin({
    id: "catppuccin-theme",
    name: "catppuccin-theme",
    themes: [{ id: "latte", name: "Catppuccin Latte", appearance: "light", colors: PALETTE }],
  });
  const entries = [storm, latte].map((plugin) => ({ plugin, variants: themeVariants(plugin) }));

  it("filters by appearance", () => {
    expect(filterThemeEntries(entries, "", "dark").map((e) => e.plugin.id)).toEqual([storm.id]);
    expect(filterThemeEntries(entries, "", "light").map((e) => e.plugin.id)).toEqual([latte.id]);
    expect(filterThemeEntries(entries, "", "all")).toHaveLength(2);
  });

  it("matches the display name and variant names, case-insensitively", () => {
    expect(filterThemeEntries(entries, "tokyo", "all").map((e) => e.plugin.id)).toEqual([storm.id]);
    expect(filterThemeEntries(entries, "LATTE", "all").map((e) => e.plugin.id)).toEqual([latte.id]);
  });
});
