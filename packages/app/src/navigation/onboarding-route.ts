/**
 * ADR-0056: which first-run screen the index route opens before the normal
 * startup route resolver runs.
 *
 * - A phone with no saved host shows the onboarding (welcome, then "Connect
 *   your workstation"). Nothing about Tailscale gates it.
 * - The desktop never shows onboarding: its bundled daemon is added as the
 *   "Local" host and the startup resolver lands in the main shell.
 * - The browser build keeps the startup resolver's welcome route.
 *
 * Once a phone has seen an empty, hydrated host registry it stays on
 * onboarding until a host exists, so a slow host list does not bounce the
 * user between the splash and onboarding.
 */
export type OnboardingRoute = "connect-workstation" | "startup";

export interface OnboardingRouteInput {
  isNative: boolean;
  hostRegistryStatus: "loading" | "ready";
  hostCount: number;
  latched: boolean;
}

export interface OnboardingRouteDecision {
  route: OnboardingRoute;
  latched: boolean;
}

export function resolveOnboardingRoute(input: OnboardingRouteInput): OnboardingRouteDecision {
  if (!input.isNative || input.hostCount > 0) {
    return { route: "startup", latched: false };
  }
  const latched = input.latched || input.hostRegistryStatus === "ready";
  return { route: latched ? "connect-workstation" : "startup", latched };
}
