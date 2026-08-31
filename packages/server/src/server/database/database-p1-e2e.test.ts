import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import { DatabaseRegistry } from "./database-registry.js";
import { DatabaseSession } from "../session/database/database-session.js";

const silent = pino({ level: "silent" });

/**
 * P1 proof — the full protocol → session → registry → adapter path. Every request
 * is validated through the real wire union (SessionInboundMessageSchema) and every
 * response through SessionOutboundMessageSchema, so this exercises the same shapes
 * the socket loop sees, not a bypass.
 */
describe("database RPC round-trip (SQLite, in-process)", () => {
  let home: string;
  let dbFile: string;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "jad-db-rpc-"));
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

  it("drives add → connect → schemas → objects → columns → query → exec over the wire union", async () => {
    const registry = new DatabaseRegistry({ jagentdeskHome: home });
    await registry.initialize();

    const emitted: SessionOutboundMessage[] = [];
    const session = new DatabaseSession({
      host: {
        emit: (msg) => {
          // Prove the emitted response is a valid wire message, then keep it.
          emitted.push(SessionOutboundMessageSchema.parse(msg) as SessionOutboundMessage);
        },
      },
      databaseRegistry: registry,
      logger: silent,
    });

    // Every request is parsed through the real inbound union before dispatch.
    const parse = (raw: unknown) =>
      SessionInboundMessageSchema.parse(raw) as Extract<
        SessionInboundMessage,
        { requestId: string }
      >;
    const last = () => emitted[emitted.length - 1];

    await session.handleAdd(
      parse({
        type: "database/add",
        requestId: "r1",
        engine: "sqlite",
        displayName: "shop",
        config: { file: dbFile },
      }) as never,
    );
    const added = last();
    expect(added.type).toBe("database/add/response");
    const dbId = (added.payload as { database: { id: string } }).database.id;
    expect(dbId).toMatch(/^db_/);

    await session.handleConnect(
      parse({ type: "database/connect", requestId: "r2", id: dbId }) as never,
    );
    expect((last().payload as { database: { state: string } }).database.state).toBe("connected");

    await session.handleSchemas(
      parse({ type: "database/schemas", requestId: "r3", id: dbId }) as never,
    );
    expect((last().payload as { schemas: unknown[] }).schemas.length).toBeGreaterThan(0);

    await session.handleObjects(
      parse({ type: "database/objects", requestId: "r4", id: dbId, schema: "main" }) as never,
    );
    const objects = (last().payload as { objects: Array<{ name: string }> }).objects;
    expect(objects.map((o) => o.name)).toContain("orders");

    await session.handleColumns(
      parse({
        type: "database/columns",
        requestId: "r5",
        id: dbId,
        schema: "main",
        table: "orders",
      }) as never,
    );
    const columns = (last().payload as { columns: Array<{ name: string; isForeignKey: boolean }> })
      .columns;
    expect(columns.find((c) => c.name === "customer_id")?.isForeignKey).toBe(true);

    await session.handleQuery(
      parse({
        type: "database/query",
        requestId: "r6",
        id: dbId,
        sql: "select id, status from orders order by id",
        limit: 2,
      }) as never,
    );
    const result = (last().payload as { result: { rows: unknown[]; truncated: boolean } }).result;
    expect(result.rows).toHaveLength(2);
    expect(result.truncated).toBe(true);

    await session.handleExec(
      parse({
        type: "database/exec",
        requestId: "r7",
        id: dbId,
        sql: "update orders set status = 'shipped' where id = 1",
      }) as never,
    );
    expect((last().payload as { result: { affected: number } }).result.affected).toBe(1);
  });

  it("emits an error response (never throws) when the id is not connected", async () => {
    const registry = new DatabaseRegistry({ jagentdeskHome: home });
    const emitted: SessionOutboundMessage[] = [];
    const session = new DatabaseSession({
      host: { emit: (msg) => emitted.push(msg) },
      databaseRegistry: registry,
      logger: silent,
    });
    await session.handleSchemas({
      type: "database/schemas",
      requestId: "e1",
      id: "db_missing",
    } as never);
    expect(emitted[0].type).toBe("database/schemas/response");
    expect((emitted[0].payload as { error: string | null }).error).toMatch(/not connected/i);
    expect((emitted[0].payload as { schemas: unknown[] }).schemas).toEqual([]);
  });
});

