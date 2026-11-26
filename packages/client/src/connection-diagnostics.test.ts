import { describe, expect, test, vi } from "vitest";
import {
  ConnectionDiagnosticsLog,
  formatConnectionDiagnosticEntry,
} from "./connection-diagnostics.js";

describe("connection diagnostics log", () => {
  test("keeps the newest entries up to its capacity", () => {
    let now = 0;
    const log = new ConnectionDiagnosticsLog(3, () => ++now);
    for (const event of ["a", "b", "c", "d"]) log.record("relay#1", event);
    expect(log.entries().map((entry) => entry.event)).toEqual(["b", "c", "d"]);
  });

  test("records only primitive field values and truncates long strings", () => {
    const log = new ConnectionDiagnosticsLog(10, () => 0);
    log.record("relay#1", "frame", {
      bytes: 12,
      ok: true,
      none: null,
      skipped: undefined,
      payload: { nonce: "secret" },
      list: ["secret"],
      error: new Error("boom"),
      long: "x".repeat(1_000),
    });
    const [entry] = log.entries();
    expect(entry!.fields).toEqual({
      bytes: 12,
      ok: true,
      none: null,
      payload: "[object]",
      list: "[array]",
      error: "boom",
      long: expect.stringMatching(/^x{299}…$/),
    });
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  test("formats one line per entry and notifies subscribers, including on clear", () => {
    const log = new ConnectionDiagnosticsLog(10, () => Date.UTC(2026, 10, 26, 12, 0, 0));
    const listener = vi.fn();
    const unsubscribe = log.subscribe(listener);
    log.record("relay#2", "ws_close", { code: 1001, reason: "gone" });
    expect(log.format()).toBe('2026-11-26T12:00:00.000Z relay#2 ws_close code=1001 reason="gone"');
    expect(formatConnectionDiagnosticEntry(log.entries()[0]!)).toBe(log.format());
    const version = log.getVersion();
    log.clear();
    expect(log.entries()).toEqual([]);
    expect(log.getVersion()).toBeGreaterThan(version);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    log.record("relay#2", "ignored");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("a throwing subscriber does not break recording", () => {
    const log = new ConnectionDiagnosticsLog(10, () => 0);
    log.subscribe(() => {
      throw new Error("listener failed");
    });
    expect(() => log.record("relay#1", "event")).not.toThrow();
    expect(log.entries()).toHaveLength(1);
  });
});
