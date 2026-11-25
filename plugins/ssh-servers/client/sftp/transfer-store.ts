import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SshTransfer } from "@jagentdesk/protocol/ssh/sftp-schemas";
import type { SftpApi } from "./api";
import { applyTransfer, removeTransfer, type TransferListState } from "./model";

export interface TransferStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): TransferListState;
  /** Subscribes to ssh.transfer.progress, then loads the queue; returns the teardown. */
  start(): () => void;
  forget(transferId: string): void;
  /** Applies a transfer returned by an RPC, ahead of its progress push. */
  apply(transfer: SshTransfer): void;
}

// The transfer queue as the daemon reports it: one list fetch plus every progress push, so all
// devices watching the queue converge on the same state.
export function createTransferStore(api: SftpApi): TransferStore {
  let state: TransferListState = { status: "loading", transfers: [], error: null };
  const listeners = new Set<() => void>();

  function set(next: TransferListState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  async function load(isActive: () => boolean): Promise<void> {
    let loaded: SshTransfer[];
    try {
      loaded = await api.listTransfers();
    } catch (error) {
      if (!isActive()) return;
      set({
        ...state,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!isActive()) return;
    const merged = state.transfers.reduce<SshTransfer[]>(applyTransfer, loaded);
    set({ status: "ready", transfers: merged, error: null });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,
    start() {
      let active = true;
      const unsubscribe = api.subscribeTransfers((transfer) => {
        set({ ...state, transfers: applyTransfer(state.transfers, transfer) });
      });
      void load(() => active);
      return () => {
        active = false;
        unsubscribe();
      };
    },
    apply(transfer) {
      set({ ...state, transfers: applyTransfer(state.transfers, transfer) });
    },
    forget(transferId) {
      set({ ...state, transfers: removeTransfer(state.transfers, transferId) });
    },
  };
}

export function useTransferStore(api: SftpApi): {
  store: TransferStore;
  state: TransferListState;
} {
  const store = useMemo(() => createTransferStore(api), [api]);
  useEffect(() => store.start(), [store]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, state };
}
