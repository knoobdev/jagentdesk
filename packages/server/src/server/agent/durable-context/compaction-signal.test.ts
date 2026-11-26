import { describe, expect, it } from "vitest";
import { CompactionSignalTracker, EXPLICIT_COMPACTION_PROVIDERS } from "./compaction-signal.js";

function tracker() {
  let now = 1_000_000;
  const instance = new CompactionSignalTracker(() => now);
  return {
    tracker: instance,
    advance(ms: number) {
      now += ms;
    },
  };
}

function usage(used: number, max = 200_000) {
  return { contextWindowUsedTokens: used, contextWindowMaxTokens: max };
}

describe("explicit compaction signals (spec 42 §1)", () => {
  it.each(["claude", "codex", "opencode", "omp"])(
    "%s: a completed compaction row is a compaction and the next usage gives its after-size",
    (provider) => {
      const { tracker: signals } = tracker();
      signals.observeUsage({ agentId: "a", provider, sessionId: "s1", usage: usage(150_000) });
      const detected = signals.observeTimelineItem({
        agentId: "a",
        provider,
        sessionId: "s1",
        item: { type: "compaction", status: "completed", trigger: "manual" },
      });
      expect(detected).toEqual({
        provider,
        trigger: "manual",
        preTokens: 150_000,
        postTokens: null,
        inferred: false,
        confirmsPrevious: false,
      });
      const after = signals.observeUsage({
        agentId: "a",
        provider,
        sessionId: "s1",
        usage: usage(20_000),
      });
      expect(after).toEqual({ detected: null, postTokens: 20_000 });
    },
  );

  it("uses the provider's own pre-compaction size when the row carries it", () => {
    const { tracker: signals } = tracker();
    const detected = signals.observeTimelineItem({
      agentId: "a",
      provider: "claude",
      sessionId: "s1",
      item: { type: "compaction", status: "completed", trigger: "auto", preTokens: 190_000 },
    });
    expect(detected?.preTokens).toBe(190_000);
    expect(detected?.trigger).toBe("auto");
  });

  it("waits for a smaller usage report: Codex repeats the old size right after compacting", () => {
    const { tracker: signals } = tracker();
    signals.observeUsage({
      agentId: "a",
      provider: "codex",
      sessionId: "s1",
      usage: usage(20_228),
    });
    signals.observeTimelineItem({
      agentId: "a",
      provider: "codex",
      sessionId: "s1",
      item: { type: "compaction", status: "completed", trigger: "manual" },
    });
    expect(
      signals.observeUsage({
        agentId: "a",
        provider: "codex",
        sessionId: "s1",
        usage: usage(20_228),
      }),
    ).toEqual({ detected: null, postTokens: null });
    expect(
      signals.observeUsage({
        agentId: "a",
        provider: "codex",
        sessionId: "s1",
        usage: usage(6_100),
      }).postTokens,
    ).toBe(6_100);
  });

  it("ignores the loading row; only the completed one counts", () => {
    const { tracker: signals } = tracker();
    expect(
      signals.observeTimelineItem({
        agentId: "a",
        provider: "claude",
        sessionId: "s1",
        item: { type: "compaction", status: "loading" },
      }),
    ).toBeNull();
  });

  it("never infers for a provider that reports its own compactions", () => {
    const { tracker: signals } = tracker();
    for (const provider of EXPLICIT_COMPACTION_PROVIDERS) {
      signals.observeUsage({ agentId: provider, provider, sessionId: "s", usage: usage(150_000) });
      const drop = signals.observeUsage({
        agentId: provider,
        provider,
        sessionId: "s",
        usage: usage(10_000),
      });
      expect(drop.detected).toBeNull();
    }
  });
});

describe("inferred compaction signal", () => {
  it.each(["pi", "copilot", "cursor", "kimi", "kiro", "my-custom-api", "acp"])(
    "%s: a drop of at least 40 %% between two usage reports is a compaction",
    (provider) => {
      const { tracker: signals } = tracker();
      signals.observeUsage({ agentId: "a", provider, sessionId: "s1", usage: usage(100_000) });
      const result = signals.observeUsage({
        agentId: "a",
        provider,
        sessionId: "s1",
        usage: usage(60_000),
      });
      expect(result.detected).toEqual({
        provider,
        trigger: null,
        preTokens: 100_000,
        postTokens: 60_000,
        inferred: true,
        confirmsPrevious: false,
      });
    },
  );

  it("does not fire for a drop under 40 %, under 2 000 tokens, or for growth", () => {
    const { tracker: signals } = tracker();
    const observe = (used: number) =>
      signals.observeUsage({ agentId: "a", provider: "pi", sessionId: "s1", usage: usage(used) })
        .detected;
    expect(observe(100_000)).toBeNull();
    expect(observe(61_000)).toBeNull();
    expect(observe(80_000)).toBeNull();
    expect(observe(3_000)).not.toBeNull();
    expect(observe(4_000)).toBeNull();
    expect(observe(2_500)).toBeNull();
  });

  it("does not read a new native session (/clear, rollover) as a compaction", () => {
    const { tracker: signals } = tracker();
    signals.observeUsage({ agentId: "a", provider: "pi", sessionId: "s1", usage: usage(120_000) });
    const fresh = signals.observeUsage({
      agentId: "a",
      provider: "pi",
      sessionId: "s2",
      usage: usage(5_000),
    });
    expect(fresh.detected).toBeNull();
  });

  it("does not fire after reset (provider switch)", () => {
    const { tracker: signals } = tracker();
    signals.observeUsage({ agentId: "a", provider: "pi", sessionId: "s1", usage: usage(120_000) });
    signals.reset("a");
    expect(
      signals.observeUsage({ agentId: "a", provider: "pi", sessionId: "s1", usage: usage(5_000) })
        .detected,
    ).toBeNull();
  });

  it("an explicit row right after an inferred drop confirms it instead of counting twice", () => {
    const { tracker: signals, advance } = tracker();
    signals.observeUsage({ agentId: "a", provider: "pi", sessionId: "s1", usage: usage(120_000) });
    expect(
      signals.observeUsage({ agentId: "a", provider: "pi", sessionId: "s1", usage: usage(30_000) })
        .detected?.inferred,
    ).toBe(true);
    advance(5_000);
    const explicit = signals.observeTimelineItem({
      agentId: "a",
      provider: "pi",
      sessionId: "s1",
      item: { type: "compaction", status: "completed" },
    });
    expect(explicit?.confirmsPrevious).toBe(true);
  });

  it("a drop right after an explicit row is the same compaction", () => {
    const { tracker: signals, advance } = tracker();
    signals.observeUsage({ agentId: "a", provider: "pi", sessionId: "s1", usage: usage(120_000) });
    signals.observeTimelineItem({
      agentId: "a",
      provider: "pi",
      sessionId: "s1",
      item: { type: "compaction", status: "completed" },
    });
    // The first usage after the row is its after-size.
    expect(
      signals.observeUsage({ agentId: "a", provider: "pi", sessionId: "s1", usage: usage(90_000) })
        .postTokens,
    ).toBe(90_000);
    advance(1_000);
    expect(
      signals.observeUsage({ agentId: "a", provider: "pi", sessionId: "s1", usage: usage(30_000) })
        .detected,
    ).toBeNull();
  });
});
