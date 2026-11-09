import { describe, expect, it } from "vitest";
import {
  OUTPUT_BOTTOM_THRESHOLD_PX,
  nextPinnedState,
  scrollActionForAppend,
} from "./output-scroll";

describe("nextPinnedState", () => {
  it("stays pinned when the view is at or near the bottom", () => {
    expect(nextPinnedState(0)).toBe(true);
    expect(nextPinnedState(10)).toBe(true);
    expect(nextPinnedState(OUTPUT_BOTTOM_THRESHOLD_PX)).toBe(true);
  });

  it("unpins once the user scrolls up past the threshold", () => {
    expect(nextPinnedState(OUTPUT_BOTTOM_THRESHOLD_PX + 1)).toBe(false);
    expect(nextPinnedState(500)).toBe(false);
  });

  it("honours a custom threshold", () => {
    expect(nextPinnedState(40, 50)).toBe(true);
    expect(nextPinnedState(60, 50)).toBe(false);
  });
});

describe("scrollActionForAppend", () => {
  it("jumps to the end when pinned", () => {
    expect(scrollActionForAppend(true)).toBe("toEnd");
  });

  it("keeps the user's position when they scrolled up", () => {
    expect(scrollActionForAppend(false)).toBe("none");
  });
});
