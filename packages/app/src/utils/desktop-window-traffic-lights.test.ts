import { describe, expect, it } from "vitest";
import { resolveTrafficLightOffsetY } from "./desktop-window";

describe("resolveTrafficLightOffsetY", () => {
  it("centres the lights on the Gumloop brand row", () => {
    expect(resolveTrafficLightOffsetY({ gumloopShell: true, liftTrafficLights: false })).toBe(8);
    expect(resolveTrafficLightOffsetY({ gumloopShell: true, liftTrafficLights: true })).toBe(8);
  });

  it("keeps the classic top bar positions", () => {
    expect(resolveTrafficLightOffsetY({ gumloopShell: false, liftTrafficLights: false })).toBe(0.5);
    expect(resolveTrafficLightOffsetY({ gumloopShell: false, liftTrafficLights: true })).toBe(-5);
  });
});
