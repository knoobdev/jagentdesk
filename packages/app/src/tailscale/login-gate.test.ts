import { describe, expect, it } from "vitest";
import {
  classifyPairingCodeEntry,
  isTailscaleReady,
  resolvePairVerifyDecision,
  shouldRoutePairVerifyToTailscaleLogin,
  tailnetModeAfterPairing,
} from "./login-gate";

describe("isTailscaleReady", () => {
  it("is ready only for the real connected status", () => {
    expect(isTailscaleReady({ kind: "connected" })).toBe(true);
    expect(isTailscaleReady({ kind: "needs-login" })).toBe(false);
    expect(isTailscaleReady({ kind: "unavailable" })).toBe(false);
    expect(isTailscaleReady({ kind: "connecting" })).toBe(false);
    expect(isTailscaleReady({ kind: "unknown" })).toBe(false);
  });
});

describe("shouldRoutePairVerifyToTailscaleLogin", () => {
  it("routes to login while native tsnet is starting or needs login", () => {
    expect(shouldRoutePairVerifyToTailscaleLogin({ kind: "needs-login" })).toBe(true);
    expect(shouldRoutePairVerifyToTailscaleLogin({ kind: "connecting" })).toBe(true);
    expect(shouldRoutePairVerifyToTailscaleLogin({ kind: "unavailable" })).toBe(true);

    // A connected device stays on pair-verify, and unknown waits for the
    // adapter hydration result instead of making a premature navigation.
    expect(shouldRoutePairVerifyToTailscaleLogin({ kind: "connected" })).toBe(false);
    expect(shouldRoutePairVerifyToTailscaleLogin({ kind: "unknown" })).toBe(false);
  });
});

describe("classifyPairingCodeEntry", () => {
  it("waits on an incomplete code", () => {
    expect(
      classifyPairingCodeEntry({
        codeComplete: false,
        resolverArmed: false,
        hasLiveAttempt: true,
      }),
    ).toBe("wait");
    expect(
      classifyPairingCodeEntry({
        codeComplete: false,
        resolverArmed: true,
        hasLiveAttempt: true,
      }),
    ).toBe("wait");
  });

  it("resolves the in-flight attempt when it is waiting for the code", () => {
    expect(
      classifyPairingCodeEntry({
        codeComplete: true,
        resolverArmed: true,
        hasLiveAttempt: true,
      }),
    ).toBe("resolve");
  });

  it("starts a fresh attempt when no attempt is live and a full code is entered", () => {
    expect(
      classifyPairingCodeEntry({
        codeComplete: true,
        resolverArmed: false,
        hasLiveAttempt: false,
      }),
    ).toBe("start-attempt");
  });

  it("does nothing when a live attempt already consumed a full code", () => {
    expect(
      classifyPairingCodeEntry({
        codeComplete: true,
        resolverArmed: false,
        hasLiveAttempt: true,
      }),
    ).toBe("wait");
  });
});

describe("resolvePairVerifyDecision", () => {
  it("pairs a relay link over relay while the device is off the tailnet", () => {
    for (const kind of ["needs-login", "unavailable", "connecting", "unknown"] as const) {
      expect(resolvePairVerifyDecision({ hasRelay: true, local: false, status: { kind } })).toEqual(
        { kind: "pair", route: "relay" },
      );
    }
  });

  it("sends a tailnet-only link to Tailscale sign-in when the device is not on the tailnet", () => {
    expect(
      resolvePairVerifyDecision({ hasRelay: false, local: false, status: { kind: "needs-login" } }),
    ).toEqual({ kind: "tailscale-login" });
    expect(
      resolvePairVerifyDecision({ hasRelay: false, local: false, status: { kind: "unavailable" } }),
    ).toEqual({ kind: "tailscale-login" });
  });

  it("waits for the Tailscale status before deciding a tailnet-only link", () => {
    expect(
      resolvePairVerifyDecision({ hasRelay: false, local: false, status: { kind: "unknown" } }),
    ).toEqual({ kind: "wait" });
  });

  it("pairs a tailnet-only link over the tailnet once connected", () => {
    expect(
      resolvePairVerifyDecision({ hasRelay: false, local: false, status: { kind: "connected" } }),
    ).toEqual({ kind: "pair", route: "tailnet" });
  });

  it("pairs a loopback link without the tailnet", () => {
    expect(
      resolvePairVerifyDecision({ hasRelay: false, local: true, status: { kind: "needs-login" } }),
    ).toEqual({ kind: "pair", route: "local" });
  });
});

describe("tailnetModeAfterPairing", () => {
  it("records tailnet after a tailnet pairing", () => {
    expect(tailnetModeAfterPairing({ route: "tailnet", current: null })).toBe("tailnet");
    expect(tailnetModeAfterPairing({ route: "tailnet", current: "off" })).toBe("tailnet");
  });

  it("records off for a first relay pairing and keeps an existing sign-in", () => {
    expect(tailnetModeAfterPairing({ route: "relay", current: null })).toBe("off");
    expect(tailnetModeAfterPairing({ route: "relay", current: "tailnet" })).toBe("tailnet");
    expect(tailnetModeAfterPairing({ route: "local", current: "off" })).toBe("off");
  });
});
