import pino from "pino";
import { describe, expect, it } from "vitest";
import type { UsageLimitNotice } from "../agent-sdk-types.js";
import { FailoverCoordinator } from "./failover-coordinator.js";
import type { FailoverConfig, ProviderModelRef } from "./failover-policy.js";

const USAGE_LIMIT = "You've hit your usage limit. Try again at 9:00 PM.";

function harness(config: FailoverConfig) {
  const switches: Array<{ agentId: string; target: ProviderModelRef }> = [];
  const resends: Array<{ agentId: string; prompt: unknown }> = [];
  const notices: UsageLimitNotice[] = [];
  let now = 1_000_000;
  const coordinator = new FailoverCoordinator({
    resolveConfig: async () => config,
    listEnabledProviders: () => ["claude", "codex", "opencode"],
    isExhausted: () => false,
    switchProvider: async (agentId, target) => {
      switches.push({ agentId, target });
    },
    resend: async (agentId, prompt) => {
      resends.push({ agentId, prompt });
    },
    readLastUserMessage: async () => "from the timeline",
    appendUsageLimitNotice: async (_agentId, notice) => {
      notices.push(notice);
    },
    logger: pino({ level: "silent" }),
    now: () => now,
  });
  return {
    coordinator,
    switches,
    resends,
    notices,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const enabled: FailoverConfig = { enabled: true, order: [{ provider: "codex", model: null }] };

describe("FailoverCoordinator", () => {
  it("switches along the order and resends the failed turn's exact prompt", async () => {
    const h = harness(enabled);
    h.coordinator.rememberPrompt("a", "turn three");
    const result = await h.coordinator.handleTurnFailure({
      agentId: "a",
      provider: "claude",
      error: USAGE_LIMIT,
    });
    expect(result).toBe("failover");
    expect(h.switches).toEqual([{ agentId: "a", target: { provider: "codex", model: null } }]);
    expect(h.resends).toEqual([{ agentId: "a", prompt: "turn three" }]);
  });

  it("ignores network, auth and tool failures", async () => {
    const h = harness(enabled);
    for (const error of ["fetch failed: ECONNRESET", "401 Unauthorized", "Edit failed"]) {
      expect(
        await h.coordinator.handleTurnFailure({ agentId: "a", provider: "claude", error }),
      ).toBe("ignored");
    }
    expect(h.switches).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("fails over at most once per turn: a limit on the resend leaves a notice", async () => {
    const h = harness({
      enabled: true,
      order: [
        { provider: "codex", model: null },
        { provider: "opencode", model: null },
      ],
    });
    await h.coordinator.handleTurnFailure({ agentId: "a", provider: "claude", error: USAGE_LIMIT });
    const second = await h.coordinator.handleTurnFailure({
      agentId: "a",
      provider: "codex",
      error: USAGE_LIMIT,
    });
    expect(second).toBe("notice");
    expect(h.switches).toHaveLength(1);
    expect(h.notices[0]).toEqual({
      provider: "codex",
      failover: "repeat",
      suggestion: { provider: "opencode", model: null },
    });
  });

  it("caps automatic failovers at three an hour per agent", async () => {
    const h = harness(enabled);
    for (let index = 0; index < 3; index += 1) {
      await h.coordinator.handleTurnFailure({
        agentId: "a",
        provider: "claude",
        error: USAGE_LIMIT,
      });
      h.coordinator.settleTurn("a");
      h.advance(60_000);
    }
    expect(
      await h.coordinator.handleTurnFailure({
        agentId: "a",
        provider: "claude",
        error: USAGE_LIMIT,
      }),
    ).toBe("notice");
    expect(h.notices.at(-1)?.failover).toBe("capped");
    h.advance(60 * 60 * 1000);
    expect(
      await h.coordinator.handleTurnFailure({
        agentId: "a",
        provider: "claude",
        error: USAGE_LIMIT,
      }),
    ).toBe("failover");
  });

  it("with failover off, suggests the next provider and Continue with resends from the timeline", async () => {
    const h = harness({ enabled: false, order: [] });
    expect(
      await h.coordinator.handleTurnFailure({
        agentId: "a",
        provider: "claude",
        error: USAGE_LIMIT,
      }),
    ).toBe("notice");
    expect(h.notices[0]).toEqual({
      provider: "claude",
      failover: "off",
      suggestion: { provider: "codex", model: null },
    });
    await h.coordinator.continueWith("a", { provider: "codex", model: null });
    expect(h.resends).toEqual([{ agentId: "a", prompt: "from the timeline" }]);
  });
});
