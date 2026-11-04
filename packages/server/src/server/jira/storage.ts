import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  JiraConnectionSchema,
  JiraSwimlaneConfigSchema,
  type JiraConnection,
  type JiraSwimlaneConfig,
} from "@jagentdesk/protocol/jira/rpc-schemas";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";

// $JAGENTDESK_HOME/jira/ (spec 29.2): connections.json and swimlanes.json, 0600 files in a 0700
// directory, written atomically. Neither file holds a secret; secrets live in the FileSecretStore
// (jira/secrets.json) owned by JiraCredentialManager.

export const JIRA_CONNECTION_ID_PREFIX = "jir_";

// OAuth app identity kept beside the connection; the client secret is in the secret store.
const StoredConnectionSchema = JiraConnectionSchema.extend({
  oauthClientId: z.string().optional(),
  // Cloud API token connections authenticate as this email (Basic auth); not a secret.
  email: z.string().optional(),
  timeZone: z.string().optional(),
});
export type StoredJiraConnection = z.infer<typeof StoredConnectionSchema>;

const ConnectionsFileSchema = z.object({ connections: z.array(StoredConnectionSchema) });
const SwimlanesFileSchema = z.object({
  boards: z.record(z.string(), JiraSwimlaneConfigSchema),
});

export function generateJiraConnectionId(): string {
  return `${JIRA_CONNECTION_ID_PREFIX}${randomBytes(6).toString("hex")}`;
}

export function toWireConnection(stored: StoredJiraConnection): JiraConnection {
  const { oauthClientId: _client, email: _email, timeZone: _tz, ...wire } = stored;
  return wire;
}

const DEFAULT_SWIMLANES: JiraSwimlaneConfig = { mode: "none", queries: [] };

export class JiraStorage {
  readonly dir: string;
  private readonly connectionsPath: string;
  private readonly swimlanesPath: string;
  private connections: StoredJiraConnection[] | null = null;
  // One writer at a time: concurrent updates (a refresh finishing while the user renames a
  // connection) must not drop each other's change.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(jagentdeskHome: string) {
    this.dir = path.join(jagentdeskHome, "jira");
    this.connectionsPath = path.join(this.dir, "connections.json");
    this.swimlanesPath = path.join(this.dir, "swimlanes.json");
  }

  async initialize(): Promise<void> {
    ensurePrivateDirectory(this.dir);
    this.connections = await this.readConnections();
  }

  private async readJson(filePath: string): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readConnections(): Promise<StoredJiraConnection[]> {
    const raw = await this.readJson(this.connectionsPath);
    if (raw === null) return [];
    return ConnectionsFileSchema.parse(raw).connections;
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  list(): StoredJiraConnection[] {
    if (!this.connections) throw new Error("JiraStorage used before initialize()");
    return [...this.connections];
  }

  get(id: string): StoredJiraConnection | null {
    return this.list().find((connection) => connection.id === id) ?? null;
  }

  private writeConnections(next: StoredJiraConnection[]): void {
    writePrivateFileAtomicSync(
      this.connectionsPath,
      JSON.stringify({ connections: next }, null, 2),
    );
    this.connections = next;
  }

  add(connection: StoredJiraConnection): Promise<StoredJiraConnection> {
    return this.serialize(async () => {
      this.writeConnections([...this.list(), connection]);
      return connection;
    });
  }

  update(
    id: string,
    patch: Partial<Omit<StoredJiraConnection, "id">>,
  ): Promise<StoredJiraConnection | null> {
    return this.serialize(async () => {
      const current = this.get(id);
      if (!current) return null;
      const next: StoredJiraConnection = { ...current, ...patch };
      if (patch.lastError === undefined && "lastError" in patch) delete next.lastError;
      this.writeConnections(this.list().map((c) => (c.id === id ? next : c)));
      return next;
    });
  }

  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      this.writeConnections(this.list().filter((connection) => connection.id !== id));
      await this.removeSwimlanesFor(id);
    });
  }

  private async readSwimlanes(): Promise<Record<string, JiraSwimlaneConfig>> {
    const raw = await this.readJson(this.swimlanesPath);
    return raw === null ? {} : SwimlanesFileSchema.parse(raw).boards;
  }

  async getSwimlanes(connectionId: string, boardId: number): Promise<JiraSwimlaneConfig> {
    const boards = await this.readSwimlanes();
    return boards[`${connectionId}:${boardId}`] ?? DEFAULT_SWIMLANES;
  }

  setSwimlanes(
    connectionId: string,
    boardId: number,
    config: JiraSwimlaneConfig,
  ): Promise<JiraSwimlaneConfig> {
    return this.serialize(async () => {
      const boards = await this.readSwimlanes();
      boards[`${connectionId}:${boardId}`] = config;
      writePrivateFileAtomicSync(this.swimlanesPath, JSON.stringify({ boards }, null, 2));
      return config;
    });
  }

  private async removeSwimlanesFor(connectionId: string): Promise<void> {
    const boards = await this.readSwimlanes();
    const kept = Object.fromEntries(
      Object.entries(boards).filter(([key]) => !key.startsWith(`${connectionId}:`)),
    );
    if (Object.keys(kept).length === Object.keys(boards).length) return;
    writePrivateFileAtomicSync(this.swimlanesPath, JSON.stringify({ boards: kept }, null, 2));
  }
}
