import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useSyncExternalStore } from "react";
import { hardwareKeyboardPresence } from "./internal/presence";
export function useHardwareKeyboardPresent(): boolean {
  return useSyncExternalStore(
    hardwareKeyboardPresence.subscribe,
    hardwareKeyboardPresence.getSnapshot,
    () => false,
  );
}

export function keyboardShortcutsAvailable(input: {
  isNative: boolean;
  isCompact: boolean;
  hardwareKeyboardPresent?: boolean;
}): boolean {
  return input.hardwareKeyboardPresent === true || (!input.isNative && !input.isCompact);
}

export function useKeyboardShortcutsAvailable(): boolean {
  const isCompact = useIsCompactFormFactor();
  const hardwareKeyboardPresent = useHardwareKeyboardPresent();
  return keyboardShortcutsAvailable({ isNative, isCompact, hardwareKeyboardPresent });
}
