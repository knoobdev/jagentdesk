import { beforeEach, describe, expect, it } from "vitest";
import { useDatabaseHistoryStore } from "./database-history-store";

describe("useDatabaseHistoryStore", () => {
  beforeEach(() => {
    useDatabaseHistoryStore.setState({ byDatabase: {} });
  });

  it("records most-recent-first and de-duplicates consecutive identical SQL", () => {
    const { record, list } = useDatabaseHistoryStore.getState();
    record("db_1", "select 1", 1000);
    record("db_1", "select 1", 1001); // consecutive dup → skipped
    record("db_1", "select 2", 1002);
    const entries = list("db_1");
    expect(entries.map((e) => e.sql)).toEqual(["select 2", "select 1"]);
    expect(entries[0].at_ms).toBe(1002);
  });

  it("ignores empty statements and isolates by databaseId", () => {
    const { record, list } = useDatabaseHistoryStore.getState();
    record("db_1", "   ", 1);
    record("db_2", "select 9", 2);
    expect(list("db_1")).toHaveLength(0);
    expect(list("db_2").map((e) => e.sql)).toEqual(["select 9"]);
  });

  it("clears a connection's history", () => {
    const { record, clear, list } = useDatabaseHistoryStore.getState();
    record("db_1", "select 1", 1);
    clear("db_1");
    expect(list("db_1")).toHaveLength(0);
  });
});
