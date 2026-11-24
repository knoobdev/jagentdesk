import { useEffect } from "react";
import { isWeb } from "@/constants/platform";
import { usePanelStore } from "@/stores/panel-store";

export function useGumloopSidebarShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!isWeb || !enabled) return;
    function toggle(event: KeyboardEvent) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.code !== "Backslash" ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      usePanelStore.getState().toggleDesktopAgentList();
    }
    window.addEventListener("keydown", toggle, true);
    return () => window.removeEventListener("keydown", toggle, true);
  }, [enabled]);
}
