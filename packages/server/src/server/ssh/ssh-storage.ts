import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import type {
  SshGroup,
  SshIdentity,
  SshKey,
  SshKnownHost,
  SshServer,
} from "@jagentdesk/protocol/ssh/rpc-schemas";
import {
  SshGroupSchema,
  SshIdentitySchema,
  SshKeySchema,
  SshKnownHostSchema,
  SshServerSchema,
} from "@jagentdesk/protocol/ssh/rpc-schemas";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import { FileSecretStore, MemorySecretStore, type SecretStore } from "../database/secret-store.js";
import { knownHostId, sameHostPort } from "./known-hosts.js";

// SSH config lives under <jagentdeskHome>/ssh/ (spec 25.2): plain-JSON files for
// metadata (servers, groups, identities, keys, known_hosts) written atomically with
// 0600 in a 0700 directory, plus the encrypted SecretStore (ssh/secrets.json) for
// passwords, private keys, passphrases and proxy passwords. The JSON files never
// contain a secret: wire-only booleans (`hasPassword`, `hasPassphrase` is metadata)
// are stripped before persisting and recomputed from the store on read.

export const SSH_SERVER_ID_PREFIX = "srv_";
export const SSH_GROUP_ID_PREFIX = "grp_";
export const SSH_IDENTITY_ID_PREFIX = "idn_";
export const SSH_KEY_ID_PREFIX = "key_";

export function sshPasswordKey(entityId: string): string {
  return `ssh.password.${entityId}`;
}
export function sshSecretKey(keyId: string): string {
  return `ssh.key.${keyId}`;
}
export function sshPassphraseKey(keyId: string): string {
  return `ssh.passphrase.${keyId}`;
}
export function sshProxyKey(entityId: string): string {
  return `ssh.proxy.${entityId}`;
}

export function generateSshId(prefix: string): string {
  return `${prefix}${randomBytes(6).toString("hex")}`;
}

// Stored records keep unknown keys (`loose`): later milestones (e.g. S7 writes
// `environment` into servers.json, spec 25.10) must survive an S1 save.
const StoredServerSchema = SshServerSchema.extend({
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
}).loose();
export type StoredServer = z.infer<typeof StoredServerSchema>;

const SERVER_KNOWN_KEYS = new Set(Object.keys(SshServerSchema.shape));

const SnippetFileSchema = z.array(
  z.object({ id: z.string(), label: z.string().optional(), script: z.string() }).loose(),
);

export interface SshStorageOptions {
  jagentdeskHome?: string;
  logger?: Logger;
  secretStore?: SecretStore;
}

export interface SshKeyMaterial {
  privateKey: string;
  passphrase: string | null;
}

function stripWireOnly<T extends { hasPassword?: boolean }>(value: T): T {
  const { hasPassword: _drop, ...rest } = value;
  return rest as T;
}

function stripProxyWireOnly<T extends { proxy?: { hasPassword?: boolean } }>(value: T): T {
  if (!value.proxy) return value;
  const { hasPassword: _drop, ...proxy } = value.proxy;
  return { ...value, proxy };
}

/**
 * File-backed registry for SSH servers, groups, identities, keys, and known hosts.
 * Mirrors DatabaseRegistry: zod-validated persistence, a serialized persist queue,
 * and secrets delegated to the encrypted SecretStore.
 */
export class SshStorage {
  private readonly servers = new Map<string, StoredServer>();
  private readonly groups = new Map<string, SshGroup>();
  private readonly identities = new Map<string, SshIdentity>();
  private readonly keys = new Map<string, SshKey>();
  private readonly knownHosts = new Map<string, SshKnownHost>();
  readonly secrets: SecretStore;
  readonly dir: string | null;
  private readonly logger: Logger | null;
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(options: SshStorageOptions = {}) {
    this.dir = options.jagentdeskHome ? path.join(options.jagentdeskHome, "ssh") : null;
    this.logger = options.logger ?? null;
    this.secrets =
      options.secretStore ?? (this.dir ? new FileSecretStore(this.dir) : new MemorySecretStore());
  }

