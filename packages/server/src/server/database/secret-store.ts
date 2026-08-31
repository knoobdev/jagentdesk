import { promises as fs } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Daemon-side credential vault: connection secrets (password / DSN) encrypted at
 * rest with AES-256-GCM under a key that never leaves the daemon home. This is the
 * daemon analogue of the desktop browser vault (safeStorage): the secret is only
 * ever decrypted in-process to open a connection, and is never persisted in
 * databases.json nor sent on the wire.
 */
export interface SecretStore {
  get(id: string): Promise<string | null>;
  set(id: string, secret: string): Promise<void>;
  delete(id: string): Promise<void>;
}

/** In-memory store — used in tests and when no home is configured. */
export class MemorySecretStore implements SecretStore {
  private readonly map = new Map<string, string>();
  async get(id: string): Promise<string | null> {
    return this.map.get(id) ?? null;
  }
  async set(id: string, secret: string): Promise<void> {
    this.map.set(id, secret);
  }
  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }
}

interface SealedSecret {
  iv: string;
  tag: string;
  data: string;
}

/** File-backed AES-256-GCM store keyed by a 0600 key file in the daemon home. */
export class FileSecretStore implements SecretStore {
  private readonly keyPath: string;
  private readonly dataPath: string;
  private keyPromise: Promise<Buffer> | null = null;

  constructor(dir: string) {
    this.keyPath = path.join(dir, "secret.key");
    this.dataPath = path.join(dir, "secrets.json");
  }

  private async key(): Promise<Buffer> {
    if (!this.keyPromise) {
      this.keyPromise = this.loadOrCreateKey();
    }
    return this.keyPromise;
  }

  private async loadOrCreateKey(): Promise<Buffer> {
    try {
      const raw = await fs.readFile(this.keyPath, "utf8");
      return Buffer.from(raw.trim(), "base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const key = randomBytes(32);
      await fs.mkdir(path.dirname(this.keyPath), { recursive: true });
      await fs.writeFile(this.keyPath, key.toString("base64"), { mode: 0o600 });
      await fs.chmod(this.keyPath, 0o600).catch(() => undefined);
      return key;
    }
  }

  private async readAll(): Promise<Record<string, SealedSecret>> {
    try {
      return JSON.parse(await fs.readFile(this.dataPath, "utf8")) as Record<string, SealedSecret>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(all: Record<string, SealedSecret>): Promise<void> {
    await fs.mkdir(path.dirname(this.dataPath), { recursive: true });
    await fs.writeFile(this.dataPath, JSON.stringify(all), { mode: 0o600 });
  }

  async get(id: string): Promise<string | null> {
    const sealed = (await this.readAll())[id];
    if (!sealed) return null;
    const key = await this.key();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  async set(id: string, secret: string): Promise<void> {
    const key = await this.key();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const all = await this.readAll();
    all[id] = {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
    };
    await this.writeAll(all);
  }

  async delete(id: string): Promise<void> {
    const all = await this.readAll();
    if (all[id]) {
      delete all[id];
      await this.writeAll(all);
    }
  }
}
