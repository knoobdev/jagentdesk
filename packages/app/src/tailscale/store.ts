import { useEffect, useSyncExternalStore } from "react";
import { getTailscaleLoginAdapter } from "./adapter";
import type { TailscaleLoginStatus } from "./types";

// Tailscale login gate store.
//
// Caches the adapter-reported login status in memory only. Nothing is
// persisted here — in particular the auth key never reaches this module: the
// adapter holds it in memory for the duration of the join call and drops it.
//
// The status is unknown until hydration lands, so the app never has to block
// startup on the native module round-trip.

type Listener = () => void;

let status: TailscaleLoginStatus = { kind: "unknown" };
let listeners = new Set<Listener>();
let hydrationPromise: Promise<void> | null = null;
let statusReadInFlight: Promise<void> | null = null;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setStatus(next: TailscaleLoginStatus): void {
  status = next;
  notify();
}

async function refreshStatus(): Promise<void> {
  try {
    const adapter = getTailscaleLoginAdapter();
    if (!adapter.isSupported) {
      setStatus({ kind: "unavailable" });
      return;
    }
    setStatus(await adapter.getStatus());
  } catch {
    // Fail closed: if the adapter cannot report, the device must not proceed to
    // pairing without proving it is on the tailnet.
    setStatus({ kind: "unavailable" });
  }
}

function readStatusOnce(): Promise<void> {
  if (!statusReadInFlight) {
    statusReadInFlight = refreshStatus().finally(() => {
      statusReadInFlight = null;
    });
  }
  return statusReadInFlight;
}

export function refreshTailscaleStatus(): Promise<void> {
  hydrationPromise = null;
  return readStatusOnce();
}

/** Kicks off the one-time adapter status read. Idempotent. */
export function ensureHydrated(): Promise<void> {
  if (!hydrationPromise) {
    hydrationPromise = readStatusOnce();
  }
  return hydrationPromise;
}

/** Synchronous snapshot; the first call starts hydration in the background. */
export function getStatus(): TailscaleLoginStatus {
  void ensureHydrated();
  return status;
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): TailscaleLoginStatus {
  return status;
}

/** Test-only: clears the in-memory status and the hydration cache. */
export function resetForTests(): void {
  hydrationPromise = null;
  statusReadInFlight = null;
  setStatus({ kind: "unknown" });
}

export function useTailscaleLoginStatus(): TailscaleLoginStatus {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void ensureHydrated();
  }, []);
  return current;
}
