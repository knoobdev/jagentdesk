/** @vitest-environment jsdom */
import { createElement, type ReactNode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableDaemonConfig } from "@jagentdesk/protocol/messages";
import { useSessionStore } from "@/stores/session-store";
import { useHostUsage, useUsageHostReports } from "./queries";
import { usageReportsQueryKey } from "./query-keys";
import type { UsageReportEntry } from "./types";

const state = vi.hoisted(() => ({
  connected: true,
  config: null as unknown,
  listUsageReports: vi.fn(),
}));

const client = {
  listUsageReports: state.listUsageReports,
  on: () => () => undefined,
};

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getClient: () => client }),
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => state.connected,
  useHostRuntimeConnectionStatuses: () => new Map(),
  useHosts: () => [],
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: state.config,
    isLoading: state.config === null,
    patchConfig: async () => undefined,
  }),
}));

const HOST = "host";

function report(percent: number, fetchedAt: string): UsageReportEntry {
  return {
    id: "claude:account-1",
    account: {},
    fetchedAt,
    sourceId: "claude",
    sourceLabel: "Claude",
    report: {
      status: "available",
      windows: [{ id: "weekly", label: "Weekly", usedPct: percent }],
    },
  };
}

const shown = [report(33, "2026-11-27T00:00:00.000Z")];
const fresh = [report(34, "2026-11-27T00:05:00.000Z")];

function usageConfig(enabled: boolean): MutableDaemonConfig {
  return { usage: { enabled } } as MutableDaemonConfig;
}

let queryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

function renderReports(initial: { active: boolean }) {
  return renderHook(
    ({ active }: { active: boolean }) => useUsageHostReports({ serverId: HOST, active }),
    { wrapper: Wrapper, initialProps: initial },
  );
}

/** Cached reports from a fetch long enough ago that the next mount refetches them. */
function seedShownReports() {
  queryClient.setQueryData(usageReportsQueryKey(HOST), shown, { updatedAt: 1 });
}

beforeEach(() => {
  state.connected = true;
  state.config = usageConfig(true);
  state.listUsageReports.mockReset();
  queryClient = new QueryClient();
  useSessionStore.getState().initializeSession(HOST, null);
  useSessionStore.getState().updateSessionServerInfo(HOST, {
    serverId: HOST,
    hostname: null,
    version: null,
    features: { usageSources: true, usageSetting: true },
  } as Parameters<ReturnType<typeof useSessionStore.getState>["updateSessionServerInfo"]>[1]);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useSessionStore.getState().clearSession(HOST);
});

describe("useUsageHostReports", () => {
  it("keeps the shown reports while the daemon config reloads", () => {
    state.config = null;
    state.listUsageReports.mockReturnValue(new Promise(() => undefined));
    seedShownReports();

    const { result } = renderReports({ active: true });

    expect(result.current).toEqual(shown);
  });

  it("keeps the shown reports while the host reconnects, without asking it", () => {
    state.connected = false;
    seedShownReports();

    const { result } = renderReports({ active: true });

    expect(result.current).toEqual(shown);
    expect(state.listUsageReports).not.toHaveBeenCalled();
  });

  it("refetches once the host is back and replaces the shown reports", async () => {
    state.connected = false;
    state.listUsageReports.mockResolvedValue({ reports: fresh });
    seedShownReports();
    const { result, rerender } = renderReports({ active: true });
    expect(result.current).toEqual(shown);

    state.connected = true;
    rerender({ active: true });

    await waitFor(() => expect(result.current).toEqual(fresh));
  });

  it("keeps the shown reports through a failed refetch and retries promptly", async () => {
    state.listUsageReports
      .mockRejectedValueOnce(new Error("Host disconnected"))
      .mockResolvedValue({ reports: fresh });
    seedShownReports();

    const { result } = renderReports({ active: true });

    await waitFor(() => expect(state.listUsageReports).toHaveBeenCalledTimes(1));
    expect(result.current.map((entry) => entry.id)).toEqual(shown.map((entry) => entry.id));
    expect(result.current[0]?.report).toEqual(shown[0]?.report);
    await waitFor(() => expect(result.current).toEqual(fresh), { timeout: 3_000 });
    expect(state.listUsageReports).toHaveBeenCalledTimes(2);
  });

  it("keeps the shown reports while a restarted host's usage sources start", async () => {
    // A restarted daemon answers before its usage-source plugins have registered.
    state.listUsageReports.mockResolvedValueOnce({ reports: [] }).mockResolvedValue({
      reports: fresh,
    });
    seedShownReports();
    const seen: UsageReportEntry[][] = [];

    const { result } = renderHook(
      () => {
        const reports = useUsageHostReports({ serverId: HOST, active: true });
        seen.push(reports);
        return reports;
      },
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(result.current).toEqual(fresh), { timeout: 3_000 });
    expect(seen.some((reports) => reports.length === 0)).toBe(false);
  });

  it("drops reports the host no longer lists once its retries agree", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      state.listUsageReports.mockResolvedValue({ reports: [] });
      seedShownReports();

      const { result } = renderReports({ active: true });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      expect(result.current).toEqual(shown);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(result.current).toEqual([]);
      expect(state.listUsageReports).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the shown reports while the summary is off screen, without polling", () => {
    seedShownReports();

    const { result } = renderReports({ active: false });

    expect(result.current).toEqual(shown);
    expect(state.listUsageReports).not.toHaveBeenCalled();
  });

  it("hides the reports and stops asking once usage is turned off", () => {
    state.config = usageConfig(false);
    seedShownReports();

    const { result } = renderReports({ active: true });

    expect(result.current).toEqual([]);
    expect(state.listUsageReports).not.toHaveBeenCalled();
  });
});

describe("useHostUsage", () => {
  it("settles an explicit refresh at once, even when it drops reports", async () => {
    // Disconnected, so the settings view itself does not fetch; only the refresh asks.
    state.connected = false;
    state.listUsageReports.mockResolvedValue({ reports: [] });
    seedShownReports();
    const { result } = renderHook(() => useHostUsage(HOST), { wrapper: Wrapper });

    act(() => result.current.refresh());

    await waitFor(() => expect(queryClient.getQueryData(usageReportsQueryKey(HOST))).toEqual([]));
    expect(state.listUsageReports).toHaveBeenCalledTimes(1);
  });
});
