import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  timingSafeEqual,
  verify,
} from "node:crypto";

/**
 * Ed25519 primitives for per-device pairing keys.
 *
 * Wire contract: public keys are base64-encoded raw 32 bytes, signatures are
 * base64-encoded raw 64 bytes. This is distinct from the daemon's own X25519
 * keypair (`daemon-keypair-crypto.ts`) — that one stays untouched.
 */

export interface DeviceKeyPair {
  publicKey: Uint8Array; // 32 bytes
  secretKey: Uint8Array; // 32 bytes (Ed25519 seed)
}

const KEY_LENGTH_BYTES = 32;
const SIGNATURE_LENGTH_BYTES = 64;
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function requireKeyBytes(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength !== KEY_LENGTH_BYTES) {
    throw new Error(`Invalid ${label} key length (expected ${KEY_LENGTH_BYTES})`);
  }
}

function requireDecodedKeyLength(base64: string, label: string): Uint8Array {
  const bytes = Buffer.from(base64, "base64");
  requireKeyBytes(bytes, label);
  return bytes;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  const privateJwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  const publicX = publicJwk.x;
  const secretD = privateJwk.d;
  if (typeof publicX !== "string" || typeof secretD !== "string") {
    throw new Error("Ed25519 key export missing x or d field");
  }
  return {
    publicKey: Buffer.from(publicX, "base64url"),
    secretKey: Buffer.from(secretD, "base64url"),
  };
}

export function exportDevicePublicKey(publicKey: Uint8Array): string {
  requireKeyBytes(publicKey, "public");
  return Buffer.from(publicKey).toString("base64");
}

export function importDevicePublicKey(base64: string): Uint8Array {
  return requireDecodedKeyLength(base64, "public");
}

export function exportDeviceSecretKey(secretKey: Uint8Array): string {
  requireKeyBytes(secretKey, "secret");
  return Buffer.from(secretKey).toString("base64");
}

export function importDeviceSecretKey(base64: string): Uint8Array {
  return requireDecodedKeyLength(base64, "secret");
}

export function signNonce(key: DeviceKeyPair, nonce: string): string {
  requireKeyBytes(key.publicKey, "public");
  requireKeyBytes(key.secretKey, "secret");
  const privateKey = createPrivateKey({
    key: {
      kty: "OKP",
      crv: "Ed25519",
      d: Buffer.from(key.secretKey).toString("base64url"),
      x: Buffer.from(key.publicKey).toString("base64url"),
    },
    format: "jwk",
  });
  const signature = sign(null, Buffer.from(nonce, "utf8"), privateKey);
  return signature.toString("base64");
}

export function verifyNonceSignature(
  publicKeyB64: string,
  nonce: string,
  signatureB64: string,
): boolean {
  try {
    const rawKey = Buffer.from(publicKeyB64, "base64");
    requireKeyBytes(rawKey, "public");
    const signature = Buffer.from(signatureB64, "base64");
    if (signature.byteLength !== SIGNATURE_LENGTH_BYTES) {
      return false;
    }
    const publicKey = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, rawKey]),
      format: "der",
      type: "spki",
    });
    return verify(null, Buffer.from(nonce, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

export function samePublicKeyB64(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "base64");
  const bBytes = Buffer.from(b, "base64");
  if (aBytes.byteLength !== KEY_LENGTH_BYTES || bBytes.byteLength !== KEY_LENGTH_BYTES) {
    return false;
  }
  return timingSafeEqual(aBytes, bBytes);
}
