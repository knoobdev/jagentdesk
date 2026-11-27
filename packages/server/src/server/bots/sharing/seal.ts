// A share link's encryption (ADR-0061 §5): AES-256-GCM under a random 32-byte key per bot, a fresh
// 12-byte nonce per publish, and the shareId bound in as additional data so a sealed bundle can't be
// served under another link. The key travels only in the link's `#k=` fragment.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const MAGIC = Buffer.from("JADS", "ascii");
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + NONCE_BYTES;
export const SHARE_KEY_BYTES = 32;
export const SHARE_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class ShareSealError extends Error {
  constructor() {
    super("bot-share-seal-invalid");
    this.name = "ShareSealError";
  }
}

function additionalData(shareId: string): Buffer {
  return Buffer.from(`jagentdesk-bot-share:v1:${shareId}`, "utf8");
}

export function newShareKey(): Buffer {
  return randomBytes(SHARE_KEY_BYTES);
}

export function sealShare(input: { key: Buffer; shareId: string; plaintext: Buffer }): Buffer {
  if (input.key.length !== SHARE_KEY_BYTES) throw new Error("bot-share-key-invalid");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", input.key, nonce);
  cipher.setAAD(additionalData(input.shareId));
  const body = Buffer.concat([cipher.update(input.plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), nonce, body, cipher.getAuthTag()]);
}

/** The plaintext, or a ShareSealError when the bytes, the key or the shareId don't match. */
export function openShare(input: { key: Buffer; shareId: string; sealed: Buffer }): Buffer {
  const { sealed } = input;
  if (
    input.key.length !== SHARE_KEY_BYTES ||
    sealed.length < HEADER_BYTES + TAG_BYTES ||
    !sealed.subarray(0, MAGIC.length).equals(MAGIC) ||
    sealed[MAGIC.length] !== VERSION
  )
    throw new ShareSealError();
  const nonce = sealed.subarray(MAGIC.length + 1, HEADER_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", input.key, nonce);
    decipher.setAAD(additionalData(input.shareId));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(sealed.subarray(HEADER_BYTES, sealed.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new ShareSealError();
  }
}

/** `<origin>/s/<shareId>#k=<key base64url>`. */
export function formatShareLink(input: { origin: string; shareId: string; key: Buffer }): string {
  return `${input.origin}/s/${input.shareId}#k=${input.key.toString("base64url")}`;
}

/** The link without its key, as a copy's record keeps it. */
export function shareLinkWithoutKey(origin: string, shareId: string): string {
  return `${origin}/s/${shareId}`;
}

export interface ParsedShareLink {
  origin: string;
  shareId: string;
  key: Buffer;
  url: string;
}

/** A pasted link, or null when it isn't one: http(s), path `/s/<shareId>`, `#k=<key>`. */
export function parseShareLink(link: string): ParsedShareLink | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search) return null;
  const match = /^\/s\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
  const key = /^#k=([A-Za-z0-9_-]+)$/.exec(url.hash)?.[1];
  if (!match || !key || !KEY_PATTERN.test(key)) return null;
  const bytes = Buffer.from(key, "base64url");
  if (bytes.length !== SHARE_KEY_BYTES) return null;
  return {
    origin: url.origin,
    shareId: match[1],
    key: bytes,
    url: shareLinkWithoutKey(url.origin, match[1]),
  };
}
