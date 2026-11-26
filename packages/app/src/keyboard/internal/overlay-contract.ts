import type { RefObject } from "react";
import type { KeyboardInputEvent } from "./overlays";
export interface OverlayRegistration {
  active: boolean;
  layer: number;
  keys: readonly string[];
  onKeyDown(event: KeyboardInputEvent): boolean;
  /**
   * Where focus goes when the overlay closes: an element, or any handle with `focus()`. Defaults
   * to whatever had focus when the overlay opened.
   */
  restoreFocusRef?: RefObject<unknown>;
  manageFocus?: boolean;
}
