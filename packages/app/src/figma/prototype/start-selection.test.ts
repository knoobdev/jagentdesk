import { describe, expect, it } from "vitest";
import { pickStartPosition } from "./start-selection";
import { flow, frameSummary, outline, page } from "./test-support/frames";

describe("pickStartPosition", () => {
  it("auto-selects the first flow when flows exist", () => {
    const start = pickStartPosition(
      [flow("2:1", "Onboarding"), flow("3:1", "Checkout")],
      outline([page({ id: "p1", name: "Page 1", frames: [frameSummary("1:1", "Home")] })]),
    );
    expect(start).toEqual({ frameId: "2:1", note: null });
  });

  it("falls back to the first top-level frame and says so when the file has no flows", () => {
    const start = pickStartPosition(
      [],
      outline([
        page({ id: "p1", name: "Page 1" }),
        page({
          id: "p2",
          name: "Screens",
          frames: [frameSummary("9:1", "Home"), frameSummary("9:2", "Detail")],
        }),
      ]),
    );
    expect(start).not.toBeNull();
    expect(start?.frameId).toBe("9:1");
    expect(start?.note).toContain("No flow start points");
    expect(start?.note).toContain("Home");
  });

  it("returns null when the file has neither flows nor frames", () => {
    expect(pickStartPosition([], outline([page({ id: "p1", name: "Page 1" })]))).toBeNull();
  });
});
