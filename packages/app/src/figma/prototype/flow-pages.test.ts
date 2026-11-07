import { describe, expect, it } from "vitest";
import { outline, page } from "./test-support/frames";
import {
  firstReadPageId,
  flowsForListing,
  mergeSeenFlows,
  outlineIsPaged,
  seenFlowsForIdentity,
} from "./flow-pages";

// Pure rules of the ADR-0043 flow-page selector (no JSDOM, no mocks — docs/testing.md).

const legacyOutline = () =>
  outline([
    page({ id: "p1", name: "Light", flowStartingPoints: [{ nodeId: "1:1", name: "Onboarding" }] }),
    page({ id: "p2", name: "Dark", flowStartingPoints: [{ nodeId: "2:1", name: "Dark flow" }] }),
  ]);

const pagedOutline = () =>
  outline([
    page({ id: "p1", name: "Light", flowStartingPoints: [{ nodeId: "1:1", name: "Onboarding" }] }),
    page({ id: "p2", name: "Dark", childrenLoaded: false }),
  ]);

// What the on-demand read of the Dark page returns: one fully-read page at the pinned version.
const darkPageOutline = () =>
  outline([
    page({ id: "p2", name: "Dark", flowStartingPoints: [{ nodeId: "2:1", name: "Dark flow" }] }),
  ]);

describe("flowsForListing", () => {
  it("legacy fully-read outlines keep the aggregate flow list across ALL pages", () => {
    expect(flowsForListing(legacyOutline(), false, null, undefined)).toEqual([
      { nodeId: "1:1", name: "Onboarding", pageId: "p1" },
      { nodeId: "2:1", name: "Dark flow", pageId: "p2" },
    ]);
  });

  it("paged hosts list ONE page's flows: the read page from the outline", () => {
    expect(flowsForListing(pagedOutline(), true, "p1", undefined)).toEqual([
      { nodeId: "1:1", name: "Onboarding", pageId: "p1" },
    ]);
  });

  it("paged hosts list the on-demand snapshot's flows for an unread browsed page", () => {
    expect(flowsForListing(pagedOutline(), true, "p2", darkPageOutline())).toEqual([
      { nodeId: "2:1", name: "Dark flow", pageId: "p2" },
    ]);
  });

  it("a paged page that is not read yet lists NO flows — never the whole file", () => {
    expect(flowsForListing(pagedOutline(), true, "p2", undefined)).toEqual([]);
    expect(flowsForListing(pagedOutline(), true, null, darkPageOutline())).toEqual([]);
  });
});

describe("seen flow labels", () => {
  const onboarding = { nodeId: "1:1", name: "Onboarding", pageId: "p1" };
  const darkFlow = { nodeId: "2:1", name: "Dark flow", pageId: "p2" };

  it("merges listed flows so a played flow keeps its name across page browses", () => {
    expect(mergeSeenFlows([onboarding], [darkFlow])).toEqual([onboarding, darkFlow]);
    // Re-listing the same flow does not duplicate it.
    expect(mergeSeenFlows([onboarding, darkFlow], [darkFlow])).toEqual([onboarding, darkFlow]);
  });

  it("a new snapshot identity starts a fresh lookup — old labels cannot leak into it", () => {
    const stored = { identity: "s1|fk1|v1", flows: [onboarding] };
    expect(seenFlowsForIdentity(stored, "s1|fk1|v2", [darkFlow])).toEqual([darkFlow]);
  });

  it("the same identity keeps accumulating remembered labels", () => {
    const stored = { identity: "s1|fk1|v1", flows: [onboarding] };
    expect(seenFlowsForIdentity(stored, "s1|fk1|v1", [darkFlow])).toEqual([onboarding, darkFlow]);
  });
});

describe("paged detection", () => {
  it("detects paged index outlines and the default read page", () => {
    expect(outlineIsPaged(pagedOutline())).toBe(true);
    expect(outlineIsPaged(legacyOutline())).toBe(false);
    expect(firstReadPageId(pagedOutline())).toBe("p1");
    expect(
      firstReadPageId(outline([page({ id: "p9", name: "Empty", childrenLoaded: false })])),
    ).toBe(null);
  });
});
