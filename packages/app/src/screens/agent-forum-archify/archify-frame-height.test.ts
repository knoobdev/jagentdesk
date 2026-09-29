import { describe, expect, it } from "vitest";
import { fitArchifyFrameHeight } from "./archify-frame-height";

describe("fitArchifyFrameHeight", () => {
  it("uses the cap until the frame reports its content height", () => {
    expect(fitArchifyFrameHeight(null, 600)).toBe(600);
  });

  it("shrinks to the reported content height", () => {
    expect(fitArchifyFrameHeight(452.4, 600)).toBe(452);
  });

  it("never exceeds the cap or drops below the minimum", () => {
    expect(fitArchifyFrameHeight(2400, 600)).toBe(600);
    expect(fitArchifyFrameHeight(40, 600)).toBe(200);
  });

  it("ignores invalid reports", () => {
    expect(fitArchifyFrameHeight(Number.NaN, 600)).toBe(600);
    expect(fitArchifyFrameHeight(0, 600)).toBe(600);
  });
});
