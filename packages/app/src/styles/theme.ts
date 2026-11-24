import { isWeb } from "@/constants/platform";
import { Platform, type ViewStyle } from "react-native";
import { darkHighlightColors, lightHighlightColors } from "@jagentdesk/highlight";

export const baseColors = {
  // Base colors
  white: "#ffffff",
  black: "#000000",

  // Zinc scale (primary gray palette)
  zinc: {
    50: "#fafafa",
    100: "#f4f4f5",
    200: "#e4e4e7",
    300: "#d4d4d8",
    400: "#a1a1aa",
    500: "#71717a",
    600: "#52525b",
    700: "#3f3f46",
    800: "#27272a",
    850: "#1a1a1d",
    900: "#18181b",
    950: "#121214",
  },

  // Gray scale
  gray: {
    50: "#f9fafb",
    100: "#f3f4f6",
    200: "#e5e7eb",
    300: "#d1d5db",
    400: "#9ca3af",
    500: "#6b7280",
    600: "#4b5563",
    700: "#374151",
    800: "#1f2937",
    900: "#111827",
  },

  // Slate scale
  slate: {
    200: "#e2e8f0",
  },

  // Blue scale
  blue: {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
    800: "#1e40af",
    900: "#1e3a8a",
    950: "#172554",
  },

  // Green scale
  green: {
    100: "#dcfce7",
    200: "#bbf7d0",
    400: "#4ade80",
    500: "#22c55e",
    600: "#16a34a",
    800: "#166534",
    900: "#14532d",
  },

  // Red scale
  red: {
    100: "#fee2e2",
    200: "#fecaca",
    300: "#fca5a5",
    500: "#ef4444",
    600: "#dc2626",
    800: "#991b1b",
    900: "#7f1d1d",
  },

  // Teal scale
  teal: {
    200: "#99f6e4",
  },

  // Amber scale
  amber: {
    500: "#f59e0b",
    700: "#b45309",
  },

  // Yellow scale
  yellow: {
    400: "#fbbf24",
  },

  // Purple scale
  purple: {
    500: "#a855f7",
    600: "#9333ea",
  },

  // Orange scale
  orange: {
    500: "#f97316",
    600: "#ea580c",
  },
} as const;

export type ThemeName =
  | "light"
  | "dark"
  | "zinc"
  | "midnight"
  | "claude"
  | "ghostty"
  | "pureBlack"
  | "gumloop"
  | "gumloopDark";

// Diff colors — light uses muted tones, dark uses the brighter palette values.
//
// Two tiers, because the +/- serves two jobs. In the diff view the color *is* the signal and
// has to survive being scanned line by line, so it stays saturated. In a row's metadata the
// counts are a footnote next to a title and a subtitle; at full saturation they read as the
// loudest thing in the row. The Stat tier keeps the hue but drops the chroma to roughly the
// weight of foregroundMuted, so it sits with the subtitle instead of shouting over it.
const lightDiffColors = {
  diffAddition: "#15803d", // green-700 — readable on white without screaming
  diffDeletion: "#b91c1c", // red-700
  diffStatAddition: "#32794a", // softened green-700
  diffStatDeletion: "#a43c39", // softened red-700
};

const darkDiffColors = {
  diffAddition: "#4ade80", // green-400
  diffDeletion: "#ef4444", // red-500
  diffStatAddition: "#61bf82",
  diffStatDeletion: "#d36461",
};

// Status colors — semantic signals for success/danger/warning/merged. Used by
// check statuses, PR states, and review decisions. Kept a step darker than the
// raw palette so they read as signals, not neon.
const lightStatusColors = {
  statusSuccess: "#15803d", // green-700
  statusDanger: "#b91c1c", // red-700
  statusWarning: "#d97706", // amber-600
  statusMerged: "#7c3aed", // purple-600
};

const darkStatusColors = {
  statusSuccess: "#16a34a", // green-600
  statusDanger: "#dc2626", // red-600
  statusWarning: "#f59e0b", // amber-500
  statusMerged: "#9333ea", // purple-600
};

