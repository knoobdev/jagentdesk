import { MongoClient, type Db } from "mongodb";
import type { DbClient, DbConnectionConfig, RunQueryOptions } from "../db-client.js";
import type {
  DbColumn,
  DbObject,
  DbSchema,
  QueryResult,
  ResultColumn,
  WriteResult,
} from "../database-dto.js";

const DEFAULT_LIMIT = 200;
const SAMPLE_SIZE = 50;
const SYSTEM_DBS = new Set(["admin", "local", "config"]);

interface FindSpec {
  collection: string;
  filter?: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  skip?: number;
}

/**
 * MongoDB adapter. Mongo is a document store, not SQL — so this maps the shared
 * DbClient contract onto collections: schemas→databases, objects→collections,
 * columns→sampled top-level fields. A "query" is either the grid's generated
 * `select * from "db"."coll"` (translated to a find) or a JSON find spec typed in
 * the console. The row editor is disabled for it (writes go through the console's
 * JSON ops or the chat agent).
 */
export class MongoDbClient implements DbClient {
  private client: MongoClient | null = null;
  private readonly config: DbConnectionConfig;
  private readonly defaultDb: string;

  constructor(config: DbConnectionConfig) {
    this.config = config;
    this.defaultDb = config.database ?? "test";
  }

  private require(): MongoClient {
    if (!this.client) throw new Error("MongoDB connection is not open");
    return this.client;
  }

  private db(name?: string): Db {
    return this.require().db(name ?? this.defaultDb);
  }

  async connect(): Promise<void> {
    const uri =
      this.config.dsn ??
      `mongodb://${this.credentials()}${this.config.host ?? "127.0.0.1"}:${this.config.port ?? 27017}`;
    this.client = new MongoClient(uri);
    await this.client.connect();
    await this.client.db(this.defaultDb).command({ ping: 1 });
  }

  private credentials(): string {
    if (!this.config.user) return "";
    const pw = this.config.password ? `:${encodeURIComponent(this.config.password)}` : "";
    return `${encodeURIComponent(this.config.user)}${pw}@`;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async serverVersion(): Promise<string> {
    const info = (await this.db().admin().serverInfo()) as { version?: string };
    return info.version ? `MongoDB ${info.version}` : "MongoDB";
  }

  async listSchemas(): Promise<DbSchema[]> {
    const res = await this.require().db().admin().listDatabases();
    return res.databases
      .map((d) => ({ name: String(d.name) }))
      .filter((s) => !SYSTEM_DBS.has(s.name));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const cols = await this.db(schema).listCollections().toArray();
    return cols.map((c) => ({ schema, name: String(c.name), kind: "collection" as const }));
  }

  async listColumns(schema: string, table: string): Promise<DbColumn[]> {
    const docs = await this.db(schema).collection(table).find({}, { limit: SAMPLE_SIZE }).toArray();
    const types = new Map<string, string>();
    for (const doc of docs) {
      for (const [key, value] of Object.entries(doc)) {
        if (!types.has(key)) types.set(key, mongoType(value));
      }
    }
    return Array.from(types.entries()).map(([name, dataType]) => ({
      name,
      dataType,
      nullable: name !== "_id",
      isPrimaryKey: name === "_id",
      isForeignKey: false,
      defaultValue: null,
    }));
  }

  async runQuery(sql: string, options?: RunQueryOptions): Promise<QueryResult> {
    const started = nowMs();
    const limit = options?.limit ?? DEFAULT_LIMIT;
    const offset = options?.offset ?? 0;
    const spec = parseFindSpec(sql);
    const docs = await this.db()
      .collection(spec.collection)
      .find(spec.filter ?? {}, {
        ...(spec.sort ? { sort: spec.sort } : {}),
        skip: spec.skip ?? offset,
        limit: (spec.limit ?? limit) + 1,
      })
      .toArray();
    return tabulate(docs, spec.limit ?? limit, started);
  }

  async explain(sql: string): Promise<QueryResult> {
    const started = nowMs();
    const spec = parseFindSpec(sql);
    const plan = await this.db()
      .collection(spec.collection)
      .find(spec.filter ?? {})
      .explain();
    return {
      columns: [{ name: "queryPlan" }],
      rows: [[JSON.stringify(plan)]],
      rowCount: 1,
      truncated: false,
      elapsedMs: nowMs() - started,
    };
  }

  async execWrite(sql: string): Promise<WriteResult> {
    const started = nowMs();
    const op = JSON.parse(sql) as {
      collection: string;
      insert?: Record<string, unknown> | Record<string, unknown>[];
      update?: { filter: Record<string, unknown>; set: Record<string, unknown> };
      delete?: Record<string, unknown>;
    };
    const coll = this.db().collection(op.collection);
    let affected = 0;
    if (op.insert) {
      const res = Array.isArray(op.insert)
        ? await coll.insertMany(op.insert)
        : await coll.insertOne(op.insert);
      affected = "insertedCount" in res ? res.insertedCount : 1;
    } else if (op.update) {
      const res = await coll.updateMany(op.update.filter, { $set: op.update.set });
      affected = res.modifiedCount;
    } else if (op.delete) {
      const res = await coll.deleteMany(op.delete);
      affected = res.deletedCount;
    } else {
      throw new Error("Mongo exec expects JSON { collection, insert|update|delete }");
    }
    return { affected, elapsedMs: nowMs() - started };
  }

  async begin(): Promise<void> {
    // Mongo transactions are session-scoped and not exposed by this per-connection
    // model; the editor gates Manual tx off for it.
  }
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
}

function mongoType(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "date";
  if (typeof value === "object") return "object";
  return typeof value;
}

/** Accept either a JSON find spec or the grid's `select * from "db"."coll"`. */
function parseFindSpec(sql: string): FindSpec {
  const trimmed = sql.trim();
  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as FindSpec;
    if (!parsed.collection) throw new Error("Mongo query JSON needs a collection");
    return parsed;
  }
  // Extract the last identifier of a `from "schema"."collection"` / `from coll`.
  const match = /from\s+(?:"?[^".\s]+"?\.)?"?([A-Za-z0-9_$]+)"?/i.exec(trimmed);
  if (!match) throw new Error("Could not resolve a collection from the query");
  return { collection: match[1] };
}

function tabulate(docs: Record<string, unknown>[], limit: number, started: number): QueryResult {
  const truncated = docs.length > limit;
  const kept = truncated ? docs.slice(0, limit) : docs;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const doc of kept) {
    for (const key of Object.keys(doc)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  const columns: ResultColumn[] = names.map((name) => ({ name }));
  const rows = kept.map((doc) => names.map((name) => cell(doc[name])));
  return { columns, rows, rowCount: rows.length, truncated, elapsedMs: nowMs() - started };
}

function cell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return value as string | number | boolean;
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
