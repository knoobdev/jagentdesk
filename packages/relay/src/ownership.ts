/**
 * Ownership-challenge protocol for relay `role=server` sockets (spec 35.2).
 *
 * Pure helpers only — no Worker/Durable Object APIs — so the daemon can import
 * this module (via `@jagentdesk/relay/ownership`) to answer challenges.
 *
 * Wire format (JSON text frames, before any other frame on a server socket):
 *   DO   -> daemon:   {"type":"relay_challenge","v":1,"nonce":"<32-byte base64url>"}
 *   daemon -> DO:     {"type":"relay_auth","publicKey":"<32-byte base64url>","signature":"<base64url>"}
 *   DO   -> daemon:   {"type":"relay_auth_ok"}
 *
 * The signature is an Ed25519 signature over the UTF-8 string
 * `jagentdesk-relay-v1:<serverId>:<nonce>`.
 */

import { fromByteArray, toByteArray } from "base64-js";

export const RELAY_OWNERSHIP_SIGNATURE_CONTEXT = "jagentdesk-relay-v1";
export const RELAY_CHALLENGE_NONCE_BYTES = 32;
export const RELAY_ED25519_PUBLIC_KEY_BYTES = 32;

export interface RelayChallengeFrame {
  type: "relay_challenge";
  v: 1;
  nonce: string;
}

export interface RelayAuthFrame {
  type: "relay_auth";
  publicKey: string;
  signature: string;
}

export interface RelayAuthOkFrame {
  type: "relay_auth_ok";
}

/** The exact string the daemon must sign to prove it owns `serverId`. */
export function relayChallengeMessage(serverId: string, nonce: string): string {
  return `${RELAY_OWNERSHIP_SIGNATURE_CONTEXT}:${serverId}:${nonce}`;
}

export function encodeRelayChallenge(nonceBytes: Uint8Array): RelayChallengeFrame {
  if (nonceBytes.length !== RELAY_CHALLENGE_NONCE_BYTES) {
    throw new Error(
      `relay challenge nonce must be ${RELAY_CHALLENGE_NONCE_BYTES} bytes, got ${nonceBytes.length}`,
    );
  }
  return { type: "relay_challenge", v: 1, nonce: bytesToBase64Url(nonceBytes) };
}

export function encodeRelayAuth(
  publicKeyBytes: Uint8Array,
  signatureBytes: Uint8Array,
): RelayAuthFrame {
  return {
    type: "relay_auth",
    publicKey: bytesToBase64Url(publicKeyBytes),
    signature: bytesToBase64Url(signatureBytes),
  };
}

export function encodeRelayAuthOk(): RelayAuthOkFrame {
  return { type: "relay_auth_ok" };
}

export function parseRelayChallenge(raw: string): RelayChallengeFrame | null {
  const record = parseJsonRecord(raw);
  if (record?.type !== "relay_challenge" || record.v !== 1) return null;
  return typeof record.nonce === "string"
    ? { type: "relay_challenge", v: 1, nonce: record.nonce }
    : null;
}

export function parseRelayAuth(raw: string): RelayAuthFrame | null {
  const record = parseJsonRecord(raw);
  if (record?.type !== "relay_auth") return null;
  if (typeof record.publicKey !== "string" || typeof record.signature !== "string") return null;
  return { type: "relay_auth", publicKey: record.publicKey, signature: record.signature };
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return fromByteArray(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (standard.length % 4)) % 4;
  return toByteArray(standard + "=".repeat(padLen));
}

function parseJsonRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
