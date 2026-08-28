import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageHistoryStorage } from "./usage-history-storage.js";

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
});
