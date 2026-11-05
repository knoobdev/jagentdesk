import { describe, expect, it } from "vitest";
import {
  advanceTimeline,
  planTransition,
  transitionVisuals,
  type TransitionPlan,
} from "./transition-timeline";

describe("planTransition", () => {
  it("normalizes a wire PUSH with direction, duration and easing", () => {
    const plan = planTransition({
      type: "PUSH",
      direction: "LEFT",
      durationMs: 450,
      easing: "EASE_OUT",
    });
    expect(plan).toEqual({ type: "PUSH", direction: "LEFT", durationMs: 450, easing: "EASE_OUT" });
  });

  it("plays null, unknown and INSTANT transitions instantly", () => {
    expect(planTransition(null).type).toBe("INSTANT");
    expect(planTransition({ type: "FLIP_3D_CARDS_FOREVER" }).type).toBe("INSTANT");
    expect(planTransition({ type: "INSTANT", durationMs: 700 }).durationMs).toBe(0);
  });

  it("defaults duration and easing for slide types and falls back to a rightward direction", () => {
    const plan = planTransition({ type: "SLIDE_IN" });
    expect(plan.durationMs).toBeGreaterThan(0);
    expect(plan.easing).toBe("EASE_IN_AND_OUT");
    expect(plan.direction).toBe("RIGHT");
  });

  it("keeps dissolve free of a direction", () => {
    const plan = planTransition({ type: "DISSOLVE", direction: "LEFT", durationMs: 200 });
    expect(plan.type).toBe("DISSOLVE");
    expect(plan.direction).toBeNull();
  });
});

describe("advanceTimeline", () => {
  const plan: TransitionPlan = {
    type: "DISSOLVE",
    direction: null,
    durationMs: 200,
    easing: "LINEAR",
  };

  it("completes instant transitions immediately", () => {
    const instant = planTransition({ type: "INSTANT" });
    expect(advanceTimeline(instant, 0)).toEqual({ progress: 1, eased: 1, done: true });
  });

  it("tracks linear easing and finishes on time", () => {
    expect(advanceTimeline(plan, 50)).toMatchObject({ progress: 0.25, done: false });
    expect(advanceTimeline(plan, 100)).toMatchObject({ progress: 0.5, eased: 0.5, done: false });
    expect(advanceTimeline(plan, 200)).toEqual({ progress: 1, eased: 1, done: true });
  });

  it("clamps before and after the window", () => {
    expect(advanceTimeline(plan, -20)).toMatchObject({ progress: 0, done: false });
    expect(advanceTimeline(plan, 9_999)).toMatchObject({ progress: 1, done: true });
  });
});

describe("transitionVisuals", () => {
  const base = { direction: "RIGHT" as const, durationMs: 100, easing: "LINEAR" };

  it("crossfades dissolve at complementary opacities", () => {
    const half = transitionVisuals({ type: "DISSOLVE", ...base }, 0.4);
    expect(half.fromOpacity).toBeCloseTo(0.6);
    expect(half.toOpacity).toBeCloseTo(0.4);
    expect(half.toOffset).toEqual({ x: 0, y: 0 });
  });

  it("slides the incoming frame in from the direction edge", () => {
    const start = transitionVisuals({ type: "MOVE_IN", ...base }, 0);
    const end = transitionVisuals({ type: "MOVE_IN", ...base }, 1);
    expect(start.toOffset).toEqual({ x: 1, y: 0 });
    expect(end.toOffset).toEqual({ x: 0, y: 0 });
    expect(start.fromOffset).toEqual({ x: 0, y: 0 });
  });

  it("moves the outgoing frame away for MOVE_OUT", () => {
    const end = transitionVisuals({ type: "MOVE_OUT", ...base }, 1);
    expect(end.fromOffset).toEqual({ x: -1, y: 0 });
    expect(end.toOffset).toEqual({ x: 0, y: 0 });
  });

  it("pushes both frames along the axis for PUSH", () => {
    const mid = transitionVisuals({ type: "PUSH", ...base, direction: "BOTTOM" }, 0.5);
    expect(mid.fromOffset).toEqual({ x: 0, y: -0.5 });
    expect(mid.toOffset).toEqual({ x: 0, y: 0.5 });
  });

  it("fades the outgoing layer while sliding in for SLIDE_IN", () => {
    const mid = transitionVisuals({ type: "SLIDE_IN", ...base }, 0.5);
    expect(mid.fromOpacity).toBeCloseTo(0.5);
    expect(mid.toOffset).toEqual({ x: 0.5, y: 0 });
  });

  it("fades the incoming layer while sliding out for SLIDE_OUT", () => {
    const mid = transitionVisuals({ type: "SLIDE_OUT", ...base }, 0.5);
    expect(mid.toOpacity).toBeCloseTo(0.5);
    expect(mid.fromOffset).toEqual({ x: -0.5, y: 0 });
  });
});
