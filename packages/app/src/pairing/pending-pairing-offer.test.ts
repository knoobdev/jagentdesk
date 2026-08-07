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
  clearPendingPairingOffer,
  loadPendingPairingOffer,
  savePendingPairingOffer,
} from "./pending-pairing-offer";

const OFFER_URL = "jagentdesk://app/#offer=abc";

describe("pending pairing offer store", () => {
  beforeEach(async () => {
    storage.value = null;
    storage.getItem.mockClear();
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
    await clearPendingPairingOffer();
    storage.getItem.mockClear();
    storage.setItem.mockClear();
    storage.removeItem.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists an offer that must survive the Tailscale login route", async () => {
    await savePendingPairingOffer({ offerUrl: OFFER_URL, source: "onboarding" });

    expect(storage.value).toBe(JSON.stringify({ offerUrl: OFFER_URL, source: "onboarding" }));
    expect(await loadPendingPairingOffer()).toEqual({
      offerUrl: OFFER_URL,
      source: "onboarding",
    });
  });

  it("normalizes a missing source to settings", async () => {
    await savePendingPairingOffer({ offerUrl: OFFER_URL });

    expect(await loadPendingPairingOffer()).toEqual({
      offerUrl: OFFER_URL,
      source: "settings",
    });
  });

  it("returns null when nothing is stored", async () => {
    expect(await loadPendingPairingOffer()).toBeNull();
  });

  it("rejects payloads without the #offer= fragment", async () => {
    storage.value = JSON.stringify({ offerUrl: "jagentdesk://app/plain", source: "settings" });

    expect(await loadPendingPairingOffer()).toBeNull();
  });

  it("rejects malformed JSON", async () => {
    storage.value = "{not json";

    expect(await loadPendingPairingOffer()).toBeNull();
  });

  it("clears the persisted offer after a successful pair", async () => {
    await savePendingPairingOffer({ offerUrl: OFFER_URL, source: "onboarding" });
    await clearPendingPairingOffer();

    expect(await loadPendingPairingOffer()).toBeNull();
  });
});