// Semantic color tokens - Layer-based system
const lightSemanticColors = {
  interactionHighlight: "rgba(0, 0, 0, 0.06)",
  selectedRow: "#e4e4e7",
  surfaceSidebarSelected: "#e4e4e7",
  accentPink: "#FF4EA6",
  switchOn: "#20744A",
  statusSuccessBackground: "#dcfce7",
  statusDangerBackground: "#fee2e2",
  statusWarningBackground: "#fef3c7",
  // Surfaces (layers) - shifted one step lighter
  surface0: "#ffffff", // App background
  surface1: "#fafafa", // Subtle hover (was zinc-100, now zinc-50)
  surface2: "#f4f4f5", // Elevated: badges, inputs, sheets (was zinc-200, now zinc-100)
  surface3: "#e4e4e7", // Highest elevation (was zinc-300, now zinc-200)
  surface4: "#d4d4d8", // Extra emphasis (was zinc-400, now zinc-300)
  surfaceDiffEmpty: "#f6f6f6", // Empty side of split diff rows, between surface1 and surface2 and biased toward surface2
  surfaceSidebar: "#f4f4f5", // Sidebar background (darker than main)
  surfaceSidebarHover: "#e9e9ec", // Sidebar hover (darker in light mode)
  surfaceWorkspace: "#ffffff", // Workspace main background

  // Text
  foreground: "#1a1a1e",
  foregroundMuted: "#71717a",
  foregroundExtraMuted: "#a1a1aa",

  // Controls
  scrollbarHandle: "#3f3f46", // zinc-700

  // Borders - shifted one step lighter
  border: "#e4e4e7", // (was zinc-200, now zinc-200 - keep for contrast)
  borderAccent: "#ececf1", // Softer accent border for low-emphasis outlines

  // Brand
  accent: "#20744A",
  accentBright: "#239956",
  accentForeground: "#ffffff",

  // Semantic
  destructive: "#b04138", // dark warm red on white — calm but unambiguously red
  destructiveForeground: "#ffffff",
  success: "#20744A",
  successForeground: "#ffffff",

  // Legacy aliases (for gradual migration)
  background: "#ffffff",
  popover: "#ffffff",
  popoverForeground: "#1a1a1e",
  primary: "#18181b",
  primaryForeground: "#fafafa",
  secondary: "#f4f4f5",
  secondaryForeground: "#1a1a1e",
  muted: "#f4f4f5",
  mutedForeground: "#71717a",
  accentBorder: "#ececf1",
  input: "#f4f4f5",
  ring: "#18181b",

  ...lightDiffColors,
  ...lightStatusColors,

  terminal: {
    background: "#ffffff",
    foreground: "#1a1a1e",
    cursor: "#1a1a1e",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(0, 0, 0, 0.15)",
    selectionForeground: "#1a1a1e",

    black: "#1a1a1e",
    red: "#dc2626",
    green: "#16a34a",
    yellow: "#ca8a04",
    blue: "#2563eb",
    magenta: "#9333ea",
    cyan: "#0891b2",
    white: "#ffffff",

    brightBlack: "#3f3f46",
    brightRed: "#ef4444",
    brightGreen: "#22c55e",
    brightYellow: "#f59e0b",
    brightBlue: "#3b82f6",
    brightMagenta: "#a855f7",
    brightCyan: "#06b6d4",
    brightWhite: "#fafafa",
  },
} as const;

// ---------------------------------------------------------------------------
// Dark theme variant builder
// ---------------------------------------------------------------------------

export interface DarkThemeConfig {
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceDiffEmpty: string;
  surfaceSidebar: string;
  /** Defaults to surface2. */
  surfaceSidebarHover?: string;
  /** Defaults to near-white (#fafafa). */
  foreground?: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  /** Defaults to foregroundExtraMuted. */
  scrollbarHandle?: string;
  /** Focus ring; defaults to zinc-300. */
  ring?: string;
  border: string;
  borderAccent: string;
  accent: string;
  accentBright: string;
  accentForeground?: string;
  destructive: string;
  terminalBlack: string;
  terminalBrightBlack: string;
}

const darkTerminalAnsi = {
  red: "#e07070",
  green: "#5dba80",
  yellow: "#d4a44a",
  blue: "#6a9de0",
  magenta: "#b07ad0",
  cyan: "#4aabb8",
  white: "#d4d4d8",
  brightRed: "#e89090",
  brightGreen: "#7ecf9a",
  brightYellow: "#e0be6e",
  brightBlue: "#8ab4e8",
  brightMagenta: "#c49ae0",
  brightCyan: "#6ec2cc",
  brightWhite: "#f0f0f2",
} as const;

export function buildDarkSemanticColors(tint: DarkThemeConfig) {
  const foreground = tint.foreground ?? "#fafafa";
  return {
    surface0: tint.surface0,
    surface1: tint.surface1,
    surface2: tint.surface2,
    surface3: tint.surface3,
    surface4: tint.surface4,
    surfaceDiffEmpty: tint.surfaceDiffEmpty,
    surfaceSidebar: tint.surfaceSidebar,
    surfaceSidebarHover: tint.surfaceSidebarHover ?? tint.surface2,
    surfaceWorkspace: tint.surface1,
    interactionHighlight: "rgba(255, 255, 255, 0.08)",
    selectedRow: tint.surface3,
    surfaceSidebarSelected: tint.surface3,
    accentPink: "#FF4EA6",
    switchOn: tint.accent,
    statusSuccessBackground: "#1E3A2A",
    statusDangerBackground: "#3D1F21",
    statusWarningBackground: "#3A2F17",

    foreground,
    foregroundMuted: tint.foregroundMuted,
    foregroundExtraMuted: tint.foregroundExtraMuted,

    scrollbarHandle: tint.scrollbarHandle ?? tint.foregroundExtraMuted,

    border: tint.border,
    borderAccent: tint.borderAccent,

    accent: tint.accent,
    accentBright: tint.accentBright,
    accentForeground: tint.accentForeground ?? "#ffffff",

    destructive: tint.destructive,
    destructiveForeground: "#ffffff",
    success: tint.accent,
    successForeground: "#ffffff",

    // Legacy aliases (for gradual migration)
    background: tint.surface0,
    popover: tint.surface2,
    popoverForeground: foreground,
    primary: foreground,
    primaryForeground: tint.surface0,
    secondary: tint.surface2,
    secondaryForeground: foreground,
    muted: tint.surface2,
    mutedForeground: tint.foregroundMuted,
    accentBorder: tint.borderAccent,
    input: tint.surface2,
    ring: tint.ring ?? "#d4d4d8",

    ...darkDiffColors,
    ...darkStatusColors,

    terminal: {
      background: tint.surface0,
      foreground,
      cursor: foreground,
      cursorAccent: tint.surface0,
      selectionBackground: "rgba(255, 255, 255, 0.2)",
      selectionForeground: foreground,
      black: tint.terminalBlack,
      ...darkTerminalAnsi,
      brightBlack: tint.terminalBrightBlack,
    },
  };
}

