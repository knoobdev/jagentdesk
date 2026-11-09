/**
 * Stick-to-bottom decision logic for the remote job output box (spec 33.9: the box shows the
 * END of the output). Pure on purpose — the scroll wiring lives in the card component.
 */

/** Distance in px from the bottom that still counts as "at the bottom". */
export const OUTPUT_BOTTOM_THRESHOLD_PX = 32;

/**
 * New pinned state after a scroll event: scrolling back near the bottom re-pins the box,
 * scrolling up unpins it so the user's position is kept until they return.
 */
export function nextPinnedState(
  distanceFromBottomPx: number,
  thresholdPx: number = OUTPUT_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottomPx <= thresholdPx;
}

/** What the box should do after new output arrives, given the pinned state. */
export function scrollActionForAppend(pinnedToBottom: boolean): "none" | "toEnd" {
  return pinnedToBottom ? "toEnd" : "none";
}
