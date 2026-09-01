import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createJAgentDeskToolCatalog } from "./jagentdesk-tools.js";
import type { JAgentDeskToolHostDependencies } from "./jagentdesk-tools.js";
import { DatabaseRegistry } from "../../database/database-registry.js";

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "debug" as const,
  } as unknown as Parameters<typeof createJAgentDeskToolCatalog>[0]["logger"];
}

function createMinimalDeps(
  overrides?: Partial<JAgentDeskToolHostDependencies>,
): JAgentDeskToolHostDependencies {
  return {
    agentManager: vi.fn() as unknown as JAgentDeskToolHostDependencies["agentManager"],
    agentStorage: vi.fn() as unknown as JAgentDeskToolHostDependencies["agentStorage"],
    providerSnapshotManager:
      vi.fn() as unknown as JAgentDeskToolHostDependencies["providerSnapshotManager"],
    logger: createMockLogger(),
    ...overrides,
  };
}

let home: string;
let databaseId: string;
let registry: DatabaseRegistry;

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "jad-sqltool-"));
  const dbFile = path.join(home, "shop.sqlite");
  const db = new Database(dbFile);
  db.exec("create table orders (id integer primary key, status text not null)");
  db.prepare("insert into orders (id, status) values (1, 'paid')").run();
  db.close();
  registry = new DatabaseRegistry({ jagentdeskHome: home });
  const info = await registry.addConnection({ engine: "sqlite", config: { file: dbFile } });
  databaseId = info.id;
  await registry.connect(databaseId);
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

test("catalog registers sql_query, sql_exec and database_list", () => {
  const catalog = createJAgentDeskToolCatalog(createMinimalDeps({ databaseRegistry: registry }));
  expect(catalog.getTool("sql_query")).toBeDefined();
  expect(catalog.getTool("sql_exec")).toBeDefined();
  expect(catalog.getTool("database_list")).toBeDefined();
});

test("sql_query runs a read-only SELECT and returns rows", async () => {
  const catalog = createJAgentDeskToolCatalog(createMinimalDeps({ databaseRegistry: registry }));
  const result = await catalog.executeTool("sql_query", {
    databaseId,
    sql: "select id, status from orders order by id",
  });
  expect(result.isError).toBeFalsy();
  const payload = JSON.parse(result.content[0]!.text as string);
  expect(payload.rows).toEqual([[1, "paid"]]);
});

test("sql_query rejects a write statement on the read-only path", async () => {
  const catalog = createJAgentDeskToolCatalog(createMinimalDeps({ databaseRegistry: registry }));
  const result = await catalog.executeTool("sql_query", {
    databaseId,
    sql: "delete from orders",
  });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toMatch(/read-only/i);
});

test("sql_exec is denied (and never writes) when the user denies permission", async () => {
  const requestHostToolPermission = vi.fn().mockResolvedValue({ behavior: "deny" });
  const catalog = createJAgentDeskToolCatalog(
    createMinimalDeps({
      callerAgentId: "test-agent-id",
      databaseRegistry: registry,
      requestHostToolPermission,
    }),
  );
  const result = await catalog.executeTool("sql_exec", {
    databaseId,
    sql: "update orders set status = 'void' where id = 1",
  });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toBe("Denied by user.");
  // The row is untouched.
  const check = await registry
    .getClient(databaseId)!
    .runQuery("select status from orders where id = 1");
  expect(check.rows[0][0]).toBe("paid");
});

test("sql_exec writes when the user allows permission", async () => {
  const requestHostToolPermission = vi.fn().mockResolvedValue({ behavior: "allow" });
  const catalog = createJAgentDeskToolCatalog(
    createMinimalDeps({
      callerAgentId: "test-agent-id",
      databaseRegistry: registry,
      requestHostToolPermission,
    }),
  );
  const result = await catalog.executeTool("sql_exec", {
    databaseId,
    sql: "update orders set status = 'void' where id = 1",
  });
  expect(result.isError).toBeFalsy();
  expect(requestHostToolPermission).toHaveBeenCalledWith(
    "test-agent-id",
    expect.objectContaining({ name: "sql_exec", kind: "tool" }),
  );
  const check = await registry
    .getClient(databaseId)!
    .runQuery("select status from orders where id = 1");
  expect(check.rows[0][0]).toBe("void");
});

test("database_list reports the connected database", async () => {
  const catalog = createJAgentDeskToolCatalog(createMinimalDeps({ databaseRegistry: registry }));
  const result = await catalog.executeTool("database_list", {});
  const payload = JSON.parse(result.content[0]!.text as string);
  expect(payload.count).toBe(1);
  expect(payload.databases[0]).toMatchObject({ databaseId, engine: "sqlite", state: "connected" });
});