// ---------------------------------------------------------------------------
// Dark tint definitions
// ---------------------------------------------------------------------------

// JAgentDesk — subtle teal-green tint (default)
const jagentdeskDarkColors = buildDarkSemanticColors({
  surface0: "#181B1A",
  surface1: "#1E2120",
  surface2: "#272A29",
  surface3: "#434645",
  surface4: "#595B5B",
  surfaceDiffEmpty: "#252827",
  surfaceSidebar: "#141716",
  surfaceSidebarHover: "#1c1f1e",
  foregroundMuted: "#A1A5A4",
  foregroundExtraMuted: "#717574",
  scrollbarHandle: "#717574",
  border: "#252B2A",
  borderAccent: "#2F3534",
  accent: "#20744A",
  accentBright: "#7ccba0",
  destructive: "#c64f43", // warm red, hue ~7 — reads as red (not pink) against the green tint
  terminalBlack: "#141716",
  terminalBrightBlack: "#434645",
});

// Zinc — neutral gray, no tint
const zincDarkColors = buildDarkSemanticColors({
  surface0: "#18181b",
  surface1: "#1f1f22",
  surface2: "#27272a",
  surface3: "#3f3f46",
  surface4: "#52525b",
  surfaceDiffEmpty: "#242427",
  surfaceSidebar: "#131316",
  surfaceSidebarHover: "#1b1b1e",
  foregroundMuted: "#a1a1aa",
  foregroundExtraMuted: "#71717a",
  scrollbarHandle: "#71717a",
  border: "#27272a",
  borderAccent: "#303036",
  accent: "#e4e4e7",
  accentBright: "#fafafa",
  accentForeground: "#18181b", // monochrome zinc accent is near-white — needs dark text
  destructive: "#c44a4a", // neutral red, hue 0 — clearly red without screaming
  terminalBlack: "#131316",
  terminalBrightBlack: "#3f3f46",
});

// Midnight — subtle blue tint
const midnightDarkColors = buildDarkSemanticColors({
  surface0: "#161820",
  surface1: "#1c1e27",
  surface2: "#252731",
  surface3: "#3c3e4c",
  surface4: "#535564",
  surfaceDiffEmpty: "#222430",
  surfaceSidebar: "#121420",
  surfaceSidebarHover: "#1a1c28",
  foregroundMuted: "#9a9db0",
  foregroundExtraMuted: "#6b6e82",
  scrollbarHandle: "#6b6e82",
  border: "#242636",
  borderAccent: "#2e3040",
  accent: "#3b6fcf",
  accentBright: "#7eaaeb",
  destructive: "#c44a52", // red with a hint of cool lean against the blue tint
  terminalBlack: "#121420",
  terminalBrightBlack: "#3c3e4c",
});

// Claude — warm neutral with subtle orange undertone
const claudeDarkColors = buildDarkSemanticColors({
  surface0: "#1f1f1e",
  surface1: "#262523",
  surface2: "#2f2d2b",
  surface3: "#4a4745",
  surface4: "#605d5b",
  surfaceDiffEmpty: "#2a2826",
  surfaceSidebar: "#1a1918",
  surfaceSidebarHover: "#222120",
  foregroundMuted: "#ada9a5",
  foregroundExtraMuted: "#78746f",
  scrollbarHandle: "#78746f",
  border: "#2c2a27",
  borderAccent: "#36332f",
  accent: "#d97757",
  accentBright: "#e89a7f",
  destructive: "#cf513e", // warm orange-red, hue ~10 — sits with the Claude orange accent
  terminalBlack: "#1a1918",
  terminalBrightBlack: "#4a4745",
});

// Ghostty — blue-tinted dark based on Ghostty default background
const ghosttyDarkColors = buildDarkSemanticColors({
  surface0: "#282c34",
  surface1: "#2f333d",
  surface2: "#383c48",
  surface3: "#4a4f5e",
  surface4: "#5b6175",
  surfaceDiffEmpty: "#323643",
  surfaceSidebar: "#21252d",
  surfaceSidebarHover: "#292d36",
  foregroundMuted: "#c8ccd8",
  foregroundExtraMuted: "#a0a4b2",
  scrollbarHandle: "#a0a4b2",
  border: "#353a47",
  borderAccent: "#3f4454",
  accent: "#89b4fa",
  accentBright: "#b4d0fc",
  destructive: "#c44a55", // red with slight cool lean against the slate-blue surfaces
  terminalBlack: "#21252d",
  terminalBrightBlack: "#4a4f5e",
});

