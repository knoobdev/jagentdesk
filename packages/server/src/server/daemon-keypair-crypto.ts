import { generateKeyPairSync } from "node:crypto";

/**
 * NaCl box keypair primitives backed by Node's X25519 implementation.
 *
 * The daemon keypair (`daemon-keypair.json`, v2, "libsodium box keypair") uses
 * Curve25519 raw 32-byte public and secret keys, base64-encoded. Node's X25519
 * keys match RFC 7748 — the same curve and raw key format used by NaCl box — so
 * existing daemon identities remain stable without a separate crypto package.
 */

export interface KeyPair {
  publicKey: Uint8Array; // 32 bytes
  secretKey: Uint8Array; // 32 bytes
}

const KEY_LENGTH_BYTES = 32;

function requireKeyBytes(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength !== KEY_LENGTH_BYTES) {
    throw new Error(`Invalid ${label} key length (expected ${KEY_LENGTH_BYTES})`);
  }
}

function exportRawJwkField(
  keyObject: { export: (options: { format: "jwk" }) => object },
  field: string,
): Uint8Array {
  const jwk = keyObject.export({ format: "jwk" }) as Record<string, unknown>;
  const value = jwk[field];
  if (typeof value !== "string") {
    throw new Error(`X25519 key export missing ${field} field`);
  }
  return Buffer.from(value, "base64url");
}

export function generateKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const publicKeyBytes = exportRawJwkField(publicKey, "x");
  const secretKeyBytes = exportRawJwkField(privateKey, "d");
  return { publicKey: publicKeyBytes, secretKey: secretKeyBytes };
}

export function exportPublicKey(publicKey: Uint8Array): string {
  requireKeyBytes(publicKey, "public");
  return Buffer.from(publicKey).toString("base64");
}

export function importPublicKey(base64: string): Uint8Array {
  const bytes = Buffer.from(base64, "base64");
  requireKeyBytes(bytes, "public");
  return bytes;
}

export function exportSecretKey(secretKey: Uint8Array): string {
  requireKeyBytes(secretKey, "secret");
  return Buffer.from(secretKey).toString("base64");
}

export function importSecretKey(base64: string): Uint8Array {
  const bytes = Buffer.from(base64, "base64");
  requireKeyBytes(bytes, "secret");
  return bytes;
}
