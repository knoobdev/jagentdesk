import { randomBytes as nodeRandomBytes } from "node:crypto";
import type pino from "pino";

export interface NonceChallengeManager {
  issue(): string;
  consume(nonce: string): boolean;
  size(): number;
}

interface NonceEntry {
  nonce: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_ENTRIES = 4096;
const NONCE_BYTES = 32;

export function createNonceChallengeManager(args: {
  ttlMs?: number;
  maxEntries?: number;
  logger?: pino.Logger;
  randomBytes?: (size: number) => Buffer;
}): NonceChallengeManager {
  const log = args.logger?.child({ module: "nonce-challenge" });
  const ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
  const maxEntries = args.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const randomBytes = args.randomBytes ?? nodeRandomBytes;
  const entries: NonceEntry[] = [];

  function pruneExpired(now: number): void {
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index].expiresAt <= now) {
        entries.splice(index, 1);
      }
    }
  }

  return {
    issue(): string {
      const now = Date.now();
      pruneExpired(now);
      if (entries.length >= maxEntries) {
        const dropped = entries.shift();
        log?.warn(
          { droppedNonce: dropped?.nonce },
          "Nonce challenge capacity reached, dropped oldest",
        );
      }
      const nonce = randomBytes(NONCE_BYTES).toString("base64url");
      entries.push({ nonce, expiresAt: now + ttlMs });
      return nonce;
    },

    consume(nonce: string): boolean {
      const now = Date.now();
      const index = entries.findIndex((entry) => entry.nonce === nonce);
      if (index === -1) {
        return false;
      }
      const [entry] = entries.splice(index, 1);
      return entry.expiresAt > now;
    },

    size(): number {
      return entries.length;
    },
  };
}
