import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useSyncExternalStore } from "react";

export type ConnectionMode = "tailscale" | "local";

// Bump the marker after the first broken desktop build so stale success from
// the old fake status implementation can never bypass the real login gate.
const CONNECTION_MODE_KEY = "@jagentdesk:connection-mode:v3";

type Listener = () => void;
interface ConnectionModeSnapshot {
  mode: ConnectionMode | null;
  loaded: boolean;
}

let snapshot: ConnectionModeSnapshot = { mode: null, loaded: false };
const listeners = new Set<Listener>();
let readInFlight: Promise<void> | null = null;
let storageQueue: Promise<void> = Promise.resolve();

function notify(): void {
  for (const listener of listeners) listener();
}

function updateSnapshot(next: ConnectionModeSnapshot): void {
  if (snapshot.mode === next.mode && snapshot.loaded === next.loaded) return;
  snapshot = next;
  notify();
}

function enqueueStorageOperation(operation: () => Promise<void>): Promise<void> {
  const next = storageQueue.then(operation);
  storageQueue = next.catch(() => undefined);
  return next;
}

function readConnectionModeOnce(): Promise<void> {
  if (!readInFlight) {
    readInFlight = enqueueStorageOperation(async () => {
      try {
        const value = await AsyncStorage.getItem(CONNECTION_MODE_KEY);
        const mode = value === "tailscale" || value === "local" ? value : null;
        updateSnapshot({ mode, loaded: true });
      } catch {
        updateSnapshot({ mode: null, loaded: true });
      }
    }).finally(() => {
      readInFlight = null;
    });
  }
  return readInFlight;
}

export async function getConnectionMode(): Promise<ConnectionMode | null> {
  await readConnectionModeOnce();
  return snapshot.mode;
}

export async function setConnectionMode(mode: ConnectionMode): Promise<void> {
  await enqueueStorageOperation(async () => {
    try {
      await AsyncStorage.setItem(CONNECTION_MODE_KEY, mode);
      updateSnapshot({ mode, loaded: true });
    } catch (error) {
      // A failed first write must not leave every route waiting on `loaded`.
      updateSnapshot({ mode: snapshot.mode, loaded: true });
      throw error;
    }
  });
}

export async function clearConnectionMode(): Promise<void> {
  await enqueueStorageOperation(async () => {
    try {
      await AsyncStorage.removeItem(CONNECTION_MODE_KEY);
      updateSnapshot({ mode: null, loaded: true });
    } catch (error) {
      updateSnapshot({ mode: snapshot.mode, loaded: true });
      throw error;
    }
  });
}

export function useConnectionMode(): { mode: ConnectionMode | null; loaded: boolean } {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void readConnectionModeOnce();
  }, []);
  return current;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ConnectionModeSnapshot {
  return snapshot;
}
