import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { DatabaseRegistry } from "../../database/database-registry.js";
import type { DatabaseEngine } from "../../database/database-dto.js";

export interface DatabaseSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface DatabaseSessionOptions {
  host: DatabaseSessionHost;
  databaseRegistry: DatabaseRegistry;
  logger: pino.Logger;
}

type Req<T extends string> = Extract<SessionInboundMessage, { type: T }>;

/**
 * The database RPC surface (list/add/connect/disconnect/remove/schemas/objects/
 * columns/query/exec). The DbClient analogue of ClusterSession: each handler
 * reaches the registry (or its live DbClient), emits the matching response, and
 * on failure emits an error response — never throws to the socket loop.
 */
export class DatabaseSession {
  private readonly host: DatabaseSessionHost;
  private readonly registry: DatabaseRegistry;
  private readonly logger: pino.Logger;

  constructor(options: DatabaseSessionOptions) {
    this.host = options.host;
    this.registry = options.databaseRegistry;
    this.logger = options.logger;
  }

  private requireClient(id: string) {
    const client = this.registry.getClient(id);
    if (!client) throw new Error("database is not connected");
    return client;
  }

  async handleList(msg: Req<"database/list">): Promise<void> {
    await this.run(msg.requestId, "database/list/response", async () => ({
      databases: this.registry.list(),
    }));
  }

  async handleAdd(msg: Req<"database/add">): Promise<void> {
    await this.run(msg.requestId, "database/add/response", async () => ({
      database: await this.registry.addConnection({
        engine: msg.engine as DatabaseEngine,
        displayName: msg.displayName,
        config: msg.config,
      }),
    }));
  }

  async handleConnect(msg: Req<"database/connect">): Promise<void> {
    await this.run(msg.requestId, "database/connect/response", async () => ({
      database: await this.registry.connect(msg.id),
    }));
  }

  async handleDisconnect(msg: Req<"database/disconnect">): Promise<void> {
    await this.run(msg.requestId, "database/disconnect/response", async () => {
      await this.registry.disconnect(msg.id);
      return {};
    });
  }

  async handleRemove(msg: Req<"database/remove">): Promise<void> {
    await this.run(msg.requestId, "database/remove/response", async () => {
      await this.registry.remove(msg.id);
      return {};
    });
  }

  async handleSchemas(msg: Req<"database/schemas">): Promise<void> {
    await this.run(msg.requestId, "database/schemas/response", async () => ({
      schemas: await this.requireClient(msg.id).listSchemas(),
    }));
  }

  async handleObjects(msg: Req<"database/objects">): Promise<void> {
    await this.run(msg.requestId, "database/objects/response", async () => ({
      objects: await this.requireClient(msg.id).listObjects(msg.schema),
    }));
  }

  async handleColumns(msg: Req<"database/columns">): Promise<void> {
    await this.run(msg.requestId, "database/columns/response", async () => ({
      columns: await this.requireClient(msg.id).listColumns(msg.schema, msg.table),
    }));
  }

  async handleQuery(msg: Req<"database/query">): Promise<void> {
    await this.run(msg.requestId, "database/query/response", async () => ({
      result: await this.requireClient(msg.id).runQuery(msg.sql, {
        limit: msg.limit,
        offset: msg.offset,
        params: msg.params,
      }),
    }));
  }

  async handleExec(msg: Req<"database/exec">): Promise<void> {
    await this.run(msg.requestId, "database/exec/response", async () => ({
      result: await this.requireClient(msg.id).execWrite(msg.sql, msg.params),
    }));
  }

  async handleForeignKeys(msg: Req<"database/foreign-keys">): Promise<void> {
    await this.run(msg.requestId, "database/foreign-keys/response", async () => ({
      foreignKeys: await this.requireClient(msg.id).listForeignKeys(msg.schema),
    }));
  }

  async handleExplain(msg: Req<"database/explain">): Promise<void> {
    await this.run(msg.requestId, "database/explain/response", async () => ({
      result: await this.requireClient(msg.id).explain(msg.sql),
    }));
  }

  async handleBegin(msg: Req<"database/begin">): Promise<void> {
    await this.run(msg.requestId, "database/begin/response", async () => {
      await this.requireClient(msg.id).begin();
      return {};
    });
  }

  async handleCommit(msg: Req<"database/commit">): Promise<void> {
    await this.run(msg.requestId, "database/commit/response", async () => {
      await this.requireClient(msg.id).commit();
      return {};
    });
  }

  async handleRollback(msg: Req<"database/rollback">): Promise<void> {
    await this.run(msg.requestId, "database/rollback/response", async () => {
      await this.requireClient(msg.id).rollback();
      return {};
    });
  }

  private async run(
    requestId: string,
    type: SessionOutboundMessage["type"],
    body: () => Promise<Record<string, unknown>>,
  ): Promise<void> {
    try {
      const data = await body();
      this.host.emit({
        type,
        payload: { requestId, error: null, ...data },
      } as SessionOutboundMessage);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ err: error, type }, "database rpc failed");
      this.host.emit({
        type,
        payload: { requestId, error: message, ...emptyBody(type) },
      } as SessionOutboundMessage);
    }
  }
}

/** Fill non-optional response fields with a null/empty default on the error path. */
function emptyBody(type: string): Record<string, unknown> {
  switch (type) {
    case "database/list/response":
      return { databases: [] };
    case "database/add/response":
    case "database/connect/response":
      return { database: null };
    case "database/schemas/response":
      return { schemas: [] };
    case "database/objects/response":
      return { objects: [] };
    case "database/columns/response":
      return { columns: [] };
    case "database/foreign-keys/response":
      return { foreignKeys: [] };
    case "database/query/response":
    case "database/exec/response":
    case "database/explain/response":
      return { result: null };
    default:
      return {};
  }
}
