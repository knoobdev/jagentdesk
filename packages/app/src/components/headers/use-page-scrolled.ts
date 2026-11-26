import type { RefObject } from "react";
import type { View } from "react-native";

/**
 * Native has no document to listen on; pages that need the divider there pass `scrolled` to
 * `PageHeader` from their own scroll handler. See the web file for the shared behaviour.
 */
export function usePageScrolled(_headerRef: RefObject<View | null>, _enabled: boolean): boolean {
  return false;
}
