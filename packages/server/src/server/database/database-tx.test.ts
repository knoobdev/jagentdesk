import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseRegistry } from "./database-registry.js";

/**
 * P4 proof — explicit transaction control on the live connection. A begin/exec/
 * rollback sequence (each a separate call, as the editor's Manual mode issues
 * separate RPCs) must not persist; begin/exec/commit must persist. Runs on the
 * single held connection, exactly as the session dispatches.
 */
describe("DbClient transactions (SQLite)", () => {
  let home: string;
  let dbFile: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "jad-db-tx-"));
    dbFile = path.join(home, "shop.sqlite");
    const db = new Database(dbFile);
    db.exec("create table orders (id integer primary key, status text not null)");
    db.prepare("insert into orders (id, status) values (1, 'pending')").run();
    db.close();
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  async function connect() {
    const reg = new DatabaseRegistry({ jagentdeskHome: home });
    const info = await reg.addConnection({ engine: "sqlite", config: { file: dbFile } });
    await reg.connect(info.id);
    return reg.getClient(info.id)!;
  }

  it("rolls back an uncommitted edit", async () => {
    const client = await connect();
    await client.begin();
    await client.execWrite("update orders set status = 'shipped' where id = 1");
    // Within the transaction the change is visible.
    const mid = await client.runQuery("select status from orders where id = 1");
    expect(mid.rows[0][0]).toBe("shipped");
    await client.rollback();
    const after = await client.runQuery("select status from orders where id = 1");
    expect(after.rows[0][0]).toBe("pending");
  });

  it("commits an edit so it persists", async () => {
    const client = await connect();
    await client.begin();
    await client.execWrite("update orders set status = 'shipped' where id = 1");
    await client.commit();
    const after = await client.runQuery("select status from orders where id = 1");
    expect(after.rows[0][0]).toBe("shipped");
    // Survives across a fresh connection (really on disk).
    await client.close();
    const client2 = await connect();
    const reopened = await client2.runQuery("select status from orders where id = 1");
    expect(reopened.rows[0][0]).toBe("shipped");
    await client2.close();
  });
});
