import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";

/**
 * Whether this device uses the tailnet (ADR-0056).
 *
 * - `"tailnet"`: the user signed in to Tailscale here. Desktop runs the
 *   bundled daemon with its tsnet bridge; every saved connection is dialed.
 * - `"off"`: no Tailscale sign-in. Desktop runs the bundled daemon without
 *   tsnet (relay still pairs devices); a phone reaches hosts over relay.
 * - `null`: nothing recorded yet. A phone without hosts shows onboarding and
 *   dials relay connections only; the desktop behaves as `"off"`.
 *
 * This is internal state. Onboarding never asks the user to pick it.
 */
export type TailnetMode = "tailnet" | "off";

const TAILNET_MODE_KEY = "@jagentdesk:tailnet-mode:v1";
// COMPAT(connection-mode-v4): added in v0.10.1, remove after 2027-06-01.
// Installs up to v0.10.0 stored the "Connect type" choice here.
const LEGACY_CONNECTION_MODE_KEY = "@jagentdesk:connection-mode:v4";

type Listener = () => void;
interface TailnetModeSnapshot {
  mode: TailnetMode | null;
  loaded: boolean;
}

let snapshot: TailnetModeSnapshot = { mode: null, loaded: false };
const listeners = new Set<Listener>();
let readInFlight: Promise<void> | null = null;
let storageQueue: Promise<void> = Promise.resolve();

function notify(): void {
  for (const listener of listeners) listener();
}

function updateSnapshot(next: TailnetModeSnapshot): void {
  if (snapshot.mode === next.mode && snapshot.loaded === next.loaded) return;
  snapshot = next;
  notify();
}

function enqueueStorageOperation(operation: () => Promise<void>): Promise<void> {
  const next = storageQueue.then(operation);
  storageQueue = next.catch(() => undefined);
  return next;
}

function parseTailnetMode(value: string | null): TailnetMode | null {
  return value === "tailnet" || value === "off" ? value : null;
}

/** Maps the v0.10.0 "Connect type" value: Tailscale kept its tailnet, Local had none. */
export function migrateLegacyConnectionMode(value: string | null): TailnetMode | null {
  if (value === "tailscale") return "tailnet";
  if (value === "local") return "off";
  return null;
}

async function readStoredTailnetMode(): Promise<TailnetMode | null> {
  const stored = parseTailnetMode(await AsyncStorage.getItem(TAILNET_MODE_KEY));
  if (stored) return stored;
  const legacy = await AsyncStorage.getItem(LEGACY_CONNECTION_MODE_KEY);
  if (legacy === null) return null;
  const migrated = migrateLegacyConnectionMode(legacy);
  if (migrated) await AsyncStorage.setItem(TAILNET_MODE_KEY, migrated);
  await AsyncStorage.removeItem(LEGACY_CONNECTION_MODE_KEY);
  return migrated;
}

function readTailnetModeOnce(): Promise<void> {
  if (!readInFlight) {
    readInFlight = enqueueStorageOperation(async () => {
      try {
        updateSnapshot({ mode: await readStoredTailnetMode(), loaded: true });
      } catch {
        updateSnapshot({ mode: null, loaded: true });
      }
    }).finally(() => {
      readInFlight = null;
    });
  }
  return readInFlight;
}

export async function getTailnetMode(): Promise<TailnetMode | null> {
  await readTailnetModeOnce();
  return snapshot.mode;
}

export async function setTailnetMode(mode: TailnetMode): Promise<void> {
  await enqueueStorageOperation(async () => {
    try {
      await AsyncStorage.setItem(TAILNET_MODE_KEY, mode);
      updateSnapshot({ mode, loaded: true });
    } catch (error) {
      // A failed first write must not leave every route waiting on `loaded`.
      updateSnapshot({ mode: snapshot.mode, loaded: true });
      throw error;
    }
  });
}

/** Records `mode` only when nothing is recorded yet; an existing tailnet sign-in is kept. */
export async function setTailnetModeIfUnset(mode: TailnetMode): Promise<void> {
  if ((await getTailnetMode()) !== null) return;
  await setTailnetMode(mode);
}

export async function clearTailnetMode(): Promise<void> {
  await enqueueStorageOperation(async () => {
    try {
      await AsyncStorage.removeItem(TAILNET_MODE_KEY);
      updateSnapshot({ mode: null, loaded: true });
    } catch (error) {
      updateSnapshot({ mode: snapshot.mode, loaded: true });
      throw error;
    }
  });
}

export function useTailnetMode(): { mode: TailnetMode | null; loaded: boolean } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void readTailnetModeOnce();
  }, []);
  return current;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): TailnetModeSnapshot {
  return snapshot;
}
