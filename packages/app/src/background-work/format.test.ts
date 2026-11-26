import { describe, expect, it } from "vitest";
import { formatBackgroundElapsed } from "./format";

describe("formatBackgroundElapsed", () => {
  it("keeps the sidebar line to one or two units", () => {
    expect(formatBackgroundElapsed(-5)).toBe("0s");
    expect(formatBackgroundElapsed(45_400)).toBe("45s");
    expect(formatBackgroundElapsed(125_000)).toBe("2m");
    expect(formatBackgroundElapsed(3_600_000)).toBe("1h");
    expect(formatBackgroundElapsed(3_900_000)).toBe("1h 5m");
  });
});
