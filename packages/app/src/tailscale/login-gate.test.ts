import { describe, expect, it } from "vitest";
import {
  classifyPairingCodeEntry,
  isTailscaleReady,
  shouldRoutePairVerifyToTailscaleLogin,
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
