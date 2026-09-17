import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  StoredForumTopicSchema,
  type StoredForumTopic,
} from "@jagentdesk/protocol/agent-forum/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

// Flat JSON-per-topic store at ~/.jagentdesk/forums/{topicId}.json. `projectKey` lives on the record
// (for filtering), so get-by-id needs no directory lookup. Mutations are serialized per topic so a
// concurrent message-append + task-move never clobber each other, and writes are atomic.
export function generateForumId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString("hex")}`;
}

type TopicUpdater = (topic: StoredForumTopic) => StoredForumTopic | Promise<StoredForumTopic>;

export class AgentForumStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  async list(): Promise<StoredForumTopic[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir, { withFileTypes: true });
    const topics = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(async (entry) => {
          try {
            const content = await readFile(join(this.dir, entry.name), "utf-8");
            return StoredForumTopicSchema.parse(JSON.parse(content));
          } catch {
            return null;
          }
        }),
    );
    return topics
      .filter((t): t is StoredForumTopic => t !== null)
      .sort((a, b) => b.updatedAt_ms - a.updatedAt_ms);
  }

  async get(id: string): Promise<StoredForumTopic | null> {
    await this.ensureDir();
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      return StoredForumTopicSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async create(topic: StoredForumTopic): Promise<StoredForumTopic> {
    const parsed = StoredForumTopicSchema.parse(topic);
    await this.write(parsed);
    return parsed;
  }

  // Serialized read-modify-write. Returns null if the topic is gone.
  async update(id: string, updater: TopicUpdater): Promise<StoredForumTopic | null> {
    return this.serialize(id, async () => {
      const current = await this.get(id);
      if (!current) return null;
      const next = await updater(current);
      if (next.id !== id) throw new Error(`Forum topic update cannot change id: ${id}`);
      const updated = StoredForumTopicSchema.parse(next);
      await this.write(updated);
      return updated;
    });
  }

  async delete(id: string): Promise<void> {
    await this.serialize(id, async () => {
      await this.ensureDir();
      await rm(this.filePath(id), { force: true });
    });
  }

  private async write(topic: StoredForumTopic): Promise<void> {
    await this.ensureDir();
    await writeJsonFileAtomic(this.filePath(topic.id), topic);
  }

  private async serialize<T>(key: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(key, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(key) === next) this.mutations.delete(key);
    }
  }
}
