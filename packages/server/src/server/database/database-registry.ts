import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type {
  DatabaseEngine,
  DatabaseInfo,
  DatabaseConnectionState,
  DbDatabaseName,
} from "./database-dto.js";
import type { DbClient, DbConnectionConfig } from "./db-client.js";
import { SqliteDbClient } from "./adapters/sqlite.js";
import { PostgresDbClient } from "./adapters/postgres.js";
import { MysqlDbClient } from "./adapters/mysql.js";
import { MssqlDbClient } from "./adapters/mssql.js";
import { OracleDbClient } from "./adapters/oracle.js";
import { MongoDbClient } from "./adapters/mongodb.js";
import { ClickhouseDbClient } from "./adapters/clickhouse.js";
import { FileSecretStore, MemorySecretStore, type SecretStore } from "./secret-store.js";

interface StoredConnection {
  id: string;
  engine: DatabaseEngine;
  displayName: string;
  // Non-secret connection fields. The password / DSN live in the SecretStore.
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  file?: string;
  options?: Record<string, unknown>;
  state: DatabaseConnectionState;
  serverVersion?: string;
  lastError?: string;
  lastSeen_ms?: number;
}

// Persisted shape: identity + non-secret connection fields only. The secret is
// never written here — it goes to the encrypted SecretStore.
const PersistedSchema = z.array(
  z.object({
    id: z.string(),
    engine: z.string(),
    displayName: z.string(),
    host: z.string().optional(),
    port: z.number().optional(),
    database: z.string().optional(),
    user: z.string().optional(),
    file: z.string().optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  }),
);

export interface AddConnectionInput {
  engine: DatabaseEngine;
  displayName?: string;
  config: DbConnectionConfig;
}

/**
 * The in-process source of truth for saved database connections — the DbClient
 * analogue of ClusterRegistry. Identity + non-secret fields persist to
 * databases.json; the secret is encrypted in the SecretStore; live DbClients are
 * held in memory and re-established at runtime.
 */
