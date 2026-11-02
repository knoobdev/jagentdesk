import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ForwardingRule, ForwardingState } from "@jagentdesk/protocol/ssh/forwarding-schemas";
import type { ForwardingApi } from "./api";
import { applyForwardState } from "./model";

export interface ForwardingStoreState {
  status: "loading" | "ready" | "error";
  rules: ForwardingRule[];
  states: Record<string, ForwardingState>;
  error: string | null;
}

export interface ForwardingStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): ForwardingStoreState;
  /** Subscribes to ssh.forward.state, then loads rules; returns the teardown. */
  start(): () => void;
  reload(): Promise<void>;
  putRule(rule: ForwardingRule): void;
  dropRule(ruleId: string): void;
  putState(state: ForwardingState): void;
}

// Rules plus live states as every client sees them (spec 25.6: states broadcast to all clients).
export function createForwardingStore(api: ForwardingApi): ForwardingStore {
  let snapshot: ForwardingStoreState = { status: "loading", rules: [], states: {}, error: null };
  const listeners = new Set<() => void>();
  let active = false;

  function set(next: ForwardingStoreState): void {
    snapshot = next;
    for (const listener of listeners) listener();
  }

  async function reload(): Promise<void> {
    try {
      const listing = await api.list();
      if (!active) return;
      const states = listing.states.reduce(applyForwardState, snapshot.states);
      set({ status: "ready", rules: listing.rules, states, error: null });
    } catch (error) {
      if (!active) return;
      set({
        ...snapshot,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    start() {
      active = true;
      const unsubscribe = api.subscribeStates((state) => {
        set({ ...snapshot, states: applyForwardState(snapshot.states, state) });
      });
      void reload();
      return () => {
        active = false;
        unsubscribe();
      };
    },
    reload,
    putRule(rule) {
      const exists = snapshot.rules.some((item) => item.id === rule.id);
      const rules = exists
        ? snapshot.rules.map((item) => (item.id === rule.id ? rule : item))
        : [...snapshot.rules, rule];
      set({ ...snapshot, rules });
    },
    dropRule(ruleId) {
      const { [ruleId]: _dropped, ...states } = snapshot.states;
      set({ ...snapshot, rules: snapshot.rules.filter((rule) => rule.id !== ruleId), states });
    },
    putState(state) {
      set({ ...snapshot, states: applyForwardState(snapshot.states, state) });
    },
  };
}

export function useForwardingStore(api: ForwardingApi): {
  store: ForwardingStore;
  state: ForwardingStoreState;
} {
  const store = useMemo(() => createForwardingStore(api), [api]);
  useEffect(() => store.start(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, state };
}
