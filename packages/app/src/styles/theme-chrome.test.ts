import { describe, expect, it } from "vitest";
import {
  CLICKUP_DARK_CHROME,
  CLICKUP_LIGHT_CHROME,
  clickupDarkTheme,
  clickupLightTheme,
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
  clickupLight: clickupLightTheme,
  clickupDark: clickupDarkTheme,
};

const TOKEN_KEYS = Object.keys(CLICKUP_LIGHT_CHROME).filter(
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

  it("only the ClickUp theme brings the ClickUp shell", () => {
    expect(clickupLightTheme.chrome.kind).toBe("clickup");
    expect(clickupDarkTheme.chrome.kind).toBe("clickup");
    for (const theme of [lightTheme, darkTheme, darkZincTheme, darkPureBlackTheme]) {
      expect(theme.chrome.kind).toBe("classic");
    }
  });

  it("uses the measured ClickUp shell values", () => {
    expect(CLICKUP_LIGHT_CHROME.railGradient).toEqual(["#5741d2", "#4332a2", "#2e2371"]);
    expect(CLICKUP_LIGHT_CHROME.createBackground).toBe("#6149e7");
    expect(CLICKUP_DARK_CHROME.railGradient).toEqual(["#191919"]);
    expect(CLICKUP_DARK_CHROME.createBackground).toBe("#ededed");
    expect(CLICKUP_LIGHT_CHROME.sendGradient).toEqual(["#912eff", "#ec02f7"]);
  });
});
