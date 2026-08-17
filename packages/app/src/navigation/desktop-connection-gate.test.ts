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
});
