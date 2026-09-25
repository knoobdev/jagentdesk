import { usePathname } from "expo-router";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppSettings } from "@/hooks/use-settings";

/** True while a ClickUp theme (light, or its opt-in dark half) is selected: its shell replaces the classic one. */
export function useIsClickUpTheme(): boolean {
  const { settings } = useAppSettings();
  return settings.theme === "clickup" || settings.theme === "clickupDark";
}

/**
 * Whether the desktop window renders the ClickUp shell (top bar, rail, rounded panel). Phones keep
 * their own layout; screens without app chrome (onboarding) stay bare, settings get the shell.
 */
export function useClickUpDesktopShell(chromeEnabled: boolean): boolean {
  const isClickUp = useIsClickUpTheme();
  const isCompact = useIsCompactFormFactor();
  const pathname = usePathname();
  if (!isClickUp || isCompact) return false;
  return chromeEnabled || pathname.startsWith("/settings");
}