  /** Load every collection from disk. Missing files are an empty state, not an error. */
  async initialize(): Promise<void> {
    if (!this.dir) return;
    ensurePrivateDirectory(this.dir);
    this.servers.clear();
    this.groups.clear();
    this.identities.clear();
    this.keys.clear();
    this.knownHosts.clear();
    for (const server of await this.readJson("servers.json", z.array(StoredServerSchema))) {
      this.servers.set(server.id, server);
    }
    for (const group of await this.readJson("groups.json", z.array(SshGroupSchema))) {
      this.groups.set(group.id, group);
    }
    for (const identity of await this.readJson("identities.json", z.array(SshIdentitySchema))) {
      this.identities.set(identity.id, identity);
    }
    for (const key of await this.readJson("keys.json", z.array(SshKeySchema))) {
      this.keys.set(key.id, key);
    }
    for (const host of await this.readJson("known_hosts.json", z.array(SshKnownHostSchema))) {
      this.knownHosts.set(knownHostId(host.host, host.port, host.keyType), host);
    }
  }

  private async readJson<T>(fileName: string, schema: z.ZodType<T[]>): Promise<T[]> {
    if (!this.dir) return [];
    try {
      const raw = await fs.readFile(path.join(this.dir, fileName), "utf8");
      return schema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger?.error({ err: error, fileName }, "Failed to load ssh state");
      }
      return [];
    }
  }

  private schedulePersist(fileName: string, snapshot: unknown): void {
    if (!this.dir) return;
    const filePath = path.join(this.dir, fileName);
    const data = JSON.stringify(snapshot, null, 2);
    this.persistQueue = this.persistQueue
      .then(() => writePrivateFileAtomicSync(filePath, data))
      .catch((error) => {
        this.logger?.error({ err: error, filePath }, "Failed to persist ssh state");
      });
  }

  /** Await every queued write (tests + shutdown). */
  flush(): Promise<void> {
    return this.persistQueue;
  }

  // ── servers ────────────────────────────────────────────────────────────

  listServers(): StoredServer[] {
    return Array.from(this.servers.values());
  }

  getServer(id: string): StoredServer | undefined {
    return this.servers.get(id);
  }

  /** Upsert. Existing ids update in place (createdAtMs and unknown fields kept);
   *  anything else is a create under a daemon-generated id. */
  saveServer(server: SshServer, nowMs = Date.now()): StoredServer {
    const previous = server.id ? this.servers.get(server.id) : undefined;
    const extras: Record<string, unknown> = {};
    if (previous) {
      for (const [key, value] of Object.entries(previous)) {
        if (!SERVER_KNOWN_KEYS.has(key)) extras[key] = value;
      }
    }
    const clean = stripProxyWireOnly(stripWireOnly(server));
    const stored: StoredServer = {
      ...extras,
      ...clean,
      id: previous ? previous.id : generateSshId(SSH_SERVER_ID_PREFIX),
      createdAtMs: previous?.createdAtMs ?? nowMs,
      updatedAtMs: nowMs,
    };
    this.servers.set(stored.id, stored);
    this.persistServers();
    return stored;
  }

  /** Merge daemon-owned fields (e.g. S7 `environment`) without touching user config. */
  patchServerExtras(id: string, extras: Record<string, unknown>): StoredServer | undefined {
    const previous = this.servers.get(id);
    if (!previous) return undefined;
    const next: StoredServer = { ...previous };
    for (const [key, value] of Object.entries(extras)) {
      if (SERVER_KNOWN_KEYS.has(key)) continue;
      (next as Record<string, unknown>)[key] = value;
    }
    this.servers.set(id, next);
    this.persistServers();
    return next;
  }

  async deleteServer(id: string): Promise<void> {
    if (!this.servers.delete(id)) return;
    // Drop the deleted server from every jump chain that used it.
    for (const server of this.servers.values()) {
      if (server.jumpChain?.includes(id)) {
        this.servers.set(server.id, {
          ...server,
          jumpChain: server.jumpChain.filter((hop) => hop !== id),
        });
      }
    }
    for (const group of this.groups.values()) {
      if (group.jumpChain?.includes(id)) {
        this.groups.set(group.id, {
          ...group,
          jumpChain: group.jumpChain.filter((hop) => hop !== id),
        });
      }
    }
    await this.secrets.delete(sshPasswordKey(id)).catch(() => undefined);
    await this.secrets.delete(sshProxyKey(id)).catch(() => undefined);
    this.persistServers();
    this.persistGroups();
  }

  private persistServers(): void {
    this.schedulePersist("servers.json", Array.from(this.servers.values()));
  }

  // ── groups ─────────────────────────────────────────────────────────────

  listGroups(): SshGroup[] {
    return Array.from(this.groups.values());
  }

  getGroup(id: string): SshGroup | undefined {
    return this.groups.get(id);
  }

  groupMap(): Map<string, SshGroup> {
    return new Map(this.groups);
  }

  identityMap(): Map<string, SshIdentity> {
    return new Map(this.identities);
  }

  saveGroup(group: SshGroup): SshGroup {
    const id =
      group.id && this.groups.has(group.id) ? group.id : generateSshId(SSH_GROUP_ID_PREFIX);
    if (group.parentId) {
      // A parent that is the group itself or one of its descendants would create a cycle.
      let cursor: string | undefined = group.parentId;
      while (cursor) {
        if (cursor === id) throw new Error("A group cannot be nested inside itself.");
        cursor = this.groups.get(cursor)?.parentId;
      }
      if (!this.groups.has(group.parentId)) throw new Error("Parent group does not exist.");
    }
    const stored: SshGroup = { ...stripProxyWireOnly(group), id };
    this.groups.set(id, stored);
    this.persistGroups();
    return stored;
  }

  /** Children (groups and servers) move up to the deleted group's parent. */
  async deleteGroup(id: string): Promise<void> {
    const group = this.groups.get(id);
    if (!group) return;
    this.groups.delete(id);
    for (const child of this.groups.values()) {
      if (child.parentId === id) {
        const { parentId: _drop, ...rest } = child;
        this.groups.set(child.id, group.parentId ? { ...rest, parentId: group.parentId } : rest);
      }
    }
    for (const server of this.servers.values()) {
      if (server.groupId === id) {
        const { groupId: _drop, ...rest } = server;
        this.servers.set(
          server.id,
          (group.parentId ? { ...rest, groupId: group.parentId } : rest) as StoredServer,
        );
      }
    }
    await this.secrets.delete(sshProxyKey(id)).catch(() => undefined);
    this.persistGroups();
    this.persistServers();
  }

  private persistGroups(): void {
    this.schedulePersist("groups.json", Array.from(this.groups.values()));
  }

  // ── identities ─────────────────────────────────────────────────────────

  listIdentities(): SshIdentity[] {
    return Array.from(this.identities.values());
  }

  getIdentity(id: string): SshIdentity | undefined {
    return this.identities.get(id);
  }

  saveIdentity(identity: SshIdentity): SshIdentity {
    if (identity.keyId && !this.keys.has(identity.keyId)) throw new Error("Key does not exist.");
    const stored: SshIdentity = {
      ...stripWireOnly(identity),
      id:
        identity.id && this.identities.has(identity.id)
          ? identity.id
          : generateSshId(SSH_IDENTITY_ID_PREFIX),
    };
    this.identities.set(stored.id, stored);
    this.schedulePersist("identities.json", Array.from(this.identities.values()));
    return stored;
  }

  async deleteIdentity(id: string): Promise<void> {
    if (!this.identities.delete(id)) return;
    await this.secrets.delete(sshPasswordKey(id)).catch(() => undefined);
    this.schedulePersist("identities.json", Array.from(this.identities.values()));
  }

  // ── keys ───────────────────────────────────────────────────────────────

  listKeys(): SshKey[] {
    return Array.from(this.keys.values());
  }

  getKey(id: string): SshKey | undefined {
    return this.keys.get(id);
  }

  /** Persist metadata + secrets for a new key. The private key only goes to the store. */
  async addKey(
    key: SshKey,
    material: { privateKey: string; passphrase?: string },
  ): Promise<SshKey> {
    await this.secrets.set(sshSecretKey(key.id), material.privateKey);
    if (material.passphrase) {
      await this.secrets.set(sshPassphraseKey(key.id), material.passphrase);
    }
    this.keys.set(key.id, key);
    this.schedulePersist("keys.json", Array.from(this.keys.values()));
    return key;
  }

  renameKey(id: string, label: string): SshKey | undefined {
    const key = this.keys.get(id);
    if (!key) return undefined;
    const next = { ...key, label };
    this.keys.set(id, next);
    this.schedulePersist("keys.json", Array.from(this.keys.values()));
    return next;
  }

  /** Deleting a key unlinks it from every identity that used it. */
  async deleteKey(id: string): Promise<void> {
    if (!this.keys.delete(id)) return;
    let identitiesChanged = false;
    for (const identity of this.identities.values()) {
      if (identity.keyId === id) {
        const { keyId: _drop, ...rest } = identity;
        this.identities.set(identity.id, rest);
        identitiesChanged = true;
      }
    }
    await this.secrets.delete(sshSecretKey(id)).catch(() => undefined);
    await this.secrets.delete(sshPassphraseKey(id)).catch(() => undefined);
    this.schedulePersist("keys.json", Array.from(this.keys.values()));
    if (identitiesChanged) {
      this.schedulePersist("identities.json", Array.from(this.identities.values()));
    }
  }

  async getKeyMaterial(id: string): Promise<SshKeyMaterial | null> {
    if (!this.keys.has(id)) return null;
    const privateKey = await this.secrets.get(sshSecretKey(id));
    if (privateKey === null) return null;
    const passphrase = await this.secrets.get(sshPassphraseKey(id));
    return { privateKey, passphrase };
  }

  // ── secret helpers ─────────────────────────────────────────────────────

  /** undefined keeps the stored secret, "" deletes it, non-empty replaces it. */
  async setSecret(storeKey: string, value: string | undefined): Promise<void> {
    if (value === undefined) return;
    if (value === "") {
      await this.secrets.delete(storeKey);
      return;
    }
    await this.secrets.set(storeKey, value);
  }

  async hasSecret(storeKey: string): Promise<boolean> {
    return (await this.secrets.get(storeKey)) !== null;
  }

  // ── known hosts ────────────────────────────────────────────────────────

  listKnownHosts(): SshKnownHost[] {
    return Array.from(this.knownHosts.values());
  }

  addKnownHost(entry: SshKnownHost): void {
    this.knownHosts.set(knownHostId(entry.host, entry.port, entry.keyType), entry);
    this.persistKnownHosts();
  }

  /** Every stored key for host:port is replaced by `entry` (spec 25.3 mismatch recovery). */
  replaceKnownHost(entry: SshKnownHost): void {
    for (const [id, existing] of Array.from(this.knownHosts.entries())) {
      if (sameHostPort(existing, entry.host, entry.port)) this.knownHosts.delete(id);
    }
    this.addKnownHost(entry);
  }

  /** Record a successful verification without rewriting the key material. */
  touchKnownHost(host: string, port: number, keyType: string, seenAtMs = Date.now()): void {
    const id = knownHostId(host, port, keyType);
    const entry = this.knownHosts.get(id);
    if (!entry) return;
    this.knownHosts.set(id, { ...entry, lastSeenAtMs: seenAtMs });
    this.persistKnownHosts();
  }

  deleteKnownHosts(host: string, port: number, keyType?: string): void {
    let removed = false;
    for (const [id, entry] of Array.from(this.knownHosts.entries())) {
      if (!sameHostPort(entry, host, port)) continue;
      if (keyType !== undefined && entry.keyType !== keyType) continue;
      this.knownHosts.delete(id);
      removed = true;
    }
    if (removed) this.persistKnownHosts();
  }

  private persistKnownHosts(): void {
    this.schedulePersist("known_hosts.json", Array.from(this.knownHosts.values()));
  }

  // ── snippets (owned by S5; S1/S4 only read the startup snippet) ──────

  async readSnippetScript(id: string): Promise<string | null> {
    if (!this.dir) return null;
    try {
      const raw = await fs.readFile(path.join(this.dir, "snippets.json"), "utf8");
      const parsed = SnippetFileSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return null;
      return parsed.data.find((snippet) => snippet.id === id)?.script ?? null;
    } catch {
      return null;
    }
  }
}
