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
});
