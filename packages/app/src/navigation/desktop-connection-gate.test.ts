import { describe, expect, it } from "vitest";
import { shouldRedirectToDesktopTailscaleLogin } from "./desktop-connection-gate";

const baseInput = {
  desktopRuntime: true,
  connectionModeLoaded: true,
  pathname: "/",
  mode: "tailscale" as const,
};

describe("desktop Tailscale connection gate", () => {
  it("does not interrupt a saved Tailscale mode while status is still recovering", () => {
    for (const loginStatusKind of ["unknown", "connecting", "unavailable"] as const) {
      expect(shouldRedirectToDesktopTailscaleLogin({ ...baseInput, loginStatusKind })).toBe(false);
    }
  });

  it("opens login only after a saved mode is confirmed to need login", () => {
    expect(
      shouldRedirectToDesktopTailscaleLogin({ ...baseInput, loginStatusKind: "needs-login" }),
    ).toBe(true);
  });

  it("keeps first-run desktop startup on the login gate", () => {
    expect(
      shouldRedirectToDesktopTailscaleLogin({
        ...baseInput,
        mode: null,
        loginStatusKind: "unknown",
      }),
    ).toBe(true);
  });

  it("returns to the host picker when the Tailscale host has timed out", () => {
    // A settled timeout ("error") will not self-recover — even while the login
    // status still reads as a recovering state — so the gate must open.
    for (const loginStatusKind of ["unknown", "connecting", "unavailable"] as const) {
      expect(
        shouldRedirectToDesktopTailscaleLogin({
          ...baseInput,
          loginStatusKind,
          tailscaleTimedOut: true,
        }),
      ).toBe(true);
    }
  });

  it("does not redirect on timeout when the user is in Local mode", () => {
    expect(
      shouldRedirectToDesktopTailscaleLogin({
        ...baseInput,
        mode: "local",
        loginStatusKind: "unknown",
        tailscaleTimedOut: true,
      }),
    ).toBe(false);
  });
});
