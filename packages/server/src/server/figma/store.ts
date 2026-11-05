import { promises as fs } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import {
  FigmaConnectionSchema,
  FigmaFileSchema,
  FigmaTeamSchema,
  type FigmaConnection,
  type FigmaFile,
  type FigmaTeam,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import type { FigmaStore } from "./context.js";

// $JAGENTDESK_HOME/figma/ (spec 32.3): connections.json, files.json, teams.json. A 0700 directory
// holding 0600 files, each written atomically (temp file + rename) and only one write at a time,
// so a refresh finishing while the user pins a file cannot drop either change. Secrets (tokens,
// client secret, pairing keys) live in the FileSecretStore beside these files, not in them.

const ConnectionsFileSchema = z.object({ connections: z.array(FigmaConnectionSchema) });
const FilesFileSchema = z.object({ files: z.array(FigmaFileSchema) });
const TeamsFileSchema = z.object({ teams: z.array(FigmaTeamSchema) });

type Entity = "connections" | "files" | "teams";

const ENTITY_FILES: Record<Entity, string> = {
  connections: "connections.json",
  files: "files.json",
  teams: "teams.json",
};

export class JsonFigmaStore implements FigmaStore {
  readonly dir: string;
  private readonly logger: pino.Logger;
  // One writer at a time; every mutation is a read-modify-write over its file, so reads that
  // join the queue see the committed state.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: { jagentdeskHome: string; logger: pino.Logger }) {
    this.dir = path.join(options.jagentdeskHome, "figma");
    this.logger = options.logger.child({ module: "figma-store" });
    ensurePrivateDirectory(this.dir);
  }

  private async readRows<T>(entity: Entity, parse: (raw: unknown) => T[]): Promise<T[]> {
    const filePath = path.join(this.dir, ENTITY_FILES[entity]);
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      this.logger.warn({ entity }, "figma store file is not valid JSON");
      throw new Error(`Figma ${entity} file is not valid JSON: ${(error as Error).message}`, {
        cause: error,
      });
    }
    return parse(parsed);
  }

  private writeCollection(entity: Entity, rows: unknown[]): void {
    const filePath = path.join(this.dir, ENTITY_FILES[entity]);
    writePrivateFileAtomicSync(filePath, JSON.stringify({ [entity]: rows }, null, 2));
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private readConnections(): Promise<FigmaConnection[]> {
    return this.readRows("connections", (raw) => ConnectionsFileSchema.parse(raw).connections);
  }

  private readFiles(): Promise<FigmaFile[]> {
    return this.readRows("files", (raw) => FilesFileSchema.parse(raw).files);
  }

  private readTeams(): Promise<FigmaTeam[]> {
    return this.readRows("teams", (raw) => TeamsFileSchema.parse(raw).teams);
  }

  async listConnections(): Promise<FigmaConnection[]> {
    return this.serialize(() => this.readConnections());
  }

  async getConnection(id: string): Promise<FigmaConnection | null> {
    return this.serialize(async () => {
      const connections = await this.readConnections();
      return connections.find((connection) => connection.id === id) ?? null;
    });
  }

  async saveConnection(connection: FigmaConnection): Promise<void> {
    return this.serialize(async () => {
      const connections = await this.readConnections();
      const next = upsert(connections, connection, (item) => item.id === connection.id);
      this.writeCollection("connections", next);
    });
  }

  async removeConnection(id: string): Promise<void> {
    return this.serialize(async () => {
      const connections = await this.readConnections();
      this.writeCollection(
        "connections",
        connections.filter((connection) => connection.id !== id),
      );
      // The files and teams of a removed connection are unreachable; drop them with it.
      const files = await this.readFiles();
      this.writeCollection(
        "files",
        files.filter((file) => file.connectionId !== id),
      );
      const teams = await this.readTeams();
      this.writeCollection(
        "teams",
        teams.filter((team) => team.connectionId !== id),
      );
    });
  }

  async listFiles(connectionId?: string): Promise<FigmaFile[]> {
    return this.serialize(async () => {
      const files = await this.readFiles();
      return connectionId ? files.filter((file) => file.connectionId === connectionId) : files;
    });
  }

  async getFile(fileKey: string): Promise<FigmaFile | null> {
    return this.serialize(async () => {
      const files = await this.readFiles();
      return files.find((file) => file.fileKey === fileKey) ?? null;
    });
  }

  async saveFile(file: FigmaFile): Promise<void> {
    return this.serialize(async () => {
      const files = await this.readFiles();
      this.writeCollection(
        "files",
        upsert(files, file, (item) => item.fileKey === file.fileKey),
      );
    });
  }

  async removeFile(fileKey: string): Promise<void> {
    return this.serialize(async () => {
      const files = await this.readFiles();
      this.writeCollection(
        "files",
        files.filter((file) => file.fileKey !== fileKey),
      );
    });
  }

  async listTeams(connectionId: string): Promise<FigmaTeam[]> {
    return this.serialize(async () => {
      const teams = await this.readTeams();
      return teams.filter((team) => team.connectionId === connectionId);
    });
  }

  async saveTeam(team: FigmaTeam): Promise<void> {
    return this.serialize(async () => {
      const teams = await this.readTeams();
      this.writeCollection(
        "teams",
        upsert(
          teams,
          team,
          (item) => item.teamId === team.teamId && item.connectionId === team.connectionId,
        ),
      );
    });
  }

  async removeTeam(connectionId: string, teamId: string): Promise<void> {
    return this.serialize(async () => {
      const teams = await this.readTeams();
      this.writeCollection(
        "teams",
        teams.filter((team) => !(team.connectionId === connectionId && team.teamId === teamId)),
      );
    });
  }
}

function upsert<T>(rows: T[], row: T, matches: (row: T) => boolean): T[] {
  if (!rows.some(matches)) return [...rows, row];
  return rows.map((existing) => (matches(existing) ? row : existing));
}
