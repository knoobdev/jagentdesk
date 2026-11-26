import { describe, expect, it } from "vitest";
import { resolveOnboardingRoute } from "./onboarding-route";

describe("resolveOnboardingRoute", () => {
  it("opens onboarding on a fresh phone once the host list is hydrated", () => {
    expect(
      resolveOnboardingRoute({
        isNative: true,
        hostRegistryStatus: "ready",
        hostCount: 0,
        latched: false,
      }),
    ).toEqual({ route: "connect-workstation", latched: true });
  });

  it("waits for the host list before choosing onboarding on a phone", () => {
    expect(
      resolveOnboardingRoute({
        isNative: true,
        hostRegistryStatus: "loading",
        hostCount: 0,
        latched: false,
      }),
    ).toEqual({ route: "startup", latched: false });
  });

  it("stays on onboarding while the registry reloads after it was empty", () => {
    expect(
      resolveOnboardingRoute({
        isNative: true,
        hostRegistryStatus: "loading",
        hostCount: 0,
        latched: true,
      }),
    ).toEqual({ route: "connect-workstation", latched: true });
  });

  it("leaves onboarding once the phone has a host", () => {
    expect(
      resolveOnboardingRoute({
        isNative: true,
        hostRegistryStatus: "ready",
        hostCount: 1,
        latched: true,
      }),
    ).toEqual({ route: "startup", latched: false });
  });

  it("never shows onboarding on the desktop or the browser, even with no host", () => {
    expect(
      resolveOnboardingRoute({
        isNative: false,
        hostRegistryStatus: "ready",
        hostCount: 0,
        latched: false,
      }),
    ).toEqual({ route: "startup", latched: false });
  });
});
