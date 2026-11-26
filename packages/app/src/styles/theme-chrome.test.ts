import { describe, expect, it } from "vitest";
import {
  GUMLOOP_DARK_CHROME,
  GUMLOOP_LIGHT_CHROME,
  gumloopDarkTheme,
  gumloopLightTheme,
  darkClaudeTheme,
  darkGhosttyTheme,
  darkMidnightTheme,
  darkPureBlackTheme,
  darkTheme,
  darkZincTheme,
  lightTheme,
  type ShellChrome,
} from "./theme";

const themes = {
  light: lightTheme,
  dark: darkTheme,
  zinc: darkZincTheme,
  midnight: darkMidnightTheme,
  claude: darkClaudeTheme,
  ghostty: darkGhosttyTheme,
  pureBlack: darkPureBlackTheme,
  gumloopLight: gumloopLightTheme,
  gumloopDark: gumloopDarkTheme,
};

const TOKEN_KEYS = Object.keys(GUMLOOP_LIGHT_CHROME).filter(
  (key) => key !== "kind",
) as (keyof ShellChrome)[];
const COLOR = /^(#|rgba?\(|transparent$)/;

describe("theme shell chrome", () => {
  // Unistyles on web compiles styles once against CSS variables, so shell styles read
  // `theme.chrome.<token>` directly. A theme missing a token would leave its variable empty.
  it.each(Object.entries(themes))("%s carries every shell token", (_name, theme) => {
    for (const key of TOKEN_KEYS) {
      const value: unknown = theme.chrome[key];
      if (Array.isArray(value)) {
        expect(value.length, key).toBeGreaterThan(0);
        for (const stop of value) expect(stop, key).toMatch(COLOR);
      } else if (typeof value === "number") {
        expect(value, key).toBeGreaterThanOrEqual(0);
      } else if (key.includes("Weight")) {
        expect(value, key).toMatch(/^[1-9]00$/);
      } else {
        expect(value, key).toMatch(COLOR);
      }
    }
  });

  it("only the Gumloop theme brings the Gumloop shell", () => {
    expect(gumloopLightTheme.chrome.kind).toBe("gumloop");
    expect(gumloopDarkTheme.chrome.kind).toBe("gumloop");
    for (const theme of [lightTheme, darkTheme, darkZincTheme, darkPureBlackTheme]) {
      expect(theme.chrome.kind).toBe("classic");
    }
  });

  it("uses Gumloop's primary action and horizontal composer border", () => {
    expect(GUMLOOP_LIGHT_CHROME.createBackground).toBe("#1D1D1D");
    expect(GUMLOOP_DARK_CHROME.createBackground).toBe("#F5F5F5");
    expect(GUMLOOP_LIGHT_CHROME.composerGradient).toEqual(["#F7B27A", "#F4A6CF", "#9FD4F7"]);
    expect(GUMLOOP_LIGHT_CHROME.controlRadius).toBe(10);
    expect(GUMLOOP_LIGHT_CHROME.cardRadius).toBe(14);
  });

  // Spec 38 §4.6 "Menu" (A38.4k): Gumloop menus read at 14 px on 32 px rows with 12/600 group
  // titles; classic themes keep their menu sizes.
  it("gives Gumloop menus 14 px labels, 32 px rows and 12/600 group titles", () => {
    for (const chrome of [GUMLOOP_LIGHT_CHROME, GUMLOOP_DARK_CHROME]) {
      expect(chrome.menuItemFontSize).toBe(14);
      expect(chrome.menuItemHeight).toBe(32);
      expect(chrome.contextMenuItemHeight).toBe(32);
      expect(chrome.menuGroupTitleSize).toBe(12);
      expect(chrome.menuGroupTitleWeight).toBe("600");
    }
    for (const theme of [lightTheme, darkTheme, darkZincTheme, darkPureBlackTheme]) {
      expect(theme.chrome.menuItemFontSize).toBe(16);
      expect(theme.chrome.menuItemHeight).toBe(28);
      expect(theme.chrome.contextMenuItemHeight).toBe(36);
      expect(theme.chrome.contextMenuItemPaddingVertical).toBe(8);
      expect(theme.chrome.menuGroupTitleSize).toBe(14);
      expect(theme.chrome.menuGroupTitleWeight).toBe("400");
    }
  });
});
