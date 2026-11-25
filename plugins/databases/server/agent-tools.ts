import { z } from "zod";
import type {
  BuiltinToolContext,
  DatabaseEngine,
  JAgentDeskToolExecutionContext,
  RegisterBuiltinTool,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";

export function registerSqlTools(
  registerTool: RegisterBuiltinTool,
  context: BuiltinToolContext,
): void {
  registerTool(
    "sql_connect",
    {
      title: "Connect a database",
      description:
        "Register + open a database connection so it appears in the human's Databases panel (they can watch the schema you design and the data live) and so you can query it with sql_query / sql_exec. Pass the engine and the connection fields (host/port/database/user/password, or a full dsn; for sqlite pass file). Returns the databaseId to use. Use this for the database you set up or work on — e.g. after a devops/dev peer provisions one — with the REAL credentials you configured; never invent credentials.",
      inputSchema: {
        engine: z.enum(["postgres", "mysql", "sqlite", "mssql", "oracle", "mongodb", "clickhouse"]),
        host: z.string().optional(),
        port: z.number().optional(),
        database: z.string().optional(),
        user: z.string().optional(),
        password: z.string().optional(),
        dsn: z.string().optional(),
        file: z.string().optional(),
        displayName: z.string().optional(),
      },
    },
    async (input: {
      engine: DatabaseEngine;
      host?: string;
      port?: number;
      database?: string;
      user?: string;
      password?: string;
      dsn?: string;
      file?: string;
      displayName?: string;
    }) => {
      if (!context.databases) {
        return {
          content: [{ type: "text", text: "Database service is not available in this session." }],
          isError: true,
        };
      }
      try {
        const info = await context.databases.addConnection({
          engine: input.engine,
          ...(input.displayName ? { displayName: input.displayName } : {}),
          config: {
            host: input.host,
            port: input.port,
            database: input.database,
            user: input.user,
            password: input.password,
            dsn: input.dsn,
            file: input.file,
          },
        });
        await context.databases.connect(info.id).catch(() => undefined);
        return {
          content: [
            {
              type: "text",
              text: `Connected database "${info.displayName}" (databaseId=${info.id}). It now shows in the human's Databases panel; query/inspect it with sql_query and sql_exec.`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to connect database: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "sql_query",
    {
      title: "SQL query",
      description:
        "Run a read-only SQL SELECT against a connected database and return the rows. Auto-approved (read-only; writes are rejected on this path — use sql_exec).",
      inputSchema: {
        databaseId: z.string().min(1),
        sql: z.string().min(1),
        limit: z.number().optional(),
        offset: z.number().optional(),
      },
    },
    async (input: { databaseId: string; sql: string; limit?: number; offset?: number }) => {
      const client = context.databases?.getClient(input.databaseId);
      if (!client) {
        return {
          content: [
            { type: "text", text: `Database not found or not connected: ${input.databaseId}` },
          ],
          isError: true,
        };
      }
      try {
        const result = await client.runQuery(input.sql, {
          limit: input.limit,
          offset: input.offset,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  );

  registerTool(
    "sql_exec",
    {
      title: "SQL exec",
      description:
        "Run a writing SQL statement (INSERT/UPDATE/DELETE/DDL) against a connected database. Requires user approval via permission card.",
      inputSchema: {
        databaseId: z.string().min(1),
        sql: z.string().min(1),
      },
    },
    async (
      input: { databaseId: string; sql: string },
      _context: JAgentDeskToolExecutionContext,
    ) => {
      if (!context.callerAgentId) {
        return {
          content: [
            { type: "text", text: "sql_exec is only available to agent-scoped tool sessions" },
          ],
          isError: true,
        };
      }
      const client = context.databases?.getClient(input.databaseId);
      if (!client) {
        return {
          content: [
            { type: "text", text: `Database not found or not connected: ${input.databaseId}` },
          ],
          isError: true,
        };
      }
      const decision = await context.requestHostToolPermission!(context.callerAgentId, {
        name: "sql_exec",
        kind: "tool",
        title: `SQL write on ${input.databaseId}`,
        description: input.sql,
        input: input as unknown as Record<string, unknown>,
      });
      if (decision.behavior !== "allow") {
        return { content: [{ type: "text", text: "Denied by user." }], isError: true };
      }
      try {
        const result = await client.execWrite(input.sql);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        };
      }
    },
  );

  // Lets ANY agent discover the databases connected in the app and their
  // databaseId, so it can then drive them with sql_query/sql_exec — the bridge
  // between workspace agents and the database feature.
  registerTool(
    "database_list",
    {
      title: "List databases",
      description:
        "List the databases connected in the app (databaseId, name, engine, state). Pass a returned databaseId to sql_query/sql_exec. Auto-approved (read-only).",
      inputSchema: {},
    },
    async () => {
      const databases = context.databases?.list() ?? [];
      const summary = databases.map((d) => ({
        databaseId: d.id,
        name: d.displayName,
        engine: d.engine,
        target: d.target,
        state: d.state,
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: summary.length, databases: summary }, null, 2),
          },
        ],
      };
    },
  );
}
