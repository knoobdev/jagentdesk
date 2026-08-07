import { afterEach, describe, expect, test, vi } from "vitest";

import { createNonceChallengeManager } from "./nonce-challenge.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("nonce challenge manager", () => {
  test("issue returns unique nonces", () => {
    const challenges = createNonceChallengeManager({});
    const nonces = new Set<string>();
    for (let index = 0; index < 50; index++) {
      nonces.add(challenges.issue());
    }
    expect(nonces.size).toBe(50);
  });

  test("consume returns true once, then false (single use)", () => {
    const challenges = createNonceChallengeManager({});
    const nonce = challenges.issue();

    expect(challenges.consume(nonce)).toBe(true);
    expect(challenges.consume(nonce)).toBe(false);
    expect(challenges.size()).toBe(0);
  });

  test("consume of an unknown nonce returns false", () => {
    const challenges = createNonceChallengeManager({});
    expect(challenges.consume("never-issued")).toBe(false);
  });

  test("expired nonce is rejected and removed", () => {
    const challenges = createNonceChallengeManager({ ttlMs: -1000 });
    const nonce = challenges.issue();

    expect(challenges.consume(nonce)).toBe(false);
    expect(challenges.consume(nonce)).toBe(false);
  });

  test("issue prunes expired entries before generating", () => {
    vi.useFakeTimers();
    const challenges = createNonceChallengeManager({ ttlMs: 1000 });
    const expired = challenges.issue();
    vi.advanceTimersByTime(1001);
    const fresh = challenges.issue();

    expect(challenges.size()).toBe(1);
    expect(challenges.consume(expired)).toBe(false);
    expect(challenges.consume(fresh)).toBe(true);
  });

  test("maxEntries cap drops the oldest nonce", () => {
    const challenges = createNonceChallengeManager({ maxEntries: 2 });
    const first = challenges.issue();
    challenges.issue();
    const third = challenges.issue();

    expect(challenges.size()).toBe(2);
    expect(challenges.consume(first)).toBe(false);
    expect(challenges.consume(third)).toBe(true);
  });

  test("size reflects the current entry count", () => {
    const challenges = createNonceChallengeManager({});
    expect(challenges.size()).toBe(0);
    const nonce = challenges.issue();
    challenges.issue();
    expect(challenges.size()).toBe(2);
    challenges.consume(nonce);
    expect(challenges.size()).toBe(1);
  });

  test("injectable randomBytes is used for nonce generation", () => {
    const deterministic = (size: number) => Buffer.alloc(size, 0xab);
    const challenges = createNonceChallengeManager({ randomBytes: deterministic });
    const nonce = challenges.issue();
    expect(nonce).toBe(Buffer.alloc(32, 0xab).toString("base64url"));
  });
});
