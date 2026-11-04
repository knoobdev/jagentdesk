import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  SideloadAccountAuthSchema,
  SideloadAccountKindSchema,
  SideloadAnisetteSourceSchema,
  SideloadAppSchema,
} from "@jagentdesk/protocol/sideload/rpc-schemas";
import { FileSecretStore, type SecretStore } from "../database/secret-store.js";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import type { AnisetteIdentity } from "./apple/anisette.js";
import type { XcodeAuth } from "./apple/gsa.js";

/**
 * `$JAGENTDESK_HOME/sideload/` (26.2): non-secret JSON (0600 files, 0700 directory, atomic
 * writes) plus a FileSecretStore of its own for everything secret.
 */

export const AccountRecordSchema = z.object({
  id: z.string(),
  appleId: z.string(),
  kind: SideloadAccountKindSchema,
  auth: SideloadAccountAuthSchema,
  teamId: z.string().nullable(),
  teamName: z.string().nullable(),
  keepSignedIn: z.boolean(),
  anisetteSource: SideloadAnisetteSourceSchema,
  anisetteUrl: z.string().nullable(),
  createdAt_ms: z.number(),
  ascIssuerId: z.string().nullable(),
  ascKeyId: z.string().nullable(),
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;

export const AppRecordSchema = SideloadAppSchema.extend({
  /** Bundle ids of the extensions signed with the app (each holds an App ID). */
  extensionBundleIds: z.array(z.string()),
});
export type AppRecord = z.infer<typeof AppRecordSchema>;

export const AppIdUsageSchema = z.object({
  accountId: z.string(),
  appIdentifierId: z.string(),
  bundleId: z.string(),
  createdAt_ms: z.number(),
});
export type AppIdUsage = z.infer<typeof AppIdUsageSchema>;

const AccountsFileSchema = z.object({ accounts: z.array(AccountRecordSchema) });
const AppsFileSchema = z.object({ apps: z.array(AppRecordSchema) });
const AppIdsFileSchema = z.object({ appIds: z.array(AppIdUsageSchema) });

/** The development identity the daemon generated for a team; private key included. */
export const SigningIdentitySchema = z.object({
  teamId: z.string(),
  certificateId: z.string(),
  serialNumber: z.string(),
  machineId: z.string(),
  privateKeyPem: z.string(),
  certificateDerBase64: z.string(),
  expiresAt_ms: z.number().nullable(),
});
export type SigningIdentity = z.infer<typeof SigningIdentitySchema>;

const XcodeAuthSchema = z.object({
  adsid: z.string(),
  token: z.string(),
  expiresAt_ms: z.number(),
});

const AnisetteIdentitySchema = z.object({
  localUserId: z.string(),
  deviceId: z.string(),
  remoteIdentifier: z.string().nullable(),
  remoteAdiPb: z.string().nullable(),
});

function readJson<T>(file: string, schema: z.ZodType<T>, empty: T): T {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw error;
  }
  return schema.parse(JSON.parse(raw));
}

export class SideloadStorage {
  readonly dir: string;
  readonly ipaDir: string;
  readonly workDir: string;
  readonly secrets: SecretStore;

  constructor(jagentdeskHome: string, secrets?: SecretStore) {
    this.dir = path.join(jagentdeskHome, "sideload");
    this.ipaDir = path.join(this.dir, "ipa");
    this.workDir = path.join(this.dir, "work");
    this.secrets = secrets ?? new FileSecretStore(this.dir);
  }

  initialize(): void {
    ensurePrivateDirectory(this.dir);
    ensurePrivateDirectory(this.ipaDir);
    ensurePrivateDirectory(this.workDir);
  }

  private file(name: string): string {
    return path.join(this.dir, name);
  }

  listAccounts(): AccountRecord[] {
    return readJson(this.file("accounts.json"), AccountsFileSchema, { accounts: [] }).accounts;
  }

  saveAccounts(accounts: AccountRecord[]): void {
    writePrivateFileAtomicSync(this.file("accounts.json"), JSON.stringify({ accounts }, null, 2));
  }

  getAccount(id: string): AccountRecord | null {
    return this.listAccounts().find((account) => account.id === id) ?? null;
  }

  upsertAccount(account: AccountRecord): void {
    const others = this.listAccounts().filter((existing) => existing.id !== account.id);
    this.saveAccounts([...others, account]);
  }

  listApps(): AppRecord[] {
    return readJson(this.file("apps.json"), AppsFileSchema, { apps: [] }).apps;
  }

  saveApps(apps: AppRecord[]): void {
    writePrivateFileAtomicSync(this.file("apps.json"), JSON.stringify({ apps }, null, 2));
  }

  getApp(id: string): AppRecord | null {
    return this.listApps().find((app) => app.id === id) ?? null;
  }

  upsertApp(app: AppRecord): void {
    const others = this.listApps().filter((existing) => existing.id !== app.id);
    this.saveApps([...others, app]);
  }

  removeApp(id: string): void {
    this.saveApps(this.listApps().filter((app) => app.id !== id));
  }

  listAppIdUsage(): AppIdUsage[] {
    return readJson(this.file("app-ids.json"), AppIdsFileSchema, { appIds: [] }).appIds;
  }

  recordAppId(usage: AppIdUsage): void {
    const others = this.listAppIdUsage().filter(
      (existing) =>
        !(existing.accountId === usage.accountId && existing.bundleId === usage.bundleId),
    );
    writePrivateFileAtomicSync(
      this.file("app-ids.json"),
      JSON.stringify({ appIds: [...others, usage] }, null, 2),
    );
  }

  /** Removes the account, its secrets and its App ID ledger (26.3.5). Apps stay listed. */
  async removeAccount(id: string): Promise<void> {
    this.saveAccounts(this.listAccounts().filter((account) => account.id !== id));
    writePrivateFileAtomicSync(
      this.file("app-ids.json"),
      JSON.stringify(
        { appIds: this.listAppIdUsage().filter((usage) => usage.accountId !== id) },
        null,
        2,
      ),
    );
    for (const key of ["password", "xcode", "anisette", "signing", "asc"]) {
      await this.secrets.delete(`${key}.${id}`);
    }
  }

  // ── secrets ──
  async getPassword(id: string): Promise<string | null> {
    return this.secrets.get(`password.${id}`);
  }
  async setPassword(id: string, password: string | null): Promise<void> {
    if (password === null) await this.secrets.delete(`password.${id}`);
    else await this.secrets.set(`password.${id}`, password);
  }

  async getXcodeAuth(id: string): Promise<XcodeAuth | null> {
    const raw = await this.secrets.get(`xcode.${id}`);
    return raw ? XcodeAuthSchema.parse(JSON.parse(raw)) : null;
  }
  async setXcodeAuth(id: string, auth: XcodeAuth | null): Promise<void> {
    if (auth === null) await this.secrets.delete(`xcode.${id}`);
    else await this.secrets.set(`xcode.${id}`, JSON.stringify(auth));
  }

  async getAnisetteIdentity(id: string): Promise<AnisetteIdentity | null> {
    const raw = await this.secrets.get(`anisette.${id}`);
    return raw ? AnisetteIdentitySchema.parse(JSON.parse(raw)) : null;
  }
  async setAnisetteIdentity(id: string, identity: AnisetteIdentity | null): Promise<void> {
    if (identity === null) await this.secrets.delete(`anisette.${id}`);
    else await this.secrets.set(`anisette.${id}`, JSON.stringify(identity));
  }

  async getSigningIdentity(id: string): Promise<SigningIdentity | null> {
    const raw = await this.secrets.get(`signing.${id}`);
    return raw ? SigningIdentitySchema.parse(JSON.parse(raw)) : null;
  }
  async setSigningIdentity(id: string, identity: SigningIdentity | null): Promise<void> {
    if (identity === null) await this.secrets.delete(`signing.${id}`);
    else await this.secrets.set(`signing.${id}`, JSON.stringify(identity));
  }

  async getAscPrivateKey(id: string): Promise<string | null> {
    return this.secrets.get(`asc.${id}`);
  }
  async setAscPrivateKey(id: string, pem: string): Promise<void> {
    await this.secrets.set(`asc.${id}`, pem);
  }
}
