import { verifyNonceSignature } from "./device-signature-crypto.js";
import type { NonceChallengeManager } from "./nonce-challenge.js";
import type { PairedDeviceStore } from "./paired-devices.js";

export type SignedHelloVerification = { ok: true } | { ok: false; reason: string };

export function verifySignedHello(args: {
  nonce?: string;
  signature?: string;
  devicePublicKeyB64?: string;
  challenges: NonceChallengeManager;
  devices: PairedDeviceStore;
}): SignedHelloVerification {
  const { nonce, signature, devicePublicKeyB64, challenges, devices } = args;

  if (!nonce || !signature || !devicePublicKeyB64) {
    return { ok: false, reason: "missing challenge response" };
  }

  if (!challenges.consume(nonce)) {
    return { ok: false, reason: "unknown or expired nonce" };
  }

  if (devices.getByPublicKey(devicePublicKeyB64) === null) {
    return { ok: false, reason: "device is not paired" };
  }

  if (!verifyNonceSignature(devicePublicKeyB64, nonce, signature)) {
    return { ok: false, reason: "signature verification failed" };
  }

  return { ok: true };
}
