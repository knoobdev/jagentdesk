import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => {
  let value: string | null = null;
  return {
    get value() {
      return value;
    },
    set value(next: string | null) {
      value = next;
    },
    getItem: vi.fn(async () => value),
    setItem: vi.fn(async (_key: string, next: string) => {
      value = next;
    }),
    removeItem: vi.fn(async () => {
      value = null;
    }),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({ default: storage }));

import {
  clearConnectionMode,
  getConnectionMode,
  setConnectionMode,
  subscribe,
} from "./connection-mode";

describe("connection mode store", () => {
  beforeEach(async () => {
    storage.value = null;
    storage.getItem.mockClear();
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
    await clearConnectionMode();
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

    await setConnectionMode("tailscale");

    expect(storage.value).toBe("tailscale");
    expect(await getConnectionMode()).toBe("tailscale");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("serializes a read before a concurrent write", async () => {
    let releaseRead!: (value: string | null) => void;
    storage.getItem.mockImplementationOnce(
      () => new Promise<string | null>((resolve) => (releaseRead = resolve)),
    );

    const read = getConnectionMode();
    const write = setConnectionMode("tailscale");

    await Promise.resolve();
    expect(storage.setItem).not.toHaveBeenCalled();
    releaseRead("local");
    await Promise.all([read, write]);

    expect(await getConnectionMode()).toBe("tailscale");
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("finishes loading when the first write fails", async () => {
    storage.setItem.mockRejectedValueOnce(new Error("storage unavailable"));

    await expect(setConnectionMode("tailscale")).rejects.toThrow("storage unavailable");
    expect(await getConnectionMode()).toBeNull();
  });

  it("clears the persisted mode", async () => {
    await setConnectionMode("local");
    await clearConnectionMode();

    expect(storage.value).toBeNull();
    expect(await getConnectionMode()).toBeNull();
  });
});
