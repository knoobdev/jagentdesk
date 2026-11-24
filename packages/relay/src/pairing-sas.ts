import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromByteArray, toByteArray } from "base64-js";

export function pairingBase64Url(bytes: Uint8Array): string {
  return fromByteArray(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = toByteArray(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  if (bytes.length !== 32) throw new Error("pairing_bad_key");
  return bytes;
}
export function createPairingEphemeral() {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: pairingBase64Url(x25519.getPublicKey(secretKey)) };
}
/** The byte contract of spec 05.3.4, shared by app clients and the F5 exchange. */
export function derivePairingSas(
  secretKey: Uint8Array,
  peer: string,
  nonceClient: string,
  nonceHost: string,
  pkClient: string,
  pkHost: string,
): string {
  const shared = x25519.getSharedSecret(secretKey, decode(peer));
  const salt = new Uint8Array([...decode(nonceClient), ...decode(nonceHost)]);
  const info = new Uint8Array([
    ...new TextEncoder().encode("jagentdesk-pair-v1"),
    ...decode(pkClient),
    ...decode(pkHost),
  ]);
  const okm = hkdf(sha256, shared, salt, info, 32);
  try {
    return String(
      new DataView(okm.buffer, okm.byteOffset, okm.byteLength).getUint32(0) % 1_000_000,
    ).padStart(6, "0");
  } finally {
    shared.fill(0);
    okm.fill(0);
  }
}