export class DatabaseRegistry {
  private connections: Map<string, StoredConnection> = new Map();
  // Live clients keyed by databaseId: a real connection's id, or a child database's
  // composite id `${parentId}::${dbName}` opened from the tree.
  private clients: Map<string, DbClient> = new Map();
  private childVersions: Map<string, string | undefined> = new Map();
  private readonly storePath: string | null;
  private readonly logger: Logger | null;
  private readonly secrets: SecretStore;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options?: { jagentdeskHome?: string; logger?: Logger; secretStore?: SecretStore }) {
    const dir = options?.jagentdeskHome ? path.join(options.jagentdeskHome, "databases") : null;
    this.storePath = dir ? path.join(dir, "databases.json") : null;
    this.logger = options?.logger ?? null;
    this.secrets =
      options?.secretStore ?? (dir ? new FileSecretStore(dir) : new MemorySecretStore());
  }

  /** Load persisted connection identities so saved connections survive restart. */
  async initialize(): Promise<void> {
    if (!this.storePath) return;
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      for (const c of PersistedSchema.parse(JSON.parse(raw))) {
        this.connections.set(c.id, {
          ...c,
          engine: c.engine as DatabaseEngine,
          state: "saved",
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.error({ err: error, storePath: this.storePath }, "Failed to load databases");
      }
    }
  }

  async addConnection(input: AddConnectionInput): Promise<DatabaseInfo> {
    const id = "db_" + randomBytes(6).toString("hex");
    const { engine, config } = input;
    const entry: StoredConnection = {
      id,
      engine,
      displayName: input.displayName ?? deriveName(engine, config),
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      file: config.file,
      options: config.options,
      state: "saved",
    };
    this.connections.set(id, entry);
    const secret = config.password ?? config.dsn ?? null;
    if (secret) await this.secrets.set(id, secret);
    this.schedulePersist();
    return toInfo(entry);
  }

  list(): DatabaseInfo[] {
    return Array.from(this.connections.values()).map(toInfo);
  }

  getClient(id: string): DbClient | undefined {
    return this.clients.get(id);
  }

  async connect(id: string): Promise<DatabaseInfo> {
    const entry = this.connections.get(id);
    if (!entry) throw new Error(`database not found: ${id}`);
    return this.openClient(entry, entry.database);
  }

  /** The databases on the server this connection points at (empty when the engine
   *  has a single logical database or is not connected). Drives the DATABASE tree. */
  async listDatabases(id: string): Promise<DbDatabaseName[]> {
    const client = this.clients.get(id);
    if (!client?.listDatabases) return [];
    return client.listDatabases();
  }

  /**
   * Open another database on the same server as a CHILD connection, so the tree can
   * show many databases of one connection at once (DataGrip's server → databases).
   * The child is a full DbClient registered under the composite id
   * `${parentId}::${database}`, reusing the parent's host/credentials with the
   * database overridden — every existing RPC/component works on it unchanged because
   * they key on databaseId. Runtime-only (never persisted). Idempotent.
   */
  async openDatabase(parentId: string, database: string): Promise<DatabaseInfo> {
    const parent = this.connections.get(parentId);
    if (!parent) throw new Error(`database not found: ${parentId}`);
    const childId = childDatabaseId(parentId, database);
    if (this.clients.has(childId)) {
      return childInfo(parent, database, "connected", this.childVersions.get(childId));
    }
    try {
      const secret = await this.secrets.get(parentId);
      const config: DbConnectionConfig = {
        host: parent.host,
        port: parent.port,
        database,
        user: parent.user,
        file: parent.file,
        options: parent.options,
        ...secretFields(secret, database),
      };
      const client = createClient(parent.engine, config);
      await client.connect();
      const version = await client.serverVersion().catch(() => undefined);
      this.clients.set(childId, client);
      this.childVersions.set(childId, version);
      return childInfo(parent, database, "connected", version);
    } catch (err) {
      return childInfo(
        parent,
        database,
        "error",
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Build the live config from an entry and connect its client. */
  private async openClient(
    entry: StoredConnection,
    database: string | undefined,
  ): Promise<DatabaseInfo> {
    entry.state = "connecting";
    try {
      const secret = await this.secrets.get(entry.id);
      const config: DbConnectionConfig = {
        host: entry.host,
        port: entry.port,
        database,
        user: entry.user,
        file: entry.file,
        options: entry.options,
        ...secretFields(secret, database),
      };
      const client = createClient(entry.engine, config);
      await client.connect();
      entry.serverVersion = await client.serverVersion().catch(() => undefined);
      entry.state = "connected";
      entry.lastSeen_ms = Date.now();
      entry.lastError = undefined;
      this.clients.set(entry.id, client);
    } catch (err) {
      entry.state = "error";
      entry.lastError = err instanceof Error ? err.message : String(err);
    }
    return toInfo(entry);
  }

  async disconnect(id: string): Promise<void> {
    // Close the connection's own client + every child-database client opened from it.
    for (const key of Array.from(this.clients.keys())) {
      if (key === id || key.startsWith(`${id}::`)) {
        await this.clients
          .get(key)
          ?.close()
          .catch(() => undefined);
        this.clients.delete(key);
        this.childVersions.delete(key);
      }
    }
    const entry = this.connections.get(id);
    if (entry) entry.state = "saved";
  }

  async remove(id: string): Promise<void> {
    await this.disconnect(id);
    this.connections.delete(id);
    await this.secrets.delete(id).catch(() => undefined);
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (!this.storePath) return;
    const storePath = this.storePath;
    const snapshot = Array.from(this.connections.values()).map(toPersisted);
    this.persistQueue = this.persistQueue
      .then(() => writeJsonFileAtomic(storePath, snapshot))
      .catch((error) => {
        this.logger?.error({ err: error, storePath }, "Failed to persist databases");
      });
  }
}

function createClient(engine: DatabaseEngine, config: DbConnectionConfig): DbClient {
  switch (engine) {
    case "sqlite":
      return new SqliteDbClient(config);
    case "postgres":
      return new PostgresDbClient(config);
    case "mysql":
      return new MysqlDbClient(config);
    case "mssql":
      return new MssqlDbClient(config);
    case "oracle":
      return new OracleDbClient(config);
    case "mongodb":
      return new MongoDbClient(config);
    case "clickhouse":
      return new ClickhouseDbClient(config);
    default:
      throw new Error(`database engine not yet supported: ${engine}`);
  }
}

function deriveName(engine: DatabaseEngine, config: DbConnectionConfig): string {
  if (engine === "sqlite") return path.basename(config.file ?? config.database ?? "sqlite");
  return config.database ?? config.host ?? engine;
}

function isDsn(secret: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(secret);
}

/** Identity + non-secret fields for databases.json (never the secret). */
function toPersisted(c: StoredConnection): Record<string, unknown> {
  const out: Record<string, unknown> = { id: c.id, engine: c.engine, displayName: c.displayName };
  if (c.host) out.host = c.host;
  if (c.port) out.port = c.port;
  if (c.database) out.database = c.database;
  if (c.user) out.user = c.user;
  if (c.file) out.file = c.file;
  if (c.options) out.options = c.options;
  return out;
}

function secretFields(secret: string | null, database?: string): Partial<DbConnectionConfig> {
  if (!secret) return {};
  return isDsn(secret) ? { dsn: overrideDsnDatabase(secret, database) } : { password: secret };
}

/** Point a DSN at a different database (used when switching databases on a
 *  DSN-configured connection). Discrete-field connections don't need this. */
function overrideDsnDatabase(dsn: string, database?: string): string {
  if (!database) return dsn;
  try {
    const url = new URL(dsn);
    url.pathname = `/${encodeURIComponent(database)}`;
    return url.toString();
  } catch {
    return dsn;
  }
}

/** host:port/database (or file path for SQLite) for display — never the secret. */
function formatTarget(entry: StoredConnection): string {
  if (entry.engine === "sqlite") return entry.file ?? "";
  const port = entry.port ? `:${entry.port}` : "";
  const database = entry.database ? `/${entry.database}` : "";
  return `${entry.host ?? ""}${port}${database}`;
}

function toInfo(entry: StoredConnection): DatabaseInfo {
  return {
    id: entry.id,
    engine: entry.engine,
    displayName: entry.displayName,
    target: formatTarget(entry),
    state: entry.state,
    serverVersion: entry.serverVersion,
    lastError: entry.lastError,
    lastSeen_ms: entry.lastSeen_ms,
    currentDatabase: entry.database,
  };
}

/** The composite databaseId of a child database opened on a connection. */
function childDatabaseId(parentId: string, database: string): string {
  return `${parentId}::${database}`;
}

/** DatabaseInfo for a child database (a database opened on a parent connection). */
function childInfo(
  parent: StoredConnection,
  database: string,
  state: DatabaseConnectionState,
  serverVersion?: string,
  lastError?: string,
): DatabaseInfo {
  const port = parent.port ? `:${parent.port}` : "";
  return {
    id: childDatabaseId(parent.id, database),
    engine: parent.engine,
    displayName: database,
    target: `${parent.host ?? ""}${port}/${database}`,
    state,
    serverVersion,
    lastError,
    currentDatabase: database,
  };
}
