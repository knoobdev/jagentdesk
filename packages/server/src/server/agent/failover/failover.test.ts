import { describe, expect, it } from "vitest";
import { FailoverRateLimiter, pickFailoverTarget } from "./failover-policy.js";
import { classifyTurnFailure } from "./turn-failure-classification.js";

describe("classifyTurnFailure", () => {
  it.each([
    ["Claude AI usage limit reached|1764150000"],
    ["You've hit your limit · resets 3pm (Asia/Saigon)"],
    ["5-hour limit reached ∙ resets 9pm"],
    ["You've hit your usage limit. Upgrade to Pro or try again at 3:45 PM."],
    ["429 insufficient_quota: You exceeded your current quota, please check your plan"],
    ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}'],
    ["Your credit balance is too low to access the Anthropic API."],
  ])("treats %j as a usage limit", (error) => {
    expect(classifyTurnFailure({ error })).toBe("usage_limit");
  });

  it.each([
    ["fetch failed: ECONNRESET", "network"],
    ["stream disconnected before completion", "network"],
    ["Request timed out", "network"],
    ["401 Unauthorized: invalid x-api-key", "auth"],
    ["Not logged in · Please run /login", "auth"],
    ["Edit failed: old_string not found in file", "other"],
    ["Requested mock provider failure", "other"],
  ])("treats %j as %s", (error, kind) => {
    expect(classifyTurnFailure({ error })).toBe(kind);
  });

  it("reads the code and diagnostic too", () => {
    expect(classifyTurnFailure({ error: "Turn failed", code: "usageLimitExceeded" })).toBe(
      "usage_limit",
    );
  });
});

describe("pickFailoverTarget", () => {
  const order = [
    { provider: "claude", model: "sonnet" },
    { provider: "codex", model: null },
    { provider: "opencode", model: "openrouter/x" },
  ];

  it("skips the failing provider, disabled providers and providers out of quota", () => {
    expect(
      pickFailoverTarget({
        order,
        currentProvider: "claude",
        isAvailable: (provider) => provider !== "codex",
        isExhausted: () => false,
      }),
    ).toEqual({ provider: "opencode", model: "openrouter/x" });
    expect(
      pickFailoverTarget({
        order,
        currentProvider: "claude",
        isAvailable: () => true,
        isExhausted: (provider) => provider === "codex",
      }),
    ).toEqual({ provider: "opencode", model: "openrouter/x" });
  });

  it("returns null when the list is used up", () => {
    expect(
      pickFailoverTarget({
        order: [{ provider: "claude", model: null }],
        currentProvider: "claude",
        isAvailable: () => true,
        isExhausted: () => false,
      }),
    ).toBeNull();
  });
});

describe("FailoverRateLimiter", () => {
  it("allows three failovers per agent per rolling hour", () => {
    const limiter = new FailoverRateLimiter();
    const start = 1_000_000;
    for (let index = 0; index < 3; index += 1) {
      expect(limiter.canFailover("a", start + index)).toBe(true);
      limiter.record("a", start + index);
    }
    expect(limiter.canFailover("a", start + 10)).toBe(false);
    expect(limiter.canFailover("b", start + 10)).toBe(true);
    expect(limiter.canFailover("a", start + 60 * 60 * 1000 + 1)).toBe(true);
  });
});
