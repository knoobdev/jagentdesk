import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn(async (key: string) => values.get(key) ?? null),
    setItem: vi.fn(async (key: string, next: string) => {
      values.set(key, next);
    }),
    removeItem: vi.fn(async (key: string) => {
      values.delete(key);
    }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage }));

import {
  clearTailnetMode,
  getTailnetMode,
  migrateLegacyConnectionMode,
  setTailnetMode,
  setTailnetModeIfUnset,
  subscribe,
} from "./tailnet-mode";

const KEY = "@jagentdesk:tailnet-mode:v1";
const LEGACY_KEY = "@jagentdesk:connection-mode:v4";

describe("tailnet mode store", () => {
  beforeEach(async () => {
    storage.values.clear();
    await clearTailnetMode();
    storage.getItem.mockClear();
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists and publishes a selected mode", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    await setTailnetMode("tailnet");

    expect(storage.values.get(KEY)).toBe("tailnet");
    expect(await getTailnetMode()).toBe("tailnet");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("serializes a read before a concurrent write", async () => {
    let releaseRead!: (value: string | null) => void;
    storage.getItem.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (releaseRead = resolve)),
    );

    const read = getTailnetMode();
    const write = setTailnetMode("tailnet");

    await Promise.resolve();
    expect(storage.setItem).not.toHaveBeenCalled();
    releaseRead("off");
    await Promise.all([read, write]);

    expect(await getTailnetMode()).toBe("tailnet");
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("finishes loading when the first write fails", async () => {
    storage.setItem.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(setTailnetMode("tailnet")).rejects.toThrow("storage unavailable");
    expect(await getTailnetMode()).toBeNull();
  });

  it("clears the persisted mode", async () => {
    await setTailnetMode("off");
    await clearTailnetMode();

    expect(storage.values.has(KEY)).toBe(false);
    expect(await getTailnetMode()).toBeNull();
  });

  it("keeps an existing tailnet sign-in when a relay pairing records its mode", async () => {
    await setTailnetMode("tailnet");
    await setTailnetModeIfUnset("off");
    expect(await getTailnetMode()).toBe("tailnet");
  });

  it("records the first mode when nothing is stored", async () => {
    await setTailnetModeIfUnset("off");
    expect(await getTailnetMode()).toBe("off");
  });
});

describe("legacy Connect type migration", () => {
  it("maps Tailscale to tailnet and Local to off", () => {
    expect(migrateLegacyConnectionMode("tailscale")).toBe("tailnet");
    expect(migrateLegacyConnectionMode("local")).toBe("off");
    expect(migrateLegacyConnectionMode("bogus")).toBeNull();
    expect(migrateLegacyConnectionMode(null)).toBeNull();
  });

  it("moves a stored v0.10.0 choice to the new key on first read", async () => {
    vi.resetModules();
    storage.values.clear();
    storage.values.set(LEGACY_KEY, "local");
    const fresh = await import("./tailnet-mode");

    expect(await fresh.getTailnetMode()).toBe("off");
    expect(storage.values.get(KEY)).toBe("off");
    expect(storage.values.has(LEGACY_KEY)).toBe(false);
  });

  it("moves a stored Tailscale choice to tailnet", async () => {
    vi.resetModules();
    storage.values.clear();
    storage.values.set(LEGACY_KEY, "tailscale");
    const fresh = await import("./tailnet-mode");

    expect(await fresh.getTailnetMode()).toBe("tailnet");
    expect(storage.values.get(KEY)).toBe("tailnet");
  });
});
