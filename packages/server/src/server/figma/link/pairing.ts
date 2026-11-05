import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../../private-files.js";
import { PAIRINGS_FILE, pairingKeySecretName } from "./protocol.js";

/**
 * Pairing record. Non-secret fields persist to
 * `$JAGENTDESK_HOME/figma/link-pairings.json`. The long-lived key itself is a
 * secret and lives in the SecretStore under `figma.link.key.<pairingId>`.
 */
export interface FigmaLinkPairingRecord {
  pairingId: string;
  name: string;
  fileKey: string;
  fileName: string;
  createdAt: number;
  lastConnectedAt: number | null;
}

/** One live pairing code. Codes are short-lived; records are not. */
interface PendingCode {
  code: string;
  pairingId: string;
  expiresAt: number;
}

/** Narrow secret-store surface so tests can hand in a Map-backed fake. */
export interface LinkSecretStoreLike {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PairingManagerOptions {
  secrets: LinkSecretStoreLike;
  /** JAGENTDESK_HOME root; pairings.json lives under `figma/`. */
  dataDir: string;
  /** Injected clock so tests control code expiry. */
  now?: () => number;
  /** Lifetime of an unredeemed pairing code. */
  codeTtlMs: number;
  /** Injectable entropy for codes/keys in tests. */
  randomBytesFn?: (size: number) => Buffer;
}

const CODE_LENGTH = 6;

export function generatePairingCode(random: () => Buffer = () => randomBytes(8)): string {
  const bytes = random();
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += String(bytes[i % bytes.length] % 10);
  }
  return code;
}

export function generatePairingKey(random: () => Buffer = () => randomBytes(32)): string {
  return random().toString("hex");
}

/** Constant-time comparison; never throws on odd lengths. */
export function keysMatch(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!presented || !expected || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i++) {
    diff |= (presented.charCodeAt(i) ^ expected.charCodeAt(i)) & 0xff;
  }
  return diff === 0;
}

export class FigmaLinkPairingManager {
  private records: FigmaLinkPairingRecord[] = [];
  private pending: PendingCode[] = [];
  private readonly now: () => number;
  private loaded = false;

  constructor(private readonly options: PairingManagerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Create (or replace) the pending code for a plugin instance. */
  issueCode(input: { pairingId: string; name: string; fileKey: string; fileName: string }): {
    code: string;
    expiresAt: number;
  } {
    this.load();
    const code = generatePairingCode(() => this.bytes(8));
    const expiresAt = this.now() + this.options.codeTtlMs;
    this.pending = this.pending.filter((p) => p.pairingId !== input.pairingId);
    this.pending.push({ code, pairingId: input.pairingId, expiresAt });

    const existing = this.find(input.pairingId);
    if (existing) {
      existing.name = input.name;
      existing.fileKey = input.fileKey;
      existing.fileName = input.fileName;
    } else {
      this.records.push({
        pairingId: input.pairingId,
        name: input.name,
        fileKey: input.fileKey,
        fileName: input.fileName,
        createdAt: this.now(),
        lastConnectedAt: null,
      });
    }
    this.save();
    return { code, expiresAt };
  }

  /**
   * Redeem a code the user typed into the plugin. Issues a fresh long-lived
   * key stored as a secret. Returns null when the code is unknown or expired.
   */
  async pair(code: string): Promise<{ pairingId: string; pairingKey: string } | null> {
    this.load();
    const trimmed = code.trim();
    const now = this.now();
    const match = this.pending.find((p) => p.code === trimmed && p.expiresAt >= now);
    if (!match) return null;
    this.pending = this.pending.filter((p) => p !== match);

    const pairingKey = generatePairingKey(() => this.bytes(32));
    await this.options.secrets.set(pairingKeySecretName(match.pairingId), pairingKey);
    return { pairingId: match.pairingId, pairingKey };
  }

  /** Verify a presented key against the stored secret. */
  async validate(pairingId: string, pairingKey: string | undefined): Promise<boolean> {
    if (!pairingId || !pairingKey) return false;
    const expected = await this.options.secrets.get(pairingKeySecretName(pairingId));
    return keysMatch(pairingKey, expected);
  }

  async record(pairingId: string): Promise<FigmaLinkPairingRecord | undefined> {
    this.load();
    return this.find(pairingId);
  }

  async list(): Promise<FigmaLinkPairingRecord[]> {
    this.load();
    return [...this.records];
  }

  touchConnected(pairingId: string): void {
    const rec = this.find(pairingId);
    if (!rec) return;
    rec.lastConnectedAt = this.now();
    this.save();
  }

  async revokeAll(): Promise<void> {
    this.load();
    for (const record of this.records) {
      await this.options.secrets.delete(pairingKeySecretName(record.pairingId));
    }
    this.records = [];
    this.pending = [];
    this.save();
  }

  async revoke(pairingId: string): Promise<void> {
    this.load();
    this.records = this.records.filter((r) => r.pairingId !== pairingId);
    this.pending = this.pending.filter((p) => p.pairingId !== pairingId);
    await this.options.secrets.delete(pairingKeySecretName(pairingId));
    this.save();
  }

  /** Drop expired pending codes (called opportunistically on load/issue). */
  pruneExpired(): void {
    const now = this.now();
    this.pending = this.pending.filter((p) => p.expiresAt >= now);
  }

  private find(pairingId: string): FigmaLinkPairingRecord | undefined {
    return this.records.find((r) => r.pairingId === pairingId);
  }

  private bytes(size: number): Buffer {
    return this.options.randomBytesFn ? this.options.randomBytesFn(size) : randomBytes(size);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = readFileSync(this.file(), "utf8");
      const parsed = JSON.parse(raw) as { pairings?: unknown };
      this.records = Array.isArray(parsed.pairings)
        ? (parsed.pairings as FigmaLinkPairingRecord[])
        : [];
    } catch {
      this.records = [];
    }
    this.pruneExpired();
  }

  private save(): void {
    const file = this.file();
    ensurePrivateDirectory(this.dir());
    writePrivateFileAtomicSync(file, JSON.stringify({ pairings: this.records }, null, 2));
  }

  private dir(): string {
    return join(this.options.dataDir, "figma");
  }

  private file(): string {
    return join(this.options.dataDir, PAIRINGS_FILE);
  }
}
