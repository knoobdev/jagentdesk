import pino from "pino";
import { expect, test } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { UsageSession } from "./usage-session.js";

test("lists reports from usage sources", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const requested: Array<{ forceRefresh?: boolean; reportIds?: string[] }> = [];
  const entry = {
    id: "fixture:one",
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: "fixture",
    sourceLabel: "Fixture",
    report: { status: "available" as const, windows: [] },
  };
  const usage = new UsageSession({
    isEnabled: () => true,
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports(options) {
        requested.push({ forceRefresh: options.forceRefresh, reportIds: options.reportIds });
        return [entry];
      },
      async listLegacyUsage() {
        return { fetchedAt: "2026-01-01T00:00:00.000Z", providers: [] };
      },
    },
    logger: pino({ level: "silent" }),
  });

  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "list" });
  expect(requested).toEqual([{ forceRefresh: undefined, reportIds: undefined }]);
  expect(emitted).toEqual([
    {
      type: "usage.list_reports.response",
      payload: { requestId: "list", reports: [entry], error: null },
    },
  ]);
});

test("surfaces a legacy usage-list failure as an rpc_error envelope", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    isEnabled: () => true,
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports() {
        return [];
      },
      async listLegacyUsage(): Promise<never> {
        throw new Error("quota service down");
      },
    },
    logger: pino({ level: "silent" }),
  });
  await usage.handleLegacyList({ type: "provider.usage.list.request", requestId: "u1" });
  expect(emitted[0]).toMatchObject({
    type: "rpc_error",
    payload: { requestId: "u1", code: "provider_usage_list_failed" },
  });
});

test("streams only to callers that opt in while keeping complete legacy responses", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const entry = {
    id: "source:account",
    account: {},
    fetchedAt: "2026-11-25T00:00:00Z",
    sourceId: "source",
    sourceLabel: "Source",
    report: { status: "available" as const, windows: [] },
  };
  const usage = new UsageSession({
    isEnabled: () => true,
    emit: (message) => emitted.push(message),
    logger: pino({ level: "silent" }),
    runtime: {
      async listUsageReports(options) {
        options.onReport?.(entry);
        return [entry];
      },
      async listLegacyUsage() {
        return { fetchedAt: entry.fetchedAt, providers: [] };
      },
    },
  });
  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "old" });
  await usage.handleListReports({
    type: "usage.list_reports.request",
    requestId: "new",
    stream: true,
  });
  expect(emitted).toEqual([
    {
      type: "usage.list_reports.response",
      payload: { requestId: "old", reports: [entry], error: null },
    },
    { type: "usage.list_reports.update", payload: { requestId: "new", report: entry } },
    {
      type: "usage.list_reports.response",
      payload: { requestId: "new", reports: [entry], error: null },
    },
  ]);
});