// Infra-gated adapter proofs. Enable with JAD_DB_E2E=1 after starting the
// throwaway containers (see docs/plans/active/multi-database.md P1).
const E2E = process.env.JAD_DB_E2E === "1";

describe.runIf(E2E)("PostgreSQL adapter e2e (throwaway docker)", () => {
  it("connects, introspects PK/FK and paginates a real Postgres", async () => {
    const { PostgresDbClient } = await import("./adapters/postgres.js");
    const client = new PostgresDbClient({
      host: "127.0.0.1",
      port: 55433,
      database: "testdb",
      user: "postgres",
      password: "testpw",
    });
    await client.connect();
    try {
      expect(await client.serverVersion()).toMatch(/^PostgreSQL /);
      await client.execWrite("drop table if exists orders");
      await client.execWrite("drop table if exists customers");
      await client.execWrite("create table customers (id serial primary key, name text)");
      await client.execWrite(
        "create table orders (id serial primary key, customer_id integer references customers(id), status text not null)",
      );
      await client.execWrite("insert into customers (name) values ('acme')");
      for (let i = 0; i < 5; i++) {
        await client.execWrite("insert into orders (customer_id, status) values (1, $1)", [
          i % 2 ? "paid" : "pending",
        ]);
      }

      const schemas = await client.listSchemas();
      expect(schemas.map((s) => s.name)).toContain("public");

      const objects = await client.listObjects("public");
      expect(objects.map((o) => o.name)).toContain("orders");

      const columns = await client.listColumns("public", "orders");
      const byName = new Map(columns.map((c) => [c.name, c]));
      expect(byName.get("id")?.isPrimaryKey).toBe(true);
      expect(byName.get("customer_id")?.isForeignKey).toBe(true);
      expect(byName.get("status")?.nullable).toBe(false);

      const page = await client.runQuery("select id, status from orders order by id", { limit: 2 });
      expect(page.rows).toHaveLength(2);
      expect(page.truncated).toBe(true);

      await expect(client.runQuery("delete from orders")).rejects.toThrow(/read-only/i);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe.runIf(E2E)("MySQL adapter e2e (throwaway docker)", () => {
  it("connects, introspects PK/FK and paginates a real MySQL", async () => {
    const { MysqlDbClient } = await import("./adapters/mysql.js");
    const client = new MysqlDbClient({
      host: "127.0.0.1",
      port: 55434,
      database: "testdb",
      user: "root",
      password: "testpw",
    });
    await client.connect();
    try {
      expect(await client.serverVersion()).toMatch(/^MySQL /);
      await client.execWrite("drop table if exists orders");
      await client.execWrite("drop table if exists customers");
      await client.execWrite(
        "create table customers (id int auto_increment primary key, name text)",
      );
      await client.execWrite(
        "create table orders (id int auto_increment primary key, customer_id int, status varchar(32) not null, foreign key (customer_id) references customers(id))",
      );
      await client.execWrite("insert into customers (name) values ('acme')");
      for (let i = 0; i < 5; i++) {
        await client.execWrite("insert into orders (customer_id, status) values (1, ?)", [
          i % 2 ? "paid" : "pending",
        ]);
      }

      const objects = await client.listObjects("testdb");
      expect(objects.map((o) => o.name)).toContain("orders");

      const columns = await client.listColumns("testdb", "orders");
      const byName = new Map(columns.map((c) => [c.name, c]));
      expect(byName.get("id")?.isPrimaryKey).toBe(true);
      expect(byName.get("customer_id")?.isForeignKey).toBe(true);
      expect(byName.get("status")?.nullable).toBe(false);

      const page = await client.runQuery("select id, status from orders order by id", { limit: 2 });
      expect(page.rows).toHaveLength(2);
      expect(page.truncated).toBe(true);

      await expect(client.runQuery("delete from orders")).rejects.toThrow(/read-only/i);
    } finally {
      await client.close();
    }
  }, 30_000);
});
