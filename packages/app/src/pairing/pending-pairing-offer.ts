import AsyncStorage from "@react-native-async-storage/async-storage";

export interface PendingPairingOffer {
  offerUrl: string;
  source: "onboarding" | "settings";
}

const PENDING_PAIRING_OFFER_KEY = "@jagentdesk:pending-pairing-offer:v1";

function normalizeSource(value: unknown): PendingPairingOffer["source"] {
  return value === "onboarding" ? "onboarding" : "settings";
}

export async function savePendingPairingOffer(input: {
  offerUrl: string;
  source?: string;
}): Promise<void> {
  await AsyncStorage.setItem(
    PENDING_PAIRING_OFFER_KEY,
    JSON.stringify({
      offerUrl: input.offerUrl,
      source: normalizeSource(input.source),
    }),
  );
}

export async function loadPendingPairingOffer(): Promise<PendingPairingOffer | null> {
  const raw = await AsyncStorage.getItem(PENDING_PAIRING_OFFER_KEY);
  if (!raw) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") {
      return null;
    }
    const record = value as { offerUrl?: unknown; source?: unknown };
    if (typeof record.offerUrl !== "string" || !record.offerUrl.includes("#offer=")) {
      return null;
    }
    return {
      offerUrl: record.offerUrl,
      source: normalizeSource(record.source),
    };
  } catch {
    return null;
  }
}

export async function clearPendingPairingOffer(): Promise<void> {
  await AsyncStorage.removeItem(PENDING_PAIRING_OFFER_KEY);
}
