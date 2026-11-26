import { usePathname } from "expo-router";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings } from "@/hooks/use-settings";
import { gumloopListStyles } from "./list-styles";

/** True while a Gumloop theme (light, or its opt-in dark half) is selected: its shell replaces the classic one. */
export function useIsGumloopTheme(): boolean {
  const { settings } = useAppSettings();
  return settings.theme === "gumloop" || settings.theme === "gumloopDark";
}

/**
 * Whether the desktop window renders the single Gumloop sidebar. Phones keep
 * their own layout; screens without app chrome (onboarding) stay bare, settings get the shell.
 */
export function useGumloopDesktopShell(chromeEnabled: boolean): boolean {
  const isGumloop = useIsGumloopTheme();
  const isCompact = useIsCompactFormFactor();
  const pathname = usePathname();
  if (!isGumloop || isCompact) return false;
  return chromeEnabled || pathname.startsWith("/settings");
}

/**
 * The page body's side gutter: the shared 32 px Gumloop page gutter, full width, in the desktop
 * shell (spec 38 §4.1, A38.4i); `null` elsewhere, so classic themes and phones keep their own.
 * Put it after the body's own padding in a style array.
 */
export function useGumloopPageGutterStyle() {
  return useGumloopDesktopShell(true) ? gumloopListStyles.pageContent : null;
}
