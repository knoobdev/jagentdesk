import { StyleSheet } from "react-native-unistyles";
import {
  lightTheme,
  darkTheme,
  darkZincTheme,
  darkMidnightTheme,
  darkClaudeTheme,
  darkGhosttyTheme,
  darkPureBlackTheme,
  gumloopLightTheme,
  gumloopDarkTheme,
} from "./theme";

StyleSheet.configure({
  themes: {
    light: lightTheme,
    dark: darkTheme,
    darkZinc: darkZincTheme,
    darkMidnight: darkMidnightTheme,
    darkClaude: darkClaudeTheme,
    darkGhostty: darkGhosttyTheme,
    darkPureBlack: darkPureBlackTheme,
    gumloopLight: gumloopLightTheme,
    gumloopDark: gumloopDarkTheme,
    // Slots a plugin-contributed theme is written into at run time (see appearance).
    pluginLight: lightTheme,
    pluginDark: darkTheme,
  },
  breakpoints: {
    xs: 0,
    sm: 576,
    md: 600,
    lg: 992,
    xl: 1200,
  },
  settings: {
    adaptiveThemes: true,
  },
});

// Type augmentation for TypeScript
interface AppThemes {
  light: typeof lightTheme;
  dark: typeof darkTheme;
  darkZinc: typeof darkZincTheme;
  darkMidnight: typeof darkMidnightTheme;
  darkClaude: typeof darkClaudeTheme;
  darkGhostty: typeof darkGhosttyTheme;
  darkPureBlack: typeof darkPureBlackTheme;
  gumloopLight: typeof gumloopLightTheme;
  gumloopDark: typeof gumloopDarkTheme;
  pluginLight: typeof lightTheme;
  pluginDark: typeof darkTheme;
}

interface AppBreakpoints {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
}

declare module "react-native-unistyles" {
  export interface UnistylesThemes extends AppThemes {}
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}
