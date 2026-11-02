import type { SshTerminalAppearance } from "@jagentdesk/protocol/ssh/snippets-schemas";
import {
  clickupDarkTheme,
  clickupLightTheme,
  darkClaudeTheme,
  darkGhosttyTheme,
  darkMidnightTheme,
  darkPureBlackTheme,
  darkTheme,
  darkZincTheme,
  lightTheme,
  type Theme,
  type ThemeName,
} from "@/styles/theme";

// Per-server/per-group terminal theme and font size (spec 25.2 `theme?`, `fontSize?`;
// 25.4). A theme is one of the app themes; its terminal palette colours the SSH tab.

export type TerminalPalette = Theme["colors"]["terminal"];

const THEMES: Record<ThemeName, Theme> = {
  light: lightTheme,
  dark: darkTheme,
  zinc: darkZincTheme,
  midnight: darkMidnightTheme,
  claude: darkClaudeTheme,
  ghostty: darkGhosttyTheme,
  pureBlack: darkPureBlackTheme,
  clickup: clickupLightTheme,
  clickupDark: clickupDarkTheme,
};

export const TERMINAL_THEME_NAMES: readonly ThemeName[] = [
  "light",
  "dark",
  "zinc",
  "midnight",
  "claude",
  "ghostty",
  "pureBlack",
  "clickup",
  "clickupDark",
];

export function isTerminalThemeName(value: string): value is ThemeName {
  return value in THEMES;
}

export function terminalPaletteFor(theme: ThemeName): TerminalPalette {
  return THEMES[theme].colors.terminal;
}

export interface AppearanceServer extends SshTerminalAppearance {
  groupId?: string;
}

export interface AppearanceGroup extends SshTerminalAppearance {
  id: string;
  parentId?: string;
}

export interface ResolvedTerminalAppearance {
  /** null → the tab follows the app theme. */
  theme: ThemeName | null;
  /** null → the tab uses the app's terminal font size. */
  fontSize: number | null;
  /** Where each value came from, for "inherited from <group>" hints. */
  themeSource: AppearanceSource;
  fontSizeSource: AppearanceSource;
}

export type AppearanceSource =
  | { kind: "server" }
  | { kind: "group"; groupId: string }
  | { kind: "default" };

interface AppearanceChainEntry {
  source: AppearanceSource;
  appearance: SshTerminalAppearance;
}

/**
 * Nearest value wins: the server, then each parent group up to the root (spec 25.2
 * group inheritance). An unknown theme name (e.g. from a newer app) is skipped.
 */
export function resolveTerminalAppearance(
  server: AppearanceServer,
  groups: readonly AppearanceGroup[],
): ResolvedTerminalAppearance {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const chain: AppearanceChainEntry[] = [{ source: { kind: "server" }, appearance: server }];
  const seen = new Set<string>();
  let groupId = server.groupId;
  while (groupId && !seen.has(groupId)) {
    seen.add(groupId);
    const group = byId.get(groupId);
    if (!group) break;
    chain.push({ source: { kind: "group", groupId: group.id }, appearance: group });
    groupId = group.parentId;
  }
  const themeEntry = chain.find(
    (entry) => entry.appearance.theme !== undefined && isTerminalThemeName(entry.appearance.theme),
  );
  const fontEntry = chain.find((entry) => entry.appearance.fontSize !== undefined);
  const theme = themeEntry?.appearance.theme;
  return {
    theme: theme !== undefined && isTerminalThemeName(theme) ? theme : null,
    fontSize: fontEntry?.appearance.fontSize ?? null,
    themeSource: themeEntry?.source ?? { kind: "default" },
    fontSizeSource: fontEntry?.source ?? { kind: "default" },
  };
}

export interface TerminalAppearanceOverride {
  palette: TerminalPalette | null;
  fontSize: number | null;
}

/** What an SSH tab renders with (TerminalPane `appearance`): null fields follow the app. */
export function terminalAppearanceOverride(
  server: AppearanceServer,
  groups: readonly AppearanceGroup[],
): TerminalAppearanceOverride {
  const resolved = resolveTerminalAppearance(server, groups);
  return {
    palette: resolved.theme === null ? null : terminalPaletteFor(resolved.theme),
    fontSize: resolved.fontSize,
  };
}
