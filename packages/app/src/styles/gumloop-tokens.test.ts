import { describe, expect, it } from "vitest";
import {
  gumloopLightTheme,
  gumloopDarkTheme,
  lightTheme,
  darkTheme,
  DEFAULT_THEME,
  THEME_TO_UNISTYLES,
} from "./theme";

const surfaces = {
  surface0: ["#FCFCFC", "#1F1F1F"],
  surface1: ["#FFFFFF", "#262626"],
  surface2: ["#F4F5F7", "#2E2E2E"],
  surface3: ["#EDEDED", "#363636"],
  surface4: ["#E4E4E4", "#3F3F3F"],
  surfaceSidebar: ["#FAFAFA", "#171717"],
  selectedRow: ["#F0F0F0", "#2E2E2E"],
  surfaceSidebarHover: ["#F5F5F5", "#262626"],
  foreground: ["#000000", "#F5F5F5"],
  foregroundMuted: ["#757575", "#98999D"],
  foregroundExtraMuted: ["#A3A3A3", "#6B6B6F"],
  border: ["#E9E9E9", "#2E2E2E"],
  primary: ["#1D1D1D", "#F5F5F5"],
  primaryForeground: ["#FFFFFF", "#171717"],
  accent: ["#019EFF", "#019EFF"],
  accentPink: ["#FF4EA6", "#FF4EA6"],
  switchOn: ["#0091FF", "#0091FF"],
  statusSuccess: ["#0A7F3F", "#5BD98A"],
  statusSuccessBackground: ["#E7FCED", "#1E3A2A"],
  statusDanger: ["#BD0E13", "#FF6369"],
  statusDangerBackground: ["#FFEFF0", "#3D1F21"],
  statusWarning: ["#8F5300", "#F2C14E"],
  statusWarningBackground: ["#FFF4E0", "#3A2F17"],
  statusMerged: ["#C2185B", "#FF6FB5"],
  diffAddition: ["#E7FCED", "rgba(91, 217, 138, 0.14)"],
  diffDeletion: ["#FFEFF0", "rgba(255, 99, 105, 0.14)"],
  diffStatAddition: ["#0A7F3F", "#5BD98A"],
  diffStatDeletion: ["#BD0E13", "#FF6369"],
} as const;
const syntax = {
  keyword: ["#C2185B", "#FF6FB5"],
  type: ["#C2185B", "#FF6FB5"],
  tag: ["#C2185B", "#FF6FB5"],
  comment: ["#767676", "#8C8C8C"],
  meta: ["#767676", "#8C8C8C"],
  string: ["#0A7F3F", "#5BD98A"],
  regexp: ["#0A7F3F", "#5BD98A"],
  link: ["#0A7F3F", "#5BD98A"],
  number: ["#0068B8", "#4DB8FF"],
  literal: ["#0068B8", "#4DB8FF"],
  escape: ["#0068B8", "#4DB8FF"],
  function: ["#0068B8", "#4DB8FF"],
  definition: ["#0068B8", "#4DB8FF"],
  class: ["#A3336F", "#FF9ACB"],
  attribute: ["#9A4B00", "#FFB86B"],
  property: ["#0068B8", "#7DCBFF"],
  operator: ["#0068B8", "#7DCBFF"],
  heading: ["#0068B8", "#7DCBFF"],
  variable: ["#000000", "#F5F5F5"],
  punctuation: ["#4A4A4A", "#C8C8C8"],
} as const;
const terminal = {
  background: ["#FFFFFF", "#1F1F1F"],
  foreground: ["#1D1D1D", "#F5F5F5"],
  cursor: ["#FF4EA6", "#FF4EA6"],
  cursorAccent: ["#FFFFFF", "#1F1F1F"],
  selectionBackground: ["rgba(1, 158, 255, 0.22)", "rgba(77, 184, 255, 0.30)"],
  selectionForeground: ["#1D1D1D", "#F5F5F5"],
  black: ["#1D1D1D", "#2E2E2E"],
  brightBlack: ["#5C5C5C", "#757575"],
  red: ["#BD0E13", "#FF6369"],
  brightRed: ["#E5484D", "#FF8A8F"],
  green: ["#0A7F3F", "#5BD98A"],
  brightGreen: ["#1A9455", "#86E7A9"],
  yellow: ["#8F5300", "#F2C14E"],
  brightYellow: ["#B36A00", "#F7D47E"],
  blue: ["#0068B8", "#4DB8FF"],
  brightBlue: ["#019EFF", "#7DCBFF"],
  magenta: ["#C2185B", "#FF6FB5"],
  brightMagenta: ["#FF4EA6", "#FF9ACB"],
  cyan: ["#00737C", "#4FD1D9"],
  brightCyan: ["#009AA6", "#7FE0E6"],
  white: ["#757575", "#D4D4D4"],
  brightWhite: ["#A3A3A3", "#FFFFFF"],
} as const;

describe("Gumloop spec 38 §2 / §3", () => {
  it.each([gumloopLightTheme, gumloopDarkTheme])(
    "pins every semantic, syntax and terminal token",
    (theme) => {
      const index = theme.colorScheme === "light" ? 0 : 1;
      for (const [key, pair] of Object.entries(surfaces))
        expect(Reflect.get(theme.colors, key), key).toBe(pair[index]);
      for (const [key, pair] of Object.entries(syntax))
        expect(Reflect.get(theme.colors.syntax, key), key).toBe(pair[index]);
      for (const [key, pair] of Object.entries(terminal))
        expect(Reflect.get(theme.colors.terminal, key), key).toBe(pair[index]);
      for (const key of ["background", "surfaceWorkspace"])
        expect(Reflect.get(theme.colors, key)).toBe(theme.colors.surface0);
      expect(theme.colors.popover).toBe(theme.colors.surface1);
      expect(theme.chrome.panelBorder).toBe(theme.colors.border);
      expect(theme.colors.input).toBe(theme.colors.surface1);
      expect(theme.colors.secondary).toBe(theme.colors.surface2);
      expect(theme.colors.muted).toBe(theme.colors.surface2);
      expect(theme.colors.ring).toBe("#019EFF");
      expect(theme.colors.borderAccent).toBe(surfaces.border[index]);
      const alpha = index === 0 ? 1 : 2;
      for (const [key, opacity, offset, radius, elevation] of [
        ["sm", 0.06, 1, 2, 2],
        ["md", 0.08, 4, 12, 4],
        ["lg", 0.12, 12, 32, 8],
      ] as const) {
        expect(theme.shadow[key]).toEqual({
          shadowColor: `rgba(0, 0, 0, ${opacity * alpha})`,
          shadowOffset: { width: 0, height: offset },
          shadowRadius: radius,
          elevation,
        });
      }
    },
  );
  it("defaults to Gumloop, removes ClickUp choices, and retains fonts and the Paseo shell", () => {
    expect(DEFAULT_THEME).toBe("gumloop");
    expect(Object.keys(THEME_TO_UNISTYLES)).not.toContain("clickup");
    expect(Object.keys(THEME_TO_UNISTYLES)).not.toContain("clickupDark");
    expect(gumloopLightTheme.fontFamily).toEqual(lightTheme.fontFamily);
    expect(gumloopDarkTheme.fontFamily).toEqual(darkTheme.fontFamily);
    expect(darkTheme.chrome.kind).toBe("classic");
  });
});
