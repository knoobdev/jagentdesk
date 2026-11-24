import { usesDesktopBindings } from "@/keyboard";

import { useMemo } from "react";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { resolveShortcutKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { getShortcutOs } from "@/utils/shortcut-platform";

export function useShortcutKeys(actionId: string): ShortcutKey[][] | null {
  const { overrides } = useKeyboardShortcutOverrides();
  const isMac = getShortcutOs() === "mac";

  return useMemo(() => {
    return resolveShortcutKeysForAction(actionId, overrides, {
      isMac,
      usesDesktopBindings,
    });
  }, [actionId, overrides, isMac]);
}
