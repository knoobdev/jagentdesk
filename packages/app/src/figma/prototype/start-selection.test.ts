import { describe, expect, it } from "vitest";
import { pickStartPosition, resolveRequestedStart } from "./start-selection";
import { flow, frameSummary, outline, page, summary } from "./test-support/frames";

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

// ADR-0039: a Section must never become a playback screen by itself — resolve inward through
// W5's flattened summaries (parentId/childrenLoaded), or ask the user to pick a frame.
describe("resolveRequestedStart", () => {
  const section = summary({ id: "7:1", name: "Onboarding Flow", type: "SECTION" });
  const childA = summary({ id: "7:2", name: "Welcome", parentId: "7:1" });
  const childB = summary({ id: "7:3", name: "Login", parentId: "7:1" });

  it("plays a requested root frame untouched", () => {
    const out = outline([page({ id: "p1", name: "P", frames: [childA] })]);
    expect(resolveRequestedStart("7:2", out)).toEqual({
      frameId: "7:2",
      needsFrameChoice: false,
      containerName: null,
    });
  });

  it("passes an id absent from the outline through to the caller's choice", () => {
    // A deep element selection: the file screen (W10) is expected to name an ancestor root
    // frame, but until it does the player must still attempt the requested node as-is.
    const out = outline([page({ id: "p1", name: "P", frames: [childA] })]);
    expect(resolveRequestedStart("99:1", out).frameId).toBe("99:1");
    expect(resolveRequestedStart("99:1", out).needsFrameChoice).toBe(false);
  });

  it("prefers the declared flow start point inside a section", () => {
    const out = outline([
      page({
        id: "p1",
        name: "P",
        frames: [section, childA, childB],
        flowStartingPoints: [{ nodeId: "7:3", name: "Login flow" }],
      }),
    ]);
    expect(resolveRequestedStart("7:1", out).frameId).toBe("7:3");
  });

  it("falls back to the first real frame when the section declares no flow start", () => {
    const out = outline([page({ id: "p1", name: "P", frames: [section, childA, childB] })]);
    expect(resolveRequestedStart("7:1", out).frameId).toBe("7:2");
  });

  it("walks a parent chain to find the frame inside a section", () => {
    const mid = summary({ id: "7:10", name: "Group", type: "GROUP", parentId: "7:1" });
    const deep = summary({ id: "7:11", name: "Checkout", parentId: "7:10" });
    const out = outline([page({ id: "p1", name: "P", frames: [section, mid, deep] })]);
    // The GROUP is not playable; its FRAME child is.
    expect(resolveRequestedStart("7:1", out).frameId).toBe("7:11");
  });

  it("asks for a frame when the section holds nothing playable", () => {
    const empty = summary({
      id: "8:1",
      name: "Not Yet Flattened",
      type: "SECTION",
      childrenLoaded: false,
    });
    const out = outline([page({ id: "p1", name: "P", frames: [empty, childA] })]);
    expect(resolveRequestedStart("8:1", out)).toEqual({
      frameId: null,
      needsFrameChoice: true,
      containerName: "Not Yet Flattened",
    });
  });
});
