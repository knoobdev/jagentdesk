import {
  FigmaConnectionSchema,
  type FigmaConnection,
  type FigmaFile,
  type FigmaTeam,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaStore } from "../context.js";

// In-memory FigmaStore for tests (W3 ships the JSON-file implementation). saveConnection validates
// through the wire schema, so a connection the app could not parse fails the tests here.

export class MemoryFigmaStore implements FigmaStore {
  readonly connections = new Map<string, FigmaConnection>();
  readonly files = new Map<string, FigmaFile>();
  readonly teams = new Map<string, FigmaTeam>();

  async listConnections(): Promise<FigmaConnection[]> {
    return [...this.connections.values()];
  }
  async getConnection(id: string): Promise<FigmaConnection | null> {
    return this.connections.get(id) ?? null;
  }
  async saveConnection(connection: FigmaConnection): Promise<void> {
    this.connections.set(connection.id, FigmaConnectionSchema.parse(connection));
  }
  async removeConnection(id: string): Promise<void> {
    this.connections.delete(id);
  }
  async listFiles(connectionId?: string): Promise<FigmaFile[]> {
    return [...this.files.values()].filter(
      (file) => connectionId === undefined || file.connectionId === connectionId,
    );
  }
  async getFile(fileKey: string): Promise<FigmaFile | null> {
    return this.files.get(fileKey) ?? null;
  }
  async saveFile(file: FigmaFile): Promise<void> {
    this.files.set(file.fileKey, file);
  }
  async removeFile(fileKey: string): Promise<void> {
    this.files.delete(fileKey);
  }
  async listTeams(connectionId: string): Promise<FigmaTeam[]> {
    return [...this.teams.values()].filter((team) => team.connectionId === connectionId);
  }
  async saveTeam(team: FigmaTeam): Promise<void> {
    this.teams.set(`${team.connectionId}/${team.teamId}`, team);
  }
  async removeTeam(connectionId: string, teamId: string): Promise<void> {
    this.teams.delete(`${connectionId}/${teamId}`);
  }
}