// Pure black — true-black surfaces for OLED displays
const pureBlackDarkColors = buildDarkSemanticColors({
  surface0: "#000000",
  surface1: "#0a0a0a",
  surface2: "#111111",
  surface3: "#202020",
  surface4: "#2d2d2d",
  surfaceDiffEmpty: "#0c0c0c",
  surfaceSidebar: "#000000",
  surfaceSidebarHover: "#0d0d0d",
  foregroundMuted: "#a1a1aa",
  foregroundExtraMuted: "#71717a",
  scrollbarHandle: "#71717a",
  border: "#1c1c1c",
  borderAccent: "#242424",
  accent: "#20744A",
  accentBright: "#7ccba0",
  destructive: "#c44a4a",
  terminalBlack: "#595959",
  terminalBrightBlack: "#8a8a8a",
});

export const SPACING = {
  0: 0,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
  32: 128,
} as const;

export const FONT_SIZE = {
  xs: 12,
  code: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 22,
  "3xl": 26,
  "4xl": 34,
} as const;

export const LINE_HEIGHT = {
  diff: 22,
} as const;

export const ICON_SIZE = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
} as const;

export const FONT_WEIGHT = {
  normal: "normal" as const,
  medium: "500" as const,
  semibold: "600" as const,
  bold: "bold" as const,
} as const;

export const BORDER_RADIUS = {
  none: 0,
  sm: 2,
  base: 4,
  md: 6,
  lg: 8,
  xl: 12,
  "2xl": 16,
  full: 9999,
} as const;

export const BORDER_WIDTH = {
  0: 0,
  1: 1,
  2: 2,
} as const;

export const OPACITY = {
  0: 0,
  50: 0.5,
  100: 1,
} as const;

// Platform default font stacks — copied verbatim from constants/theme.ts `Fonts`
// (sans -> ui, mono -> mono). These seed the dynamic `fontFamily` theme token and
// are the fallback an empty user-supplied family resolves to at apply time.
export const DEFAULT_UI_FONT_STACK: string = Platform.select({
  ios: "system-ui",
  default: "normal",
  web: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
});

export const DEFAULT_MONO_FONT_STACK: string = Platform.select({
  ios: "ui-monospace",
  default: "monospace",
  web: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
});

// Chat and markdown content column; the appearance updater patches the user's width in.
export const DEFAULT_CONTENT_MAX_WIDTH = 820;

// On web Unistyles puts string tokens in CSS variables, so mounted content
// receives width changes without regenerating its classes. The px string is
// emitted as CSS by Unistyles. Native always receives a number or percentage.
export function themeContentMaxWidth(
  width: number | undefined,
): NonNullable<ViewStyle["maxWidth"]> {
  return isWeb && width !== undefined
    ? (`${width}px` as NonNullable<ViewStyle["maxWidth"]>)
    : (width ?? "100%");
}

// `fontSize`, `fontFamily`, `lineHeight`, and `contentMaxWidth` are deliberately widened to plain
// `number`/`string` (not narrowed by `as const`) so the appearance updater can patch
// them at runtime via `UnistylesRuntime.updateTheme`. The remaining tokens keep their
// literal types.
interface CommonTheme {
  spacing: typeof SPACING;
  fontSize: Record<keyof typeof FONT_SIZE, number>;
  fontFamily: { ui: string; mono: string };
  lineHeight: Record<keyof typeof LINE_HEIGHT, number>;
  contentMaxWidth: ReturnType<typeof themeContentMaxWidth>;
  iconSize: typeof ICON_SIZE;
  fontWeight: typeof FONT_WEIGHT;
  borderRadius: typeof BORDER_RADIUS;
  borderWidth: typeof BORDER_WIDTH;
  opacity: typeof OPACITY;
}

const commonTheme: CommonTheme = {
  spacing: SPACING,
  fontSize: FONT_SIZE,
  fontFamily: { ui: DEFAULT_UI_FONT_STACK, mono: DEFAULT_MONO_FONT_STACK },
  lineHeight: LINE_HEIGHT,
  contentMaxWidth: themeContentMaxWidth(DEFAULT_CONTENT_MAX_WIDTH),
  iconSize: ICON_SIZE,
  fontWeight: FONT_WEIGHT,
  borderRadius: BORDER_RADIUS,
  borderWidth: BORDER_WIDTH,
  opacity: OPACITY,
};

