import { describe, expect, test } from "vitest";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import {
  isTimelineCatchUpComplete,
  isTimelineResumeSnapshotAuthoritative,
  planTimelineCatchUpAfter,
  planTimelineCatchUpPastApplied,
  planTimelineOlderFetch,
  planTimelinePromptJump,
  planTimelineTailFetch,
} from "./timeline-sync-plan";

describe("timeline sync planning", () => {
  test("agent synchronization checks a bounded tail page", () => {
    const plan = planTimelineTailFetch();

    expect(plan).toEqual({
      direction: "tail",
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
      wholeTurns: true,
    });
  });

  test("older history loads one bounded page before the start cursor", () => {
    const plan = planTimelineOlderFetch({ epoch: "epoch-1", seq: 25 });

    expect(plan).toEqual({
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 25 },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
      wholeTurns: true,
    });
  });

  test("an unloaded prompt jump merges a window with half a page newer than the target", () => {
    expect(planTimelinePromptJump({ epoch: "epoch-1", seq: 42 })).toEqual({
      direction: "before",
      cursor: {
        epoch: "epoch-1",
        seq: 42 + Math.floor(TIMELINE_FETCH_PAGE_SIZE / 2) + 1,
      },
      limit: TIMELINE_FETCH_PAGE_SIZE,
      projection: "projected",
      wholeTurns: true,
      mergeWindow: true,
    });
  });

  test("catch-up finishes when the daemon reports no newer rows", () => {
    expect(isTimelineCatchUpComplete({ direction: "after", hasNewer: false, error: null })).toBe(
      true,
    );
  });

  test("only tail and completed forward pages carry an authoritative resume snapshot", () => {
    expect(
      isTimelineResumeSnapshotAuthoritative({
        direction: "tail",
        hasNewer: false,
        error: null,
      }),
    ).toBe(true);
    expect(
      isTimelineResumeSnapshotAuthoritative({
        direction: "after",
        hasNewer: false,
        error: null,
      }),
    ).toBe(true);
    expect(
      isTimelineResumeSnapshotAuthoritative({
        direction: "before",
        hasNewer: false,
        error: null,
      }),
    ).toBe(false);
  });
});

describe("parked catch-up requests", () => {
  const parked = planTimelineCatchUpAfter({ epoch: "e1", seq: 10 });

  test("start after rows applied while they waited", () => {
    expect(planTimelineCatchUpPastApplied(parked, { epoch: "e1", endSeq: 900 })).toEqual(
      planTimelineCatchUpAfter({ epoch: "e1", seq: 900 }),
    );
  });

  test("keep their cursor when nothing newer was applied or the epoch changed", () => {
    expect(planTimelineCatchUpPastApplied(parked, { epoch: "e1", endSeq: 10 })).toBe(parked);
    expect(planTimelineCatchUpPastApplied(parked, { epoch: "e2", endSeq: 900 })).toBe(parked);
    expect(planTimelineCatchUpPastApplied(parked, undefined)).toBe(parked);
  });
});
