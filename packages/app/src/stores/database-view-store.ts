import { create } from "zustand";

/**
 * Open tabs for the database content area — the DbClient analogue of
 * cluster-view-store. A tab is a table/view opened into a data grid; the SQL
 * console and overview live in the nav store's active flags. Keyed by databaseId.
 */
export interface DatabaseViewTab {
  id: string;
  schema: string;
  name: string;
}

interface DatabaseViewState {
  databaseId: string | null;
  tabs: DatabaseViewTab[];
  /** null = the overview / console (driven by the nav store). */
  activeTabId: string | null;
  /** Bumped when an editor commit mutates data so the grid reloads. */
  listRefreshKey: number;
  openTable: (databaseId: string, input: { schema: string; name: string }) => void;
  closeTab: (id: string) => void;
  setActive: (id: string | null) => void;
  bumpRefresh: () => void;
  resetForDatabase: (databaseId: string) => void;
}

const tabId = (schema: string, name: string) => `${schema}.${name}`;

export const useDatabaseViewStore = create<DatabaseViewState>((set, get) => ({
  databaseId: null,
  tabs: [],
  activeTabId: null,
  listRefreshKey: 0,
  openTable: (databaseId, input) => {
    const id = tabId(input.schema, input.name);
    const state = get();
    const exists = state.tabs.some((t) => t.id === id);
    set({
      databaseId,
      activeTabId: id,
      tabs: exists ? state.tabs : [...state.tabs, { id, ...input }],
    });
  },
  closeTab: (id) => {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === id);
    const tabs = state.tabs.filter((t) => t.id !== id);
    let activeTabId = state.activeTabId;
    if (state.activeTabId === id) {
      const next = tabs[idx] ?? tabs[idx - 1] ?? null;
      activeTabId = next ? next.id : null;
    }
    set({ tabs, activeTabId });
  },
  setActive: (id) => set({ activeTabId: id }),
  bumpRefresh: () => set((s) => ({ listRefreshKey: s.listRefreshKey + 1 })),
  resetForDatabase: (databaseId) => {
    if (get().databaseId !== databaseId) {
      set({ databaseId, tabs: [], activeTabId: null });
    }
  },
}));
