import { describe, expect, it } from "vitest";

import { isFullyInViewport } from "./actionability";

const rect = (top: number, left: number, bottom: number, right: number) => ({
  top,
  left,
  bottom,
  right,
});

describe("isFullyInViewport", () => {
  const viewport = { width: 1280, height: 800 };

  it("reports an element entirely on screen as fully visible", () => {
    expect(isFullyInViewport(rect(40, 20, 80, 220), viewport)).toBe(true);
    expect(isFullyInViewport(rect(0, 0, 800, 1280), viewport)).toBe(true);
  });

  it("reports elements clipped by any viewport edge as needing a scroll", () => {
    expect(isFullyInViewport(rect(-10, 20, 30, 220), viewport)).toBe(false);
    expect(isFullyInViewport(rect(780, 20, 820, 220), viewport)).toBe(false);
    expect(isFullyInViewport(rect(40, -5, 80, 220), viewport)).toBe(false);
    expect(isFullyInViewport(rect(40, 1260, 80, 1400), viewport)).toBe(false);
  });
});
