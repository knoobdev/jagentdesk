import type { AppSettings } from "@/hooks/use-settings";
import type { PluginThemeOption } from "@/plugins/themes";
import {
  DEFAULT_THEME,
  PLUGIN_THEME_NAMES,
  PLUGIN_THEME_PREFERENCE,
  SCHEME_FOLLOWING_THEMES,
  THEME_TO_UNISTYLES,
  type Theme,
} from "@/styles/theme";

type UnistylesKey = (typeof THEME_TO_UNISTYLES)[keyof typeof THEME_TO_UNISTYLES];

export type ThemeTarget =
  /** Unistyles' own light/dark switching ("System"). */
  | { kind: "adaptive" }
  | { kind: "static"; key: UnistylesKey }
  /** A plugin theme, written into the slot for its color scheme before it is selected. */
  | {
      kind: "plugin";
      key: (typeof PLUGIN_THEME_NAMES)[keyof typeof PLUGIN_THEME_NAMES];
      theme: Theme;
    };

/**
 * Which Unistyles theme the app shows for a preference. Scheme-following themes (ClickUp) pick
 * their light or dark half from the system appearance; a plugin theme whose plugin is gone falls
 * back to the default theme instead of leaving the app on a stale slot.
 */
export function resolveThemeTarget(input: {
  preference: AppSettings["theme"];
  pluginThemeId: string | null;
  pluginOptions: readonly PluginThemeOption[];
  systemScheme: "light" | "dark" | null | undefined;
}): ThemeTarget {
  let preference = input.preference;
  if (preference === PLUGIN_THEME_PREFERENCE) {
    const option = input.pluginOptions.find((candidate) => candidate.id === input.pluginThemeId);
    if (option) {
      return {
        kind: "plugin",
        key: PLUGIN_THEME_NAMES[option.theme.colorScheme],
        theme: option.theme,
      };
    }
    preference = DEFAULT_THEME;
  }
  if (preference === "auto") return { kind: "adaptive" };
  const pair = SCHEME_FOLLOWING_THEMES[preference];
  if (pair) return { kind: "static", key: input.systemScheme === "light" ? pair.light : pair.dark };
  return { kind: "static", key: THEME_TO_UNISTYLES[preference] };
}
