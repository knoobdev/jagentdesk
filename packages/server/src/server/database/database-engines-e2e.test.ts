import { describe, expect, it } from "vitest";
import type { DbClient } from "./db-client.js";

// Infra-gated adapter proofs for the networked engines. Enable with JAD_DB_E2E=1
// after starting the throwaway containers (see docs/plans/active/multi-database.md).
const E2E = process.env.JAD_DB_E2E === "1";

async function seedSql(client: DbClient, opts: { serial: string; pk: string }) {
  await client.execWrite("drop table orders").catch(() => undefined);
  await client.execWrite(`create table orders (id ${opts.serial}, status ${opts.pk})`);
  for (let i = 0; i < 5; i++) {
    await client.execWrite(`insert into orders (id, status) values (${i + 1}, 'row${i}')`);
  }
}

describe.runIf(E2E)("SQL Server adapter e2e", () => {
  it("connects, introspects and paginates a real SQL Server", async () => {
    const { MssqlDbClient } = await import("./adapters/mssql.js");
    const client = new MssqlDbClient({
      host: "127.0.0.1",
      port: 51433,
      database: "master",
      user: "sa",
      password: "Testpw_2026",
    });
    await client.connect();
    try {
      expect(await client.serverVersion()).toMatch(/SQL|Microsoft/i);
      await seedSql(client, { serial: "int primary key", pk: "varchar(32) not null" });
      const objects = await client.listObjects("dbo");
      expect(objects.map((o) => o.name)).toContain("orders");
      const columns = await client.listColumns("dbo", "orders");
      const byName = new Map(columns.map((c) => [c.name, c]));
      expect(byName.get("id")?.isPrimaryKey).toBe(true);
      expect(byName.get("status")?.nullable).toBe(false);
      const page = await client.runQuery("select id, status from orders", { limit: 2 });
      expect(page.rows).toHaveLength(2);
      expect(page.truncated).toBe(true);
      await expect(client.runQuery("delete from orders")).rejects.toThrow(/read-only/i);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe.runIf(E2E)("Oracle adapter e2e", () => {
  it("connects, introspects and paginates a real Oracle", async () => {
    const { OracleDbClient } = await import("./adapters/oracle.js");
    const client = new OracleDbClient({
      host: "127.0.0.1",
      port: 51521,
      user: "system",
      password: "testpw",
      options: { service: "FREEPDB1" },
    });
    await client.connect();
    try {
      expect(await client.serverVersion()).toMatch(/Oracle/i);
      await seedSql(client, { serial: "number primary key", pk: "varchar2(32) not null" });
      const objects = await client.listObjects("SYSTEM");
      expect(objects.map((o) => o.name)).toContain("ORDERS");
      const columns = await client.listColumns("SYSTEM", "ORDERS");
      const byName = new Map(columns.map((c) => [c.name, c]));
      expect(byName.get("ID")?.isPrimaryKey).toBe(true);
      expect(byName.get("STATUS")?.nullable).toBe(false);
      const page = await client.runQuery("select id, status from orders", { limit: 2 });
      expect(page.rows).toHaveLength(2);
      expect(page.truncated).toBe(true);
      await expect(client.runQuery("delete from orders")).rejects.toThrow(/read-only/i);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe.runIf(E2E)("ClickHouse adapter e2e", () => {
  it("connects, introspects and paginates a real ClickHouse", async () => {
    const { ClickhouseDbClient } = await import("./adapters/clickhouse.js");
    const client = new ClickhouseDbClient({
      host: "127.0.0.1",
      port: 58123,
      user: "default",
      password: "testpw",
      database: "default",
    });
    await client.connect();
    try {
      expect(await client.serverVersion()).toMatch(/ClickHouse/i);
      await client.execWrite("drop table if exists orders");
      await client.execWrite(
        "create table orders (id UInt32, status String) engine = MergeTree order by id",
      );
      await client.execWrite(
        "insert into orders (id, status) values (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')",
      );
      const objects = await client.listObjects("default");
      expect(objects.map((o) => o.name)).toContain("orders");
      const columns = await client.listColumns("default", "orders");
      expect(columns.map((c) => c.name)).toEqual(["id", "status"]);
      expect(columns.find((c) => c.name === "id")?.isPrimaryKey).toBe(true);
      const page = await client.runQuery("select id, status from orders order by id", { limit: 2 });
      expect(page.rows).toHaveLength(2);
      expect(page.truncated).toBe(true);
      await expect(client.runQuery("alter table orders delete where 1=1")).rejects.toThrow(
        /read-only/i,
      );
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe.runIf(E2E)("MongoDB adapter e2e", () => {
  it("connects, lists collections, samples fields and queries", async () => {
    const { MongoDbClient } = await import("./adapters/mongodb.js");
    const client = new MongoDbClient({ host: "127.0.0.1", port: 57017, database: "testdb" });
    await client.connect();
    try {
      expect(await client.serverVersion()).toMatch(/MongoDB/i);
      await client.execWrite(
        JSON.stringify({
          collection: "orders",
          insert: [
            { id: 1, status: "paid" },
            { id: 2, status: "pending" },
            { id: 3, status: "paid" },
          ],
        }),
      );
      const objects = await client.listObjects("testdb");
      expect(objects.map((o) => o.name)).toContain("orders");
      const columns = await client.listColumns("testdb", "orders");
      const names = columns.map((c) => c.name);
      expect(names).toContain("status");
      expect(columns.find((c) => c.name === "_id")?.isPrimaryKey).toBe(true);
      // Grid-style SQL is translated to a find.
      const grid = await client.runQuery('select * from "testdb"."orders"', { limit: 10 });
      expect(grid.rowCount).toBe(3);
      // JSON find spec (console form).
      const filtered = await client.runQuery(
        JSON.stringify({ collection: "orders", filter: { status: "paid" } }),
      );
      expect(filtered.rowCount).toBe(2);
      await client.execWrite(JSON.stringify({ collection: "orders", delete: {} }));
    } finally {
      await client.close();
    }
  }, 60_000);
});
