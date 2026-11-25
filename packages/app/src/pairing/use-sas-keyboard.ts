import { useOverlayRegistration } from "@/keyboard";
import { useOverlayLayer } from "@/lib/overlay-root";

/** A keyboard default action must never approve device trust (spec 05.3.6). */
export function useSasKeyboard(active: boolean) {
  const layer = useOverlayLayer("floating");
  return useOverlayRegistration({
    active,
    layer,
    keys: ["Enter"],
    manageFocus: false,
    onKeyDown: () => true,
  });
}
