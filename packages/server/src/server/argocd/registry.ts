import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  ArgoCdAuthMethodSchema,
  ArgoCdClusterLinkSchema,
  type ArgoCdClusterLink,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";

// Spec 30.1: `$JAGENTDESK_HOME/argocd/instances.json` and `cluster-links.json`, 0600 files in a
// 0700 directory, written atomically. Identity only — every secret lives in the FileSecretStore
// of the same directory.

const StoredInstanceSchema = z.object({
  id: z.string(),
  url: z.string(),
  displayName: z.string(),
  authMethod: ArgoCdAuthMethodSchema,
  username: z.string().nullable(),
  tlsSkipVerify: z.boolean(),
  caPem: z.string().nullable(),
  headers: z.array(z.string()), // names; values are secrets
  rememberPassword: z.boolean(),
  createdAt_ms: z.number(),
});
export type StoredArgoCdInstance = z.infer<typeof StoredInstanceSchema>;

const InstancesFileSchema = z.array(StoredInstanceSchema);
const LinksFileSchema = z.array(ArgoCdClusterLinkSchema);

export function newInstanceId(): string {
  return `acd_${randomBytes(6).toString("hex")}`;
}

async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export class ArgoCdRegistry {
  private readonly instances = new Map<string, StoredArgoCdInstance>();
  private links: ArgoCdClusterLink[] = [];
  private readonly instancesPath: string;
  private readonly linksPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly directory: string) {
    this.instancesPath = path.join(directory, "instances.json");
    this.linksPath = path.join(directory, "cluster-links.json");
  }

  async initialize(): Promise<void> {
    ensurePrivateDirectory(this.directory);
    const instances = await readJson(this.instancesPath);
    if (instances !== null) {
      for (const instance of InstancesFileSchema.parse(instances)) {
        this.instances.set(instance.id, instance);
      }
    }
    const links = await readJson(this.linksPath);
    if (links !== null) this.links = LinksFileSchema.parse(links);
  }

  list(): StoredArgoCdInstance[] {
    return [...this.instances.values()].sort((a, b) => a.createdAt_ms - b.createdAt_ms);
  }

  get(id: string): StoredArgoCdInstance | null {
    return this.instances.get(id) ?? null;
  }

  async upsert(instance: StoredArgoCdInstance): Promise<void> {
    this.instances.set(instance.id, instance);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.instances.delete(id);
    this.links = this.links.filter((link) => link.instanceId !== id);
    await this.persist();
  }

  listLinks(instanceId?: string): ArgoCdClusterLink[] {
    return this.links.filter((link) => !instanceId || link.instanceId === instanceId);
  }

  findLink(instanceId: string, destination: string): ArgoCdClusterLink | null {
    return (
      this.links.find(
        (link) => link.instanceId === instanceId && link.destination === destination,
      ) ?? null
    );
  }

  async setLink(
    instanceId: string,
    destination: string,
    link: ArgoCdClusterLink | null,
  ): Promise<void> {
    this.links = this.links.filter(
      (entry) => !(entry.instanceId === instanceId && entry.destination === destination),
    );
    if (link) this.links.push(link);
    await this.persist();
  }

  private write(instances: StoredArgoCdInstance[], links: ArgoCdClusterLink[]): void {
    writePrivateFileAtomicSync(this.instancesPath, JSON.stringify(instances, null, 2));
    writePrivateFileAtomicSync(this.linksPath, JSON.stringify(links, null, 2));
  }

  private persist(): Promise<void> {
    const instances = this.list();
    const links = [...this.links];
    const run = this.writeQueue.then(() => this.write(instances, links));
    this.writeQueue = run.catch(() => undefined);
    return run;
  }
}
