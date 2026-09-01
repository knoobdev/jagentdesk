import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseRegistry } from "./database-registry.js";
import { FileSecretStore } from "./secret-store.js";

describe("DatabaseRegistry (SQLite)", () => {
  let home: string;
  let dbFile: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "jad-db-"));
    dbFile = path.join(home, "shop.sqlite");
    const db = new Database(dbFile);
    db.exec(
      "create table customers (id integer primary key, name text);" +
        "create table orders (id integer primary key, customer_id integer references customers(id), status text not null, total real);",
    );
    db.prepare("insert into customers (id, name) values (?,?)").run(101, "acme");
    const insert = db.prepare("insert into orders (customer_id, status, total) values (?,?,?)");
    for (let i = 1; i <= 5; i++) insert.run(101, i % 2 ? "paid" : "pending", i * 10);
    db.close();
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("adds, connects, introspects and paginates a real SQLite database", async () => {
    const reg = new DatabaseRegistry({ jagentdeskHome: home });
    await reg.initialize();

    const info = await reg.addConnection({
      engine: "sqlite",
      displayName: "shop",
      config: { file: dbFile },
    });
    expect(info.state).toBe("saved");
    expect(reg.list()).toHaveLength(1);

    const connected = await reg.connect(info.id);
    expect(connected.state).toBe("connected");
    expect(connected.serverVersion).toMatch(/^SQLite /);

    const client = reg.getClient(info.id);
    expect(client).toBeDefined();

    const objects = await client!.listObjects("main");
    expect(objects.map((o) => o.name)).toContain("orders");

    const columns = await client!.listColumns("main", "orders");
    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("id")?.isPrimaryKey).toBe(true);
    expect(byName.get("customer_id")?.isForeignKey).toBe(true);
    expect(byName.get("status")?.nullable).toBe(false);

    // Paginate: page size 2 over 5 rows → truncated true, 2 rows.
    const page1 = await client!.runQuery("select id, status, total from orders order by id", {
      limit: 2,
    });
    expect(page1.rows).toHaveLength(2);
    expect(page1.truncated).toBe(true);
    expect(page1.columns.map((c) => c.name)).toEqual(["id", "status", "total"]);

    const page3 = await client!.runQuery("select id from orders order by id", {
      limit: 2,
      offset: 4,
    });
    expect(page3.rows).toHaveLength(1);
    expect(page3.truncated).toBe(false);
  });

  it("introspects foreign keys (the relationships / ER edges)", async () => {
    const reg = new DatabaseRegistry({ jagentdeskHome: home });
    const info = await reg.addConnection({ engine: "sqlite", config: { file: dbFile } });
    await reg.connect(info.id);
    const fks = await reg.getClient(info.id)!.listForeignKeys("main");
    expect(fks).toContainEqual({
      table: "orders",
      column: "customer_id",
      refSchema: "main",
      refTable: "customers",
      refColumn: "id",
    });
  });

  it("rejects a write on the read-only query path", async () => {
    const reg = new DatabaseRegistry({ jagentdeskHome: home });
    const info = await reg.addConnection({ engine: "sqlite", config: { file: dbFile } });
    await reg.connect(info.id);
    const client = reg.getClient(info.id)!;
    await expect(client.runQuery("delete from orders")).rejects.toThrow(/read-only/i);
  });

  it("persists connection identity across a restart (no secret on disk)", async () => {
    const reg = new DatabaseRegistry({ jagentdeskHome: home });
    const info = await reg.addConnection({
      engine: "sqlite",
      displayName: "shop",
      config: { file: dbFile },
    });
    await new Promise((r) => setTimeout(r, 30));

    const reloaded = new DatabaseRegistry({ jagentdeskHome: home });
    await reloaded.initialize();
    const list = reloaded.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(info.id);
    expect(list[0].displayName).toBe("shop");
    expect(list[0].state).toBe("saved");
  });

  it("encrypts secrets at rest (round-trips, not plaintext)", async () => {
    const store = new FileSecretStore(home);
    await store.set("db_x", "super-secret-password");
    expect(await store.get("db_x")).toBe("super-secret-password");
    const raw = require("node:fs").readFileSync(path.join(home, "secrets.json"), "utf8");
    expect(raw).not.toContain("super-secret-password");
  });
});
