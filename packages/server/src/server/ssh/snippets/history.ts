import path from "node:path";
import { z } from "zod";
import {
  SshCommandHistoryEntrySchema,
  type SshCommandHistoryEntry,
  type SshCommandSource,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { WriteQueue, readSecureJson, writeSecureJsonAtomic } from "./secure-file.js";

export const HISTORY_LIMIT_PER_SERVER = 500;

const HistoryFileSchema = z.record(z.string(), z.array(SshCommandHistoryEntrySchema));
type HistoryFile = z.infer<typeof HistoryFileSchema>;

/**
 * Per-server command history (spec 25.7) in `history.json`, newest first. Only
 * commands sent through JAgentDesk are recorded; the server's history file is never read.
 */
export class CommandHistory {
  private readonly filePath: string;
  private readonly queue = new WriteQueue();

  constructor(
    sshHome: string,
    private readonly now: () => number,
  ) {
    this.filePath = path.join(sshHome, "history.json");
  }

  async list(serverId: string): Promise<SshCommandHistoryEntry[]> {
    const file = await this.read();
    return file[serverId] ?? [];
  }

  record(params: {
    serverIds: readonly string[];
    command: string;
    source: SshCommandSource;
  }): Promise<void> {
    const command = params.command.trim();
    if (command === "") return Promise.resolve();
    return this.queue.run(async () => {
      const file = await this.read();
      const atMs = this.now();
      for (const serverId of params.serverIds) {
        const previous = (file[serverId] ?? []).filter((entry) => entry.command !== command);
        file[serverId] = [{ command, source: params.source, atMs }, ...previous].slice(
          0,
          HISTORY_LIMIT_PER_SERVER,
        );
      }
      await writeSecureJsonAtomic(this.filePath, file);
    });
  }

  clear(serverId: string): Promise<void> {
    return this.queue.run(async () => {
      const file = await this.read();
      delete file[serverId];
      await writeSecureJsonAtomic(this.filePath, file);
    });
  }

  private read(): Promise<HistoryFile> {
    return readSecureJson(this.filePath, HistoryFileSchema, {});
  }
}
