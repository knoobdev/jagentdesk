import { create } from "zustand";

/**
 * Shared state for the database object navigation — the DbClient analogue of
 * cluster-nav-store. The nav lives in the app left sidebar (SidebarDatabaseNav)
 * and the selection drives the content shown by the browse screen
 * (DatabaseObjectBrowser / data grid / SQL console). Keyed by databaseId so
 * switching connections resets the selection cleanly.
 */
export interface SelectedDbObject {
  /** The databaseId that owns this object: the connection's id, or a child
   *  database's composite id (`${parentId}::${dbName}`) when picked from the tree. */
  databaseId: string;
  schema: string;
  name: string;
}

interface DatabaseNavState {
  databaseId: string | null;
  /** The schema the object tree is expanded on. */
  selectedSchema: string | null;
  /** The table/view whose data grid is shown; null when not on a table. */
  selectedObject: SelectedDbObject | null;
  /** SQL console view active (mutually exclusive with object/overview). */
  showingConsole: boolean;
  /** Schema-compare view active. */
  showingDiff: boolean;
  /** ER diagram view active. */
  showingEr: boolean;
  /** Connection overview, shown by default when a database opens. */
  showingOverview: boolean;
  /** The last database the user had open, so the sidebar can jump straight back. */
  lastDatabase: { serverId: string; databaseId: string } | null;
  selectObject: (databaseId: string, object: SelectedDbObject) => void;
  selectConsole: (databaseId: string) => void;
  selectDiff: (databaseId: string) => void;
  selectEr: (databaseId: string) => void;
  selectOverview: (databaseId: string) => void;
  setSchema: (schema: string | null) => void;
  ensureDatabase: (databaseId: string) => void;
  setLastDatabase: (serverId: string, databaseId: string) => void;
  /**
   * Forget the remembered database when the user explicitly disconnects it, so
   * the sidebar's Databases entry falls back to the connection list instead of
   * jumping back into (and silently reconnecting) a database the user just left.
   * No-op when the disconnected database isn't the remembered one.
   */
  clearLastDatabase: (databaseId: string) => void;
}

export const useDatabaseNavStore = create<DatabaseNavState>((set, get) => ({
  databaseId: null,
  selectedSchema: null,
  selectedObject: null,
  showingConsole: false,
  showingDiff: false,
  showingEr: false,
  showingOverview: false,
  lastDatabase: null,
  setLastDatabase: (serverId, databaseId) => set({ lastDatabase: { serverId, databaseId } }),
  clearLastDatabase: (databaseId) =>
    set((s) => (s.lastDatabase?.databaseId === databaseId ? { lastDatabase: null } : {})),
  selectObject: (databaseId, object) =>
    set({
      databaseId,
      selectedObject: object,
      selectedSchema: object.schema,
      showingConsole: false,
      showingDiff: false,
      showingEr: false,
      showingOverview: false,
    }),
  selectConsole: (databaseId) =>
    set({
      databaseId,
      selectedObject: null,
      showingConsole: true,
      showingDiff: false,
      showingEr: false,
      showingOverview: false,
    }),
  selectDiff: (databaseId) =>
    set({
      databaseId,
      selectedObject: null,
      showingConsole: false,
      showingDiff: true,
      showingEr: false,
      showingOverview: false,
    }),
  selectEr: (databaseId) =>
    set({
      databaseId,
      selectedObject: null,
      showingConsole: false,
      showingDiff: false,
      showingEr: true,
      showingOverview: false,
    }),
  selectOverview: (databaseId) =>
    set({
      databaseId,
      selectedObject: null,
      showingConsole: false,
      showingDiff: false,
      showingEr: false,
      showingOverview: true,
    }),
  setSchema: (selectedSchema) => set({ selectedSchema }),
  ensureDatabase: (databaseId) => {
    if (get().databaseId !== databaseId) {
      // New database opened: land on the Overview, not an empty prompt.
      set({
        databaseId,
        selectedObject: null,
        selectedSchema: null,
        showingConsole: false,
        showingDiff: false,
        showingEr: false,
        showingOverview: true,
      });
    }
  },
}));
