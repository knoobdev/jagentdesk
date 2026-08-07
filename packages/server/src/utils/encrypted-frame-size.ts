/**
 * Wire-format sizing for encrypted WebSocket frames.
 *
 * The daemon caps frames at 32 MiB. A string frame is base64-encoded ciphertext, so
 * plaintext budgets are computed by inverting that exact expansion. Per-payload
 * overhead is the 24-byte NaCl nonce plus the 16-byte Poly1305 tag (40 bytes).
 *
 * Keep the arithmetic local so the daemon can size frames without depending on a
 * separate transport package.
 */

const ENCRYPTED_PAYLOAD_OVERHEAD_BYTES = 40;

export function base64EncryptedWireByteLength(plaintextBytes: number): number {
  return 4 * Math.ceil((plaintextBytes + ENCRYPTED_PAYLOAD_OVERHEAD_BYTES) / 3);
}

export function maxBase64EncryptedPlaintextByteLength(wireBytes: number): number {
  return Math.floor(wireBytes / 4) * 3 - ENCRYPTED_PAYLOAD_OVERHEAD_BYTES;
}
