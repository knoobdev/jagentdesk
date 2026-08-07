import { describe, expect, test } from "vitest";
import { createPairingCodeManager } from "./pairing-code.js";

describe("pairing code", () => {
  test("issues a six-digit code and accepts it until expiry", () => {
    let now = 1_000;
    const manager = createPairingCodeManager(() => now);
    const code = manager.issue();
    expect(code).toMatch(/^\d{6}$/);
    expect(manager.verify(code)).toBe(true);
    now += 5 * 60 * 1000;
    expect(manager.verify(code)).toBe(false);
  });

  test("keeps the current code stable during its validity window", () => {
    const manager = createPairingCodeManager(() => 1_000);
    expect(manager.current()).toBe(manager.current());
  });

  test("exposes the same expiry used by verification and supports explicit rotation", () => {
    let now = 1_000;
    const manager = createPairingCodeManager(() => now);
    const first = manager.currentWithExpiry();
    expect(first.expiresAtMs).toBe(301_000);
    expect(manager.verify(first.code)).toBe(true);

    now += 1;
    const refreshed = manager.rotate();
    expect(refreshed.expiresAtMs).toBe(301_001);
    expect(refreshed.code).not.toBe(first.code);
    expect(manager.currentWithExpiry()).toEqual(refreshed);
    expect(manager.verify(first.code)).toBe(false);
    expect(manager.verify(refreshed.code)).toBe(true);
  });

  test("issues distinct request codes and binds verification to its request", () => {
    const manager = createPairingCodeManager(() => 1_000);
    const first = manager.issueWithExpiry();
    const second = manager.issueWithExpiry();

    expect(first.code).not.toBe(second.code);
    expect(manager.verifyForRequest(first.code, first)).toBe(true);
    expect(manager.verifyForRequest(second.code, second)).toBe(true);
    expect(manager.verifyForRequest(first.code, second)).toBe(false);
  });
});
