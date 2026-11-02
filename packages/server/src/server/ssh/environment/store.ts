import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ServerEnvironmentSchema,
  type ServerEnvironment,
} from "@jagentdesk/protocol/ssh/environment-schemas";
import { writePrivateFileAtomicSync } from "../../private-files.js";

/**
 * Where detected environments live. Spec 25.10 keeps one per server next to the server record;
 * the owner of `servers.json` can implement this over that file, and `FileEnvironmentStore`
 * keeps the module usable on its own.
 */
export interface EnvironmentStore {
  read(serverId: string): ServerEnvironment | null;
  write(environment: ServerEnvironment): void;
  remove(serverId: string): void;
}

const EnvironmentFileSchema = z.record(z.string(), ServerEnvironmentSchema);

/** `$JAGENTDESK_HOME/ssh/environments.json`, written atomically with mode 0600. */
export class FileEnvironmentStore implements EnvironmentStore {
  private readonly filePath: string;
  private environments: Map<string, ServerEnvironment>;

  constructor(jagentdeskHome: string) {
    this.filePath = path.join(jagentdeskHome, "ssh", "environments.json");
    this.environments = new Map(Object.entries(this.load()));
  }

  read(serverId: string): ServerEnvironment | null {
    return this.environments.get(serverId) ?? null;
  }

  write(environment: ServerEnvironment): void {
    this.environments.set(environment.serverId, environment);
    this.persist();
  }

  remove(serverId: string): void {
    if (!this.environments.delete(serverId)) return;
    this.persist();
  }

  private load(): Record<string, ServerEnvironment> {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
    return EnvironmentFileSchema.parse(JSON.parse(raw));
  }

  private persist(): void {
    const snapshot = Object.fromEntries(this.environments);
    writePrivateFileAtomicSync(this.filePath, JSON.stringify(snapshot, null, 2));
  }
}
