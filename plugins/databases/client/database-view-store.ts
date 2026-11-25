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
  /** A pending WHERE for a table the user is navigating to via a foreign key
   *  ("Related Rows"). The target data editor consumes it once on open. */
  initialFilter: { schema: string; name: string; where: string } | null;
  openTable: (databaseId: string, input: { schema: string; name: string }) => void;
  closeTab: (id: string) => void;
  setActive: (id: string | null) => void;
  bumpRefresh: () => void;
  resetForDatabase: (databaseId: string) => void;
  /** Queue a WHERE for the next open of (schema, name) — used by FK navigation. */
  requestFilter: (schema: string, name: string, where: string) => void;
  /** Read and clear a queued WHERE for (schema, name); null when none. */
  consumeFilter: (schema: string, name: string) => string | null;
}

const tabId = (schema: string, name: string) => `${schema}.${name}`;

export const useDatabaseViewStore = create<DatabaseViewState>((set, get) => ({
  databaseId: null,
  tabs: [],
  activeTabId: null,
  listRefreshKey: 0,
  initialFilter: null,
  requestFilter: (schema, name, where) => set({ initialFilter: { schema, name, where } }),
  consumeFilter: (schema, name) => {
    const f = get().initialFilter;
    if (f && f.schema === schema && f.name === name) {
      set({ initialFilter: null });
      return f.where;
    }
    return null;
  },
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
