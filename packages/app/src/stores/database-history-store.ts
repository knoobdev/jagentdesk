import { create } from "zustand";

/**
 * Per-connection SQL history for the console — the DataGrip "history" affordance.
 * In-memory, capped, most-recent-first; keyed by databaseId. Recording an
 * identical consecutive statement is de-duplicated. Timestamps are passed in by
 * the caller (the store never reads the clock, keeping it deterministic to test).
 */
export interface DatabaseHistoryEntry {
  sql: string;
  at_ms: number;
}

const MAX_ENTRIES = 100;

interface DatabaseHistoryState {
  byDatabase: Record<string, DatabaseHistoryEntry[]>;
  record: (databaseId: string, sql: string, at_ms: number) => void;
  list: (databaseId: string) => DatabaseHistoryEntry[];
  clear: (databaseId: string) => void;
}

export const useDatabaseHistoryStore = create<DatabaseHistoryState>((set, get) => ({
  byDatabase: {},
  record: (databaseId, sql, at_ms) => {
    const trimmed = sql.trim();
    if (!trimmed) return;
    set((state) => {
      const existing = state.byDatabase[databaseId] ?? [];
      if (existing[0]?.sql === trimmed) return state; // skip consecutive duplicate
      const next = [{ sql: trimmed, at_ms }, ...existing].slice(0, MAX_ENTRIES);
      return { byDatabase: { ...state.byDatabase, [databaseId]: next } };
    });
  },
  list: (databaseId) => get().byDatabase[databaseId] ?? [],
  clear: (databaseId) =>
    set((state) => ({ byDatabase: { ...state.byDatabase, [databaseId]: [] } })),
}));
