import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureHydrated,
  getSnapshot,
  getStatus,
  refreshTailscaleStatus,
  resetForTests,
  subscribe,
} from "./store";

// The store hydrates from getTailscaleLoginAdapter(); mock the module so each
// test controls whether the adapter is supported and what status it reports.
const { fakeAdapter } = vi.hoisted(() => ({
  fakeAdapter: {
    isSupported: true,
    getStatus: vi.fn(),
  },
}));

vi.mock("./adapter", () => ({
  getTailscaleLoginAdapter: () => fakeAdapter,
}));

describe("tailscale login store", () => {
  beforeEach(() => {
    fakeAdapter.isSupported = true;
    fakeAdapter.getStatus.mockReset();
    resetForTests();
  });

  afterEach(() => {
    resetForTests();
  });

  it("starts unknown", () => {
    expect(getSnapshot()).toEqual({ kind: "unknown" });
  });

  it("hydrates to unavailable when the adapter is unsupported", async () => {
    fakeAdapter.isSupported = false;

    await ensureHydrated();

    expect(getStatus()).toEqual({ kind: "unavailable" });
    expect(fakeAdapter.getStatus).not.toHaveBeenCalled();
  });

  it("hydrates to needs-login from a needs-login adapter", async () => {
    fakeAdapter.getStatus.mockResolvedValue({ kind: "needs-login" });

    await ensureHydrated();

    expect(getStatus()).toEqual({ kind: "needs-login" });
  });

  it("hydrates to connected from a connected adapter", async () => {
    fakeAdapter.getStatus.mockResolvedValue({ kind: "connected" });

    await ensureHydrated();

    expect(getStatus()).toEqual({ kind: "connected" });
  });

  it("fails closed to unavailable when the adapter getStatus rejects", async () => {
    fakeAdapter.getStatus.mockRejectedValue(new Error("module exploded"));

    await ensureHydrated();

    expect(getStatus()).toEqual({ kind: "unavailable" });
  });

  it("ensureHydrated is idempotent while in flight and after settling", async () => {
    fakeAdapter.getStatus.mockResolvedValue({ kind: "connected" });

    const first = ensureHydrated();
    const second = ensureHydrated();
    await Promise.all([first, second]);
    await ensureHydrated();

    expect(fakeAdapter.getStatus).toHaveBeenCalledTimes(1);
    expect(getStatus()).toEqual({ kind: "connected" });
  });

  it("notifies subscribers when hydration lands", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    fakeAdapter.getStatus.mockResolvedValue({ kind: "connected" });

    await ensureHydrated();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getStatus()).toEqual({ kind: "connected" });

    unsubscribe();
  });

  it("coalesces concurrent refreshes into one native status read", async () => {
    let resolveStatus!: (value: { kind: "connected" }) => void;
    fakeAdapter.getStatus.mockReturnValue(
      new Promise<{ kind: "connected" }>((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const first = refreshTailscaleStatus();
    const second = refreshTailscaleStatus();

    expect(fakeAdapter.getStatus).toHaveBeenCalledTimes(1);
    resolveStatus({ kind: "connected" });
    await Promise.all([first, second]);
    expect(getSnapshot()).toEqual({ kind: "connected" });
  });

  it("resetForTests resets to unknown and clears the hydration cache", async () => {
    fakeAdapter.getStatus.mockResolvedValue({ kind: "connected" });
    await ensureHydrated();
    expect(getStatus()).toEqual({ kind: "connected" });

    resetForTests();

    // getSnapshot (not getStatus) so the reset isn't followed by a background
    // hydration that re-reads the adapter before the new value is set.
    expect(getSnapshot()).toEqual({ kind: "unknown" });

    // The hydration cache is cleared, so a later ensureHydrated re-reads the
    // adapter instead of reusing the old result.
    fakeAdapter.getStatus.mockResolvedValue({ kind: "needs-login" });
    await ensureHydrated();

    expect(fakeAdapter.getStatus).toHaveBeenCalledTimes(2);
    expect(getStatus()).toEqual({ kind: "needs-login" });
  });
});
