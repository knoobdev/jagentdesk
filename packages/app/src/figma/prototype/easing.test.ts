import { describe, expect, it } from "vitest";
import { cubicBezier, easingFor, resolveEasing } from "./easing";

describe("cubicBezier", () => {
  it("maps the endpoints exactly and clamps outside", () => {
    const ease = easingFor("EASE_IN_AND_OUT");
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(-0.4)).toBe(0);
    expect(ease(1.4)).toBe(1);
  });

  it("is the identity for linear control points", () => {
    const linear = cubicBezier(0, 0, 1, 1);
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(linear(x)).toBeCloseTo(x, 5);
    }
  });

  it("is monotonic for the in and out presets", () => {
    for (const name of ["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT"] as const) {
      const ease = easingFor(name);
      let previous = 0;
      for (let x = 0; x <= 1.0001; x += 0.05) {
        const value = ease(x);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-6);
        previous = value;
      }
    }
  });

  it("lags then leads: ease-in starts below linear, ease-out starts above", () => {
    expect(easingFor("EASE_IN")(0.25)).toBeLessThan(0.25);
    expect(easingFor("EASE_OUT")(0.25)).toBeGreaterThan(0.25);
  });

  it("lets the gentle spring overshoot past 1", () => {
    const spring = easingFor("GENTLE_SPRING");
    const peak = Math.max(...Array.from({ length: 20 }, (_, i) => spring((i + 1) / 20)));
    expect(peak).toBeGreaterThan(1);
    expect(spring(1)).toBe(1);
  });

  it("resolves unknown easing names to ease-in-and-out", () => {
    expect(resolveEasing("SPRING_ROCKET")(0.5)).toBe(resolveEasing("EASE_IN_AND_OUT")(0.5));
    expect(resolveEasing(null)(0.5)).toBe(resolveEasing("EASE_IN_AND_OUT")(0.5));
  });

  it("rebuilds the daemon's custom cubic-bezier curves from the wire string", () => {
    // The daemon appends the control points: `CUSTOM_CUBIC_BEZIER(0.42,0,0.58,1)`
    // (server figma/prototype.ts easingName). A bare CUSTOM_CUBIC_BEZIER without points has
    // no curve to rebuild and stays on the default.
    const custom = resolveEasing("CUSTOM_CUBIC_BEZIER(0.42,0,0.58,1)");
    expect(custom(0.5)).toBeCloseTo(cubicBezier(0.42, 0, 0.58, 1)(0.5), 12);
    expect(resolveEasing("CUSTOM_CUBIC_BEZIER 0.42 0 0.58 1")(0.25)).toBeCloseTo(custom(0.25), 12);
    expect(resolveEasing("CUSTOM_CUBIC_BEZIER")(0.5)).toBe(resolveEasing("EASE_IN_AND_OUT")(0.5));
    // y control points may overshoot, like the spring presets; x stays in [0, 1].
    const overshoot = resolveEasing("CUSTOM_CUBIC_BEZIER(0.175,0.885,0.32,1.275)");
    expect(overshoot(0.5)).toBeGreaterThan(0.5);
    expect(resolveEasing("CUSTOM_CUBIC_BEZIER(5,0,-5,1)")(0.5)).toBeCloseTo(
      cubicBezier(1, 0, 0, 1)(0.5),
      12,
    );
  });
});
