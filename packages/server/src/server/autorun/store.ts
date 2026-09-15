import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AutorunStateSchema, type AutorunState } from "@jagentdesk/protocol/messages";

// Durable per-agent autonomous state (spec §20 / ADR-0017). Autonomous mode is a switch on
// an existing agent, so state is keyed by agentId. The "done items" record lives here (not
// in agent context) so it survives daemon restart + compaction — that is what stops the
// agent repeating work it already did. One JSON file per agent under
// `$JAGENTDESK_HOME/autoruns/{agentId}.json`.

export type AutorunUpdater = (current: AutorunState) => AutorunState;

export class AutorunStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private filePath(agentId: string): string {
    return join(this.dir, `${encodeURIComponent(agentId)}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private async write(state: AutorunState): Promise<void> {
    await this.ensureDir();
    await writeFile(this.filePath(state.agentId), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  }

  async list(): Promise<AutorunState[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const states = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const content = await readFile(join(this.dir, entry.name), "utf-8");
          return AutorunStateSchema.parse(JSON.parse(content));
        }),
    );
    return states.sort((a, b) => (b.updatedAt_ms ?? 0) - (a.updatedAt_ms ?? 0));
  }

  async get(agentId: string): Promise<AutorunState | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(agentId), "utf-8");
      return AutorunStateSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(state: AutorunState): Promise<AutorunState> {
    const parsed = AutorunStateSchema.parse(state);
    await this.write(parsed);
    return parsed;
  }

  // Serialize per-agent read-modify-write so the driver loop + a concurrent control RPC
  // (stop) can't clobber each other's update. Returns null if no state exists yet.
  async update(agentId: string, updater: AutorunUpdater): Promise<AutorunState | null> {
    const prior = this.mutations.get(agentId) ?? Promise.resolve();
    const next = prior.then(async () => {
      const current = await this.get(agentId);
      if (!current) return null;
      const updated = AutorunStateSchema.parse(updater(current));
      if (updated.agentId !== agentId) {
        throw new Error(`Autorun update cannot change agentId: ${agentId}`);
      }
      await this.write(updated);
      return updated;
    });
    this.mutations.set(
      agentId,
      next.catch(() => undefined),
    );
    return next;
  }

  async delete(agentId: string): Promise<void> {
    await this.ensureDir();
    await rm(this.filePath(agentId), { force: true });
  }
}
