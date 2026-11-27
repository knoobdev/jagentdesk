import { describe, expect, test } from "vitest";
import {
  COMMAND_COLLAPSED_HEIGHT,
  COMMAND_LINE_HEIGHT,
  commandLineCount,
  nextCommandOverflow,
} from "./command-collapse";

const lines = (count: number) => count * COMMAND_LINE_HEIGHT;

/** The rule the fence used before: collapse when the measured text is taller than the box. */
function previousRule(_previous: boolean, height: number): boolean {
  return height > COMMAND_COLLAPSED_HEIGHT + 1;
}

/**
 * Lays the fence out `passes` times the way iOS does and records whether it was collapsed after
 * each pass. On iOS the text inside the clipped box is measured no taller than the box.
 * `measure` says which height the fence decides from: the shown text (the old wiring) or the
 * hidden copy beside it, which the clip never reaches.
 */
function layOut(input: {
  fullHeight: number;
  measure: "shown" | "hidden";
  passes: number;
  decide?: (previous: boolean, height: number) => boolean;
}): boolean[] {
  const decide = input.decide ?? nextCommandOverflow;
  let overflows = false;
  const history: boolean[] = [];
  for (let pass = 0; pass < input.passes; pass += 1) {
    const shownHeight = overflows
      ? Math.min(input.fullHeight, COMMAND_COLLAPSED_HEIGHT)
      : input.fullHeight;
    const measured = input.measure === "shown" ? shownHeight : input.fullHeight;
    overflows = decide(overflows, measured);
    history.push(overflows);
  }
  return history;
}

describe("the command fence's Show more", () => {
  test("the old rule on the shown text under the clip flips on every layout (the jump)", () => {
    expect(
      layOut({ fullHeight: lines(12), measure: "shown", passes: 6, decide: previousRule }),
    ).toEqual([true, false, true, false, true, false]);
  });

  test("measuring the hidden full copy settles on the first layout and stays", () => {
    expect(layOut({ fullHeight: lines(12), measure: "hidden", passes: 6 })).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test("stays settled even if a clipped measurement reaches it", () => {
    expect(layOut({ fullHeight: lines(12), measure: "shown", passes: 6 })).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  test("a command of six lines or fewer never collapses", () => {
    expect(layOut({ fullHeight: lines(6), measure: "hidden", passes: 3 })).toEqual([
      false,
      false,
      false,
    ]);
    expect(nextCommandOverflow(false, lines(1))).toBe(false);
  });

  test("counts whole lines, so a sub-pixel height is not an extra line", () => {
    expect(commandLineCount(lines(6) + 0.4)).toBe(6);
    expect(nextCommandOverflow(false, lines(6) + 0.4)).toBe(false);
    expect(nextCommandOverflow(false, lines(7) - 0.4)).toBe(true);
  });

  test("holds through a width that moves the command between six and seven lines", () => {
    // Expanded, a scroll bar narrows the fence to seven lines; collapsed, it widens back to six.
    let overflows = nextCommandOverflow(false, lines(7));
    expect(overflows).toBe(true);
    for (const height of [lines(6), lines(7), lines(6), lines(7)]) {
      overflows = nextCommandOverflow(overflows, height);
      expect(overflows).toBe(true);
    }
    // Only a command clearly shorter than the box lets it go.
    expect(nextCommandOverflow(true, lines(5))).toBe(false);
  });

  test("keeps the last answer until the copy is laid out", () => {
    expect(nextCommandOverflow(true, 0)).toBe(true);
    expect(nextCommandOverflow(false, 0)).toBe(false);
    expect(nextCommandOverflow(false, Number.NaN)).toBe(false);
  });
});