/** Semantic chrome shared by controls; the selected built-in theme owns shell structure. */
export interface ShellChrome {
  kind: "classic" | "gumloop";
  /** Window background behind the top bar, rail and panel. */
  canvas: string;
  topBar: string;
  /** Rail fill, top to bottom. One stop paints a solid rail. */
  railGradient: readonly string[];
  railForeground: string;
  railForegroundMuted: string;
  railActiveBackground: string;
  railActiveForeground: string;
  panelBorder: string;
  /** Sidebar "+ New" button, which is violet in light and ink-on-light in dark. */
  createBackground: string;
  createForeground: string;
  searchBackground: string;
  searchBorder: string;
  searchForeground: string;
  selectedRow: string;
  /** Composer border gradient, bottom-left to top-right. */
  composerGradient: readonly string[];
  /** Send button gradient, left to right. */
  sendGradient: readonly string[];
  /** Soft wash at the top-right of an empty agent screen. */
  heroGlow: string;
  /** Phone bottom tab bar (Gumloop iOS). */
  tabBar: string;
  tabBarBorder: string;
  tabIdle: string;
  tabCreateBackground: string;
  tabCreateForeground: string;
  /** Typography and control shape the shared components read directly. */
  titleWeight: "300" | "400" | "500" | "600" | "700";
  titleWeightCompact: "300" | "400" | "500" | "600" | "700";
  buttonTextWeight: "400" | "500" | "600";
  controlRadius: number;
  modalRadius: number;
  searchHeight: number;
  searchRadius: number;
  tableRowHeight: number;
  switchWidth: number;
  switchHeight: number;
  switchThumbSize: number;
  outlineBackground: string;
  outlineBorder: string;
  /** Settings/list page canvas behind white cards. */
  pageCanvas: string;
  cardBackground: string;
  cardBorder: string;
  cardRadius: number;
  sectionTitleColor: string;
  /** Selected filter chip (Gumloop iOS "Unread": lavender fill, violet text). */
  chipActiveBackground: string;
  chipActiveForeground: string;
  sectionTitleWeight: "400" | "500" | "600";
  rowTitleWeight: "400" | "500" | "600";
}

interface ClassicChromeSource {
  selectedRow: string;
  borderAccent: string;
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  border: string;
  foreground: string;
  foregroundMuted: string;
  accent: string;
  accentForeground: string;
}

/**
 * Shell tokens for a theme without its own shell. Every theme carries the full set because Unistyles
 * on web compiles styles once against CSS variables, so a style reads `theme.chrome.topBar`
 * directly instead of branching on the theme. The classic shell never renders these.
 */
function classicChrome(c: ClassicChromeSource): ShellChrome {
  return {
    kind: "classic",
    canvas: c.surface0,
    topBar: c.surface0,
    railGradient: [c.surface1],
    railForeground: c.foreground,
    railForegroundMuted: c.foregroundMuted,
    railActiveBackground: c.surface3,
    railActiveForeground: c.foreground,
    panelBorder: c.border,
    createBackground: c.accent,
    createForeground: c.accentForeground,
    searchBackground: c.surface1,
    searchBorder: c.border,
    searchForeground: c.foregroundMuted,
    selectedRow: c.selectedRow,
    composerGradient: [c.border, c.border],
    sendGradient: [c.accent, c.accent],
    heroGlow: c.surface1,
    tabBar: c.surface0,
    tabBarBorder: c.border,
    tabIdle: c.foregroundMuted,
    tabCreateBackground: c.accent,
    tabCreateForeground: c.accentForeground,
    titleWeight: "300",
    titleWeightCompact: "400",
    buttonTextWeight: "400",
    controlRadius: BORDER_RADIUS.lg,
    modalRadius: 12,
    searchHeight: 34,
    searchRadius: BORDER_RADIUS.md,
    tableRowHeight: 44,
    switchWidth: 34,
    switchHeight: 20,
    switchThumbSize: 16,
    outlineBackground: "transparent",
    outlineBorder: c.borderAccent,
    pageCanvas: c.surface0,
    cardBackground: c.surface1,
    cardBorder: c.border,
    cardRadius: BORDER_RADIUS.lg,
    sectionTitleColor: c.foregroundMuted,
    chipActiveBackground: c.surface3,
    chipActiveForeground: c.foreground,
    sectionTitleWeight: "400",
    rowTitleWeight: "400",
  };
}

