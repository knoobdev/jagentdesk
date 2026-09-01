import { beforeEach, describe, expect, it } from "vitest";
import { useDatabaseNavStore } from "./database-nav-store";
import { useDatabaseViewStore } from "./database-view-store";

describe("useDatabaseNavStore", () => {
  beforeEach(() => {
    useDatabaseNavStore.setState({
      databaseId: null,
      selectedSchema: null,
      selectedObject: null,
      showingConsole: false,
      showingOverview: false,
      lastDatabase: null,
    });
  });

  it("selecting an object sets it active and clears console/overview", () => {
    const { selectObject } = useDatabaseNavStore.getState();
    selectObject("db_1", { databaseId: "db_1", schema: "public", name: "orders" });
    const s = useDatabaseNavStore.getState();
    expect(s.selectedObject).toEqual({ databaseId: "db_1", schema: "public", name: "orders" });
    expect(s.selectedSchema).toBe("public");
    expect(s.showingConsole).toBe(false);
    expect(s.showingOverview).toBe(false);
  });

  it("selecting the console clears the active object", () => {
    const { selectObject, selectConsole } = useDatabaseNavStore.getState();
    selectObject("db_1", { databaseId: "db_1", schema: "public", name: "orders" });
    selectConsole("db_1");
    const s = useDatabaseNavStore.getState();
    expect(s.selectedObject).toBeNull();
    expect(s.showingConsole).toBe(true);
  });

  it("ensureDatabase lands on the overview when the database changes", () => {
    const { selectConsole, ensureDatabase } = useDatabaseNavStore.getState();
    selectConsole("db_1");
    ensureDatabase("db_2");
    const s = useDatabaseNavStore.getState();
    expect(s.databaseId).toBe("db_2");
    expect(s.showingOverview).toBe(true);
    expect(s.showingConsole).toBe(false);
  });

  it("clearLastDatabase only forgets the matching database", () => {
    const { setLastDatabase, clearLastDatabase } = useDatabaseNavStore.getState();
    setLastDatabase("srv_a", "db_1");
    clearLastDatabase("db_2");
    expect(useDatabaseNavStore.getState().lastDatabase).toEqual({
      serverId: "srv_a",
      databaseId: "db_1",
    });
    clearLastDatabase("db_1");
    expect(useDatabaseNavStore.getState().lastDatabase).toBeNull();
  });
});

describe("useDatabaseViewStore", () => {
  beforeEach(() => {
    useDatabaseViewStore.setState({ databaseId: null, tabs: [], activeTabId: null });
  });

  it("opens a table tab once and focuses it", () => {
    const { openTable } = useDatabaseViewStore.getState();
    openTable("db_1", { schema: "public", name: "orders" });
    openTable("db_1", { schema: "public", name: "orders" });
    const s = useDatabaseViewStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe("public.orders");
  });

  it("closing the active tab focuses a neighbour", () => {
    const { openTable, closeTab } = useDatabaseViewStore.getState();
    openTable("db_1", { schema: "public", name: "orders" });
    openTable("db_1", { schema: "public", name: "customers" });
    closeTab("public.customers");
    const s = useDatabaseViewStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe("public.orders");
  });
});
