/** The command fence collapses past this many lines, behind "Show more" (spec 04 §27c). */
export const COMMAND_COLLAPSED_LINES = 6;
export const COMMAND_LINE_HEIGHT = 17;
/** The clipped fence's height: exactly the collapsed lines. */
export const COMMAND_COLLAPSED_HEIGHT = COMMAND_COLLAPSED_LINES * COMMAND_LINE_HEIGHT;

/** Whole lines in a laid-out command, so a sub-pixel height never reads as an extra line. */
export function commandLineCount(height: number): number {
  return Math.round(height / COMMAND_LINE_HEIGHT);
}

/**
 * Whether the command fence offers "Show more", given the full command's height.
 *
 * The height must come from a copy of the command that nothing clips. Measuring the text the
 * fence shows fed the decision back into itself: on iOS a text inside the clipped box is laid out
 * no taller than the box, so the collapsed command measured as six lines, the fence expanded, the
 * full command measured as more, and the fence collapsed again — the block jumped up and down on
 * its own.
 *
 * Hysteresis covers what is left: a width that changes with the collapse (a scroll bar that
 * appears only when the fence is expanded) can move a command between six and seven lines. Once
 * collapsed it stays collapsible until the command is shorter than the collapsed box, so that
 * boundary can't flip it either. A height of 0 (not laid out yet) keeps the last answer.
 */
export function nextCommandOverflow(previous: boolean, fullHeight: number): boolean {
  if (!(fullHeight > 0)) return previous;
  const lines = commandLineCount(fullHeight);
  return previous ? lines >= COMMAND_COLLAPSED_LINES : lines > COMMAND_COLLAPSED_LINES;
}
