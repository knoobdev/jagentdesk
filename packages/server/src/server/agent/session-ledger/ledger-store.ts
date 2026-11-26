import { promises as fs } from "node:fs";
import type { Logger } from "pino";
import { writeJsonFileAtomic } from "../../atomic-file.js";
import {
  emptySessionLedger,
  StoredSessionLedgerSchema,
  type StoredSessionLedger,
} from "./ledger-schema.js";

/** Resolves the ledger file of an agent; it sits next to the agent record. */
export type LedgerPathResolver = (agentId: string) => Promise<string | null>;

/**
 * File-backed session ledgers, one `<agentId>.ledger.json` next to each agent record. Writes for
 * one agent are serialized so concurrent tool calls and handoffs never lose an update.
 */
export class SessionLedgerStore {
  private readonly cache = new Map<string, StoredSessionLedger>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly logger: Logger;

  constructor(
    private readonly resolvePath: LedgerPathResolver,
    logger: Logger,
  ) {
    this.logger = logger.child({ module: "agent", component: "session-ledger" });
  }

  async read(agentId: string): Promise<StoredSessionLedger> {
    await (this.queues.get(agentId) ?? Promise.resolve()).catch(() => undefined);
    return this.load(agentId);
  }

  update(
    agentId: string,
    mutate: (ledger: StoredSessionLedger) => StoredSessionLedger | Promise<StoredSessionLedger>,
  ): Promise<StoredSessionLedger> {
    const previous = this.queues.get(agentId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const current = await this.load(agentId);
        const updated = StoredSessionLedgerSchema.parse(await mutate(current));
        const filePath = await this.resolvePath(agentId);
        if (filePath) await writeJsonFileAtomic(filePath, updated);
        this.cache.set(agentId, updated);
        return updated;
      });
    const tracked = next.finally(() => {
      if (this.queues.get(agentId) === tracked) this.queues.delete(agentId);
    });
    this.queues.set(agentId, tracked);
    return tracked;
  }

  forget(agentId: string): void {
    this.cache.delete(agentId);
  }

  private async load(agentId: string): Promise<StoredSessionLedger> {
    const cached = this.cache.get(agentId);
    if (cached) return cached;
    const filePath = await this.resolvePath(agentId);
    let ledger = emptySessionLedger(agentId);
    if (filePath) {
      try {
        const parsed = StoredSessionLedgerSchema.safeParse(
          JSON.parse(await fs.readFile(filePath, "utf8")),
        );
        if (parsed.success) ledger = parsed.data;
        else this.logger.warn({ agentId, filePath }, "Ignoring invalid session ledger");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.logger.warn({ err: error, agentId, filePath }, "Failed to read session ledger");
        }
      }
    }
    this.cache.set(agentId, ledger);
    return ledger;
  }
}
