import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { DatabaseEngine, DatabaseInfo, DatabaseConnectionState } from "./database-dto.js";
import type { DbClient, DbConnectionConfig } from "./db-client.js";
import { SqliteDbClient } from "./adapters/sqlite.js";
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
  private clients: Map<string, DbClient> = new Map();
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
    entry.state = "connecting";
    try {
      const secret = await this.secrets.get(id);
      const config: DbConnectionConfig = {
        host: entry.host,
        port: entry.port,
        database: entry.database,
        user: entry.user,
        file: entry.file,
        options: entry.options,
        ...secretFields(secret),
      };
      const client = createClient(entry.engine, config);
      await client.connect();
      entry.serverVersion = await client.serverVersion().catch(() => undefined);
      entry.state = "connected";
      entry.lastSeen_ms = Date.now();
      entry.lastError = undefined;
      this.clients.set(id, client);
    } catch (err) {
      entry.state = "error";
      entry.lastError = err instanceof Error ? err.message : String(err);
    }
    return toInfo(entry);
  }

  async disconnect(id: string): Promise<void> {
    const client = this.clients.get(id);
    if (client) {
      await client.close().catch(() => undefined);
      this.clients.delete(id);
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
    default:
      // postgres/mysql/… adapters land in P1; keep the switch exhaustive-friendly.
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

function secretFields(secret: string | null): Partial<DbConnectionConfig> {
  if (!secret) return {};
  return isDsn(secret) ? { dsn: secret } : { password: secret };
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
  };
}
