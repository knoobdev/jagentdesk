import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildLifetimeBaseline, UsageHistoryStorage } from "./usage-history-storage.js";

const logger = { child: () => logger, error: vi.fn(), info: vi.fn(), warn: vi.fn() } as never;
const DAY1 = Date.parse("2026-08-28T10:00:00Z");
const DAY1_LATER = Date.parse("2026-08-28T22:00:00Z");
const DAY2 = Date.parse("2026-08-29T01:00:00Z");

describe("UsageHistoryStorage", () => {
  let home: string;
  let store: UsageHistoryStorage;

  beforeEach(async () => {
    home = mkdtempSync(path.join(tmpdir(), "jad-usage-"));
    store = new UsageHistoryStorage(home, logger);
    await store.initialize();
  });

  afterEach(async () => {
    await store.flush();
    rmSync(home, { recursive: true, force: true });
  });

  it("rolls up multiple turns on the same UTC day, with a per-model breakdown", () => {
    store.record({
      timestampMs: DAY1,
      model: "claude-opus",
      usage: { inputTokens: 100, outputTokens: 20, totalCostUsd: 0.01 },
    });
    store.record({
      timestampMs: DAY1_LATER,
      model: "gpt-5.6",
      usage: { inputTokens: 50, outputTokens: 10, totalCostUsd: 0.005 },
    });

    const days = store.get();
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe("2026-08-28");
    expect(days[0].inputTokens).toBe(150);
    expect(days[0].outputTokens).toBe(30);
    expect(days[0].totalCostUsd).toBeCloseTo(0.015);
    expect(days[0].turns).toBe(2);
    expect(days[0].byModel["claude-opus"].inputTokens).toBe(100);
    expect(days[0].byModel["gpt-5.6"].inputTokens).toBe(50);
  });

  it("separates turns into different day buckets, sorted oldest→newest", () => {
    store.record({ timestampMs: DAY2, model: "m", usage: { inputTokens: 5 } });
    store.record({ timestampMs: DAY1, model: "m", usage: { inputTokens: 7 } });
    const days = store.get();
    expect(days.map((d) => d.date)).toEqual(["2026-08-28", "2026-08-29"]);
  });

  it("notifies onChange listeners with the full series on each record", () => {
    const seen: number[] = [];
    store.onChange((days) => seen.push(days.length));
    store.record({ timestampMs: DAY1, model: "m", usage: { inputTokens: 1 } });
    store.record({ timestampMs: DAY2, model: "m", usage: { inputTokens: 1 } });
    expect(seen).toEqual([1, 2]);
  });

  it("lifetime = baseline + all days, and survives (does not depend on) agent state", () => {
    // Seed a baseline (as bootstrap does from existing agents).
    store.seedBaselineIfEmpty(
      buildLifetimeBaseline([
        {
          usageTotals: {
            inputTokens: 1000,
            cachedInputTokens: 0,
            outputTokens: 200,
            totalCostUsd: 0.5,
            turns: 4,
          },
          model: "opus-5",
        },
      ]),
    );
    store.record({
      timestampMs: DAY1,
      model: "opus-5",
      usage: { inputTokens: 100, outputTokens: 20, totalCostUsd: 0.05 },
    });

    const lifetime = store.lifetime();
    expect(lifetime.inputTokens).toBe(1100);
    expect(lifetime.outputTokens).toBe(220);
    expect(lifetime.totalCostUsd).toBeCloseTo(0.55);
    expect(lifetime.byModel["opus-5"].inputTokens).toBe(1100);
  });

  it("seedBaselineIfEmpty is a one-time no-op after the first seed (no double count on restart)", () => {
    store.seedBaselineIfEmpty(
      buildLifetimeBaseline([
        {
          usageTotals: {
            inputTokens: 500,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 0.1,
            turns: 1,
          },
          model: "m",
        },
      ]),
    );
    // A later restart would try to seed again from current agents — must be ignored.
    store.seedBaselineIfEmpty(
      buildLifetimeBaseline([
        {
          usageTotals: {
            inputTokens: 9999,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalCostUsd: 9,
            turns: 1,
          },
          model: "m",
        },
      ]),
    );
    expect(store.lifetime().inputTokens).toBe(500);
  });
});

describe("buildLifetimeBaseline", () => {
  it("sums usage totals across agents with a per-model breakdown, skipping agents with no usage", () => {
    const baseline = buildLifetimeBaseline([
      {
        usageTotals: {
          inputTokens: 100,
          cachedInputTokens: 10,
          outputTokens: 20,
          totalCostUsd: 0.01,
          turns: 2,
        },
        model: "opus-5",
      },
      {
        usageTotals: {
          inputTokens: 50,
          cachedInputTokens: 0,
          outputTokens: 5,
          totalCostUsd: 0.005,
          turns: 1,
        },
        model: "opus-5",
      },
      {
        usageTotals: {
          inputTokens: 7,
          cachedInputTokens: 0,
          outputTokens: 1,
          totalCostUsd: 0.001,
          turns: 1,
        },
        model: "gpt-5.6",
      },
      { usageTotals: null, model: "gpt-5.6" },
    ]);
    expect(baseline.inputTokens).toBe(157);
    expect(baseline.turns).toBe(4);
    expect(baseline.byModel["opus-5"].inputTokens).toBe(150);
    expect(baseline.byModel["gpt-5.6"].inputTokens).toBe(7);
  });
});