const darkShadow = {
  sm: {
    shadowColor: "rgba(0, 0, 0, 0.25)",
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  md: {
    shadowColor: "rgba(0, 0, 0, 0.20)",
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 8,
  },
  lg: {
    shadowColor: "rgba(0, 0, 0, 0.40)",
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24,
    elevation: 8,
  },
} as const;

export function buildDarkTheme(
  semanticColors: Widen<ReturnType<typeof buildDarkSemanticColors>>,
  chrome: ShellChrome = classicChrome(semanticColors),
) {
  return {
    colorScheme: "dark" as const,
    chrome,
    colors: {
      ...semanticColors,
      palette: baseColors,
      syntax: darkHighlightColors,
    },
    shadow: darkShadow,
    ...commonTheme,
  } as const;
}

export const darkTheme = buildDarkTheme(jagentdeskDarkColors);
export const darkZincTheme = buildDarkTheme(zincDarkColors);
export const darkMidnightTheme = buildDarkTheme(midnightDarkColors);
export const darkClaudeTheme = buildDarkTheme(claudeDarkColors);
export const darkGhosttyTheme = buildDarkTheme(ghosttyDarkColors);
export const darkPureBlackTheme = buildDarkTheme(pureBlackDarkColors);

// Literal hex types from the `as const` palette, widened so a builder can return any color.
type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends object
      ? { [K in keyof T]: Widen<T[K]> }
      : T;
type LightSemanticColors = Widen<typeof lightSemanticColors>;

/** A light palette: every token defaults to the built-in light theme, the tint overrides. */
export interface LightThemeConfig {
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  surfaceDiffEmpty: string;
  surfaceSidebar: string;
  foreground: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  border: string;
  borderAccent: string;
  accent: string;
  accentBright: string;
  accentForeground?: string;
  primary?: string;
  primaryForeground?: string;
  destructive: string;
  terminalBlack: string;
  terminalBrightBlack: string;
  ring?: string;
}

export function buildLightSemanticColors(tint: LightThemeConfig): LightSemanticColors {
  return {
    ...lightSemanticColors,
    surface0: tint.surface0,
    surface1: tint.surface1,
    surface2: tint.surface2,
    surface3: tint.surface3,
    surface4: tint.surface4,
    surfaceDiffEmpty: tint.surfaceDiffEmpty,
    surfaceSidebar: tint.surfaceSidebar,
    surfaceSidebarHover: tint.surface1,
    surfaceWorkspace: tint.surface0,
    foreground: tint.foreground,
    foregroundMuted: tint.foregroundMuted,
    foregroundExtraMuted: tint.foregroundExtraMuted,
    border: tint.border,
    borderAccent: tint.borderAccent,
    accent: tint.accent,
    accentBright: tint.accentBright,
    accentForeground: tint.accentForeground ?? tint.surface0,
    destructive: tint.destructive,
    destructiveForeground: tint.surface0,
    background: tint.surface0,
    popover: tint.surface0,
    popoverForeground: tint.foreground,
    primary: tint.primary ?? tint.foreground,
    primaryForeground: tint.primaryForeground ?? tint.surface0,
    secondary: tint.surface2,
    secondaryForeground: tint.foreground,
    muted: tint.surface2,
    mutedForeground: tint.foregroundMuted,
    accentBorder: tint.borderAccent,
    input: tint.surface2,
    ring: tint.ring ?? lightSemanticColors.ring,
    terminal: {
      ...lightSemanticColors.terminal,
      background: tint.surface0,
      foreground: tint.foreground,
      cursor: tint.foreground,
      cursorAccent: tint.surface0,
      selectionForeground: tint.foreground,
      black: tint.terminalBlack,
      brightBlack: tint.terminalBrightBlack,
    },
  };
}

const lightShadow = {
  sm: {
    shadowColor: "rgba(0, 0, 0, 0.02)",
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  md: {
    shadowColor: "rgba(0, 0, 0, 0.04)",
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 16,
    elevation: 4,
  },
  lg: {
    shadowColor: "rgba(0, 0, 0, 0.08)",
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 24,
    elevation: 8,
  },
} as const;

export function buildLightTheme(
  semanticColors: LightSemanticColors,
  chrome: ShellChrome = classicChrome(semanticColors),
) {
  return {
    colorScheme: "light" as const,
    chrome,
    colors: {
      ...semanticColors,
      palette: baseColors,
      syntax: lightHighlightColors,
    },
    shadow: lightShadow,
    ...commonTheme,
  } as const;
}

export const lightTheme = buildLightTheme(lightSemanticColors);

// Gumloop values are pinned to spec 38, including the constructed syntax and ANSI palettes.
export const gumloopLightSyntax = {
  keyword: "#C2185B",
  type: "#C2185B",
  tag: "#C2185B",
  comment: "#767676",
  meta: "#767676",
  string: "#0A7F3F",
  regexp: "#0A7F3F",
  link: "#0A7F3F",
  number: "#0068B8",
  literal: "#0068B8",
  escape: "#0068B8",
  function: "#0068B8",
  definition: "#0068B8",
  class: "#A3336F",
  attribute: "#9A4B00",
  property: "#0068B8",
  operator: "#0068B8",
  heading: "#0068B8",
  variable: "#000000",
  punctuation: "#4A4A4A",
};
const gumloopLightColors = {
  ...lightSemanticColors,
  surface0: "#FCFCFC",
  surface1: "#FFFFFF",
  surface2: "#F4F5F7",
  surface3: "#EDEDED",
  surface4: "#E4E4E4",
  surfaceDiffEmpty: "#F4F5F7",
  surfaceSidebar: "#FAFAFA",
  surfaceSidebarHover: "#F5F5F5",
  surfaceWorkspace: "#FCFCFC",
  foreground: "#000000",
  foregroundMuted: "#757575",
  foregroundExtraMuted: "#A3A3A3",
  scrollbarHandle: "#A3A3A3",
  border: "#E9E9E9",
  borderAccent: "#E9E9E9",
  accent: "#019EFF",
  accentBright: "#019EFF",
  accentForeground: "#FFFFFF",
  destructive: "#BD0E13",
  destructiveForeground: "#FFFFFF",
  success: "#0A7F3F",
  successForeground: "#FFFFFF",
  background: "#FCFCFC",
  popover: "#FFFFFF",
  popoverForeground: "#000000",
  primary: "#1D1D1D",
  primaryForeground: "#FFFFFF",
  secondary: "#F4F5F7",
  secondaryForeground: "#000000",
  muted: "#F4F5F7",
  mutedForeground: "#757575",
  accentBorder: "#E9E9E9",
  input: "#FFFFFF",
  ring: "#019EFF",
  interactionHighlight: "#F5F5F5",
  selectedRow: "#F0F0F0",
  surfaceSidebarSelected: "#F0F0F0",
  accentPink: "#FF4EA6",
  switchOn: "#0091FF",
  statusSuccess: "#0A7F3F",
  statusSuccessBackground: "#E7FCED",
  statusDanger: "#BD0E13",
  statusDangerBackground: "#FFEFF0",
  statusWarning: "#8F5300",
  statusWarningBackground: "#FFF4E0",
  statusMerged: "#C2185B",
  diffAddition: "#E7FCED",
  diffDeletion: "#FFEFF0",
  diffStatAddition: "#0A7F3F",
  diffStatDeletion: "#BD0E13",
  terminal: {
    background: "#FFFFFF",
    foreground: "#1D1D1D",
    cursor: "#FF4EA6",
    cursorAccent: "#FFFFFF",
    selectionBackground: "rgba(1, 158, 255, 0.22)",
    selectionForeground: "#1D1D1D",
    black: "#1D1D1D",
    red: "#BD0E13",
    green: "#0A7F3F",
    yellow: "#8F5300",
    blue: "#0068B8",
    magenta: "#C2185B",
    cyan: "#00737C",
    white: "#757575",
    brightBlack: "#5C5C5C",
    brightRed: "#E5484D",
    brightGreen: "#1A9455",
    brightYellow: "#B36A00",
    brightBlue: "#019EFF",
    brightMagenta: "#FF4EA6",
    brightCyan: "#009AA6",
    brightWhite: "#A3A3A3",
  },
};
export const gumloopDarkSyntax = {
  keyword: "#FF6FB5",
  type: "#FF6FB5",
  tag: "#FF6FB5",
  comment: "#8C8C8C",
  meta: "#8C8C8C",
  string: "#5BD98A",
  regexp: "#5BD98A",
  link: "#5BD98A",
  number: "#4DB8FF",
  literal: "#4DB8FF",
  escape: "#4DB8FF",
  function: "#4DB8FF",
  definition: "#4DB8FF",
  class: "#FF9ACB",
  attribute: "#FFB86B",
  property: "#7DCBFF",
  operator: "#7DCBFF",
  heading: "#7DCBFF",
  variable: "#F5F5F5",
  punctuation: "#C8C8C8",
};
const gumloopDarkColors = {
  ...jagentdeskDarkColors,
  surface0: "#1F1F1F",
  surface1: "#262626",
  surface2: "#2E2E2E",
  surface3: "#363636",
  surface4: "#3F3F3F",
  surfaceDiffEmpty: "#2E2E2E",
  surfaceSidebar: "#171717",
  surfaceSidebarHover: "#262626",
  surfaceWorkspace: "#1F1F1F",
  foreground: "#F5F5F5",
  foregroundMuted: "#98999D",
  foregroundExtraMuted: "#6B6B6F",
  scrollbarHandle: "#6B6B6F",
  border: "#2E2E2E",
  borderAccent: "#2E2E2E",
  accent: "#019EFF",
  accentBright: "#019EFF",
  accentForeground: "#FFFFFF",
  destructive: "#FF6369",
  destructiveForeground: "#FFFFFF",
  success: "#5BD98A",
  successForeground: "#FFFFFF",
  background: "#1F1F1F",
  popover: "#262626",
  popoverForeground: "#F5F5F5",
  primary: "#F5F5F5",
  primaryForeground: "#171717",
  secondary: "#2E2E2E",
  secondaryForeground: "#F5F5F5",
  muted: "#2E2E2E",
  mutedForeground: "#98999D",
  accentBorder: "#2E2E2E",
  input: "#262626",
  ring: "#019EFF",
  interactionHighlight: "#262626",
  selectedRow: "#2E2E2E",
  surfaceSidebarSelected: "#2E2E2E",
  accentPink: "#FF4EA6",
  switchOn: "#0091FF",
  statusSuccess: "#5BD98A",
  statusSuccessBackground: "#1E3A2A",
  statusDanger: "#FF6369",
  statusDangerBackground: "#3D1F21",
  statusWarning: "#F2C14E",
  statusWarningBackground: "#3A2F17",
  statusMerged: "#FF6FB5",
  diffAddition: "rgba(91, 217, 138, 0.14)",
  diffDeletion: "rgba(255, 99, 105, 0.14)",
  diffStatAddition: "#5BD98A",
  diffStatDeletion: "#FF6369",
  terminal: {
    background: "#1F1F1F",
    foreground: "#F5F5F5",
    cursor: "#FF4EA6",
    cursorAccent: "#1F1F1F",
    selectionBackground: "rgba(77, 184, 255, 0.30)",
    selectionForeground: "#F5F5F5",
    black: "#2E2E2E",
    red: "#FF6369",
    green: "#5BD98A",
    yellow: "#F2C14E",
    blue: "#4DB8FF",
    magenta: "#FF6FB5",
    cyan: "#4FD1D9",
    white: "#D4D4D4",
    brightBlack: "#757575",
    brightRed: "#FF8A8F",
    brightGreen: "#86E7A9",
    brightYellow: "#F7D47E",
    brightBlue: "#7DCBFF",
    brightMagenta: "#FF9ACB",
    brightCyan: "#7FE0E6",
    brightWhite: "#FFFFFF",
  },
};

function gumloopChrome(c: typeof gumloopLightColors, dark: boolean): ShellChrome {
  return {
    ...classicChrome(c),
    kind: "gumloop",
    canvas: c.surface0,
    panelBorder: c.border,
    createBackground: c.primary,
    createForeground: c.primaryForeground,
    searchBackground: c.surface1,
    selectedRow: c.selectedRow,
    composerGradient: dark
      ? ["rgba(247, 178, 122, 0.6)", "rgba(244, 166, 207, 0.6)", "rgba(159, 212, 247, 0.6)"]
      : ["#F7B27A", "#F4A6CF", "#9FD4F7"],
    sendGradient: [c.primary, c.primary],
    titleWeight: "600",
    titleWeightCompact: "600",
    buttonTextWeight: "500",
    controlRadius: 10,
    modalRadius: 16,
    searchHeight: 46,
    searchRadius: 10,
    tableRowHeight: 72,
    switchWidth: 44,
    switchHeight: 24,
    switchThumbSize: 20,
    outlineBackground: c.surface1,
    outlineBorder: c.border,
    pageCanvas: c.surface0,
    cardBackground: c.surface1,
    cardBorder: c.border,
    cardRadius: 14,
    sectionTitleColor: c.foregroundMuted,
    chipActiveBackground: c.surface1,
    chipActiveForeground: c.foreground,
    sectionTitleWeight: "500",
    rowTitleWeight: "500",
  };
}
export const GUMLOOP_LIGHT_CHROME = gumloopChrome(gumloopLightColors, false);
export const GUMLOOP_DARK_CHROME = gumloopChrome(gumloopDarkColors, true);

function gumloopShadow(alpha: number) {
  return {
    sm: {
      shadowColor: `rgba(0, 0, 0, ${0.06 * alpha})`,
      shadowOffset: { width: 0, height: 1 },
      shadowRadius: 2,
      elevation: 2,
    },
    md: {
      shadowColor: `rgba(0, 0, 0, ${0.08 * alpha})`,
      shadowOffset: { width: 0, height: 4 },
      shadowRadius: 12,
      elevation: 4,
    },
    lg: {
      shadowColor: `rgba(0, 0, 0, ${0.12 * alpha})`,
      shadowOffset: { width: 0, height: 12 },
      shadowRadius: 32,
      elevation: 8,
    },
  };
}
export const gumloopLightTheme = {
  ...buildLightTheme(gumloopLightColors, GUMLOOP_LIGHT_CHROME),
  colors: { ...gumloopLightColors, palette: baseColors, syntax: gumloopLightSyntax },
  shadow: gumloopShadow(1),
};
export const gumloopDarkTheme = {
  ...buildDarkTheme(gumloopDarkColors, GUMLOOP_DARK_CHROME),
  colors: { ...gumloopDarkColors, palette: baseColors, syntax: gumloopDarkSyntax },
  shadow: gumloopShadow(2),
};

// Keep compatibility with existing code
export const theme = darkTheme;

// Export a union type that works for both themes
export type Theme =
  | typeof darkTheme
  | typeof lightTheme
  | typeof gumloopLightTheme
  | typeof gumloopDarkTheme;

type UnistylesThemeKey =
  | "light"
  | "dark"
  | "darkZinc"
  | "darkMidnight"
  | "darkClaude"
  | "darkGhostty"
  | "darkPureBlack"
  | "gumloopLight"
  | "gumloopDark";

export const THEME_TO_UNISTYLES: Record<ThemeName, UnistylesThemeKey> = {
  light: "light",
  dark: "dark",
  zinc: "darkZinc",
  midnight: "darkMidnight",
  claude: "darkClaude",
  ghostty: "darkGhostty",
  pureBlack: "darkPureBlack",
  // Gumloop is a light product; its dark half is its own, opt-in theme.
  gumloop: "gumloopLight",
  gumloopDark: "gumloopDark",
};

/** Themes with a light and a dark half that switch with the system appearance. */
export const SCHEME_FOLLOWING_THEMES: Partial<
  Record<ThemeName, { light: UnistylesThemeKey; dark: UnistylesThemeKey }>
> = {};

/** The theme a fresh install starts with. Every other theme stays selectable. */
export const DEFAULT_THEME: ThemeName = "gumloop";

/**
 * A theme contributed by a plugin is applied into one of these two slots (by its
 * colorScheme) at run time; the preference value marks that one is selected.
 */
export const PLUGIN_THEME_PREFERENCE = "plugin";
export const PLUGIN_THEME_NAMES = {
  light: "pluginLight",
  dark: "pluginDark",
} as const;

export const THEME_SWATCHES: Record<ThemeName, string> = {
  light: "#ffffff",
  dark: "#2D8B62",
  zinc: "#808080",
  midnight: "#4A6BA8",
  claude: "#D97757",
  ghostty: "#8caaee",
  pureBlack: "#000000",
  gumloop: "#1D1D1D",
  gumloopDark: "#171717",
};
