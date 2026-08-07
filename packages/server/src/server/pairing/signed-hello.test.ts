import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { createPairedDeviceStore } from "./paired-devices.js";
import { createNonceChallengeManager } from "./nonce-challenge.js";
import { verifySignedHello } from "./signed-hello.js";
import {
  exportDevicePublicKey,
  generateDeviceKeyPair,
  signNonce,
  type DeviceKeyPair,
} from "./device-signature-crypto.js";

function createTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "jagentdesk-signed-hello-"));
}

function registerKeypair(
  store: ReturnType<typeof createPairedDeviceStore>,
  key: DeviceKeyPair,
): string {
  const publicKeyB64 = exportDevicePublicKey(key.publicKey);
  store.register({ devicePublicKeyB64: publicKeyB64, deviceName: "Test device" });
  return publicKeyB64;
}

function signedAttempt(args: {
  key: DeviceKeyPair;
  nonce: string;
  signWith?: DeviceKeyPair;
  signature?: string;
}): { nonce: string; signature: string; devicePublicKeyB64: string } {
  const signature = args.signature ?? signNonce(args.signWith ?? args.key, args.nonce);
  return {
    nonce: args.nonce,
    signature,
    devicePublicKeyB64: exportDevicePublicKey(args.key.publicKey),
  };
}

describe("verifySignedHello", () => {
  test("accepts a valid signed hello", () => {
    const home = createTempHome();
    try {
      const devices = createPairedDeviceStore({ jagentdeskHome: home });
      const challenges = createNonceChallengeManager({});
      const key = generateDeviceKeyPair();
      registerKeypair(devices, key);
      const nonce = challenges.issue();

      const result = verifySignedHello({
        ...signedAttempt({ key, nonce }),
        challenges,
        devices,
      });

      expect(result).toEqual({ ok: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects when any challenge response field is missing or empty", () => {
    const home = createTempHome();
    try {
      const devices = createPairedDeviceStore({ jagentdeskHome: home });
      const challenges = createNonceChallengeManager({});
      const key = generateDeviceKeyPair();
      registerKeypair(devices, key);
      const nonce = challenges.issue();
      const valid = signedAttempt({ key, nonce });

      const missingNonce = verifySignedHello({
        challenges,
        devices,
        signature: valid.signature,
        devicePublicKeyB64: valid.devicePublicKeyB64,
      });
      expect(missingNonce).toEqual({ ok: false, reason: "missing challenge response" });

      const missingSignature = verifySignedHello({
        challenges,
        devices,
        nonce: valid.nonce,
        devicePublicKeyB64: valid.devicePublicKeyB64,
      });
      expect(missingSignature).toEqual({ ok: false, reason: "missing challenge response" });

      const missingKey = verifySignedHello({
        challenges,
        devices,
        nonce: valid.nonce,
        signature: valid.signature,
      });
      expect(missingKey).toEqual({ ok: false, reason: "missing challenge response" });

      const emptyNonce = verifySignedHello({
        challenges,
        devices,
        nonce: "",
        signature: valid.signature,
        devicePublicKeyB64: valid.devicePublicKeyB64,
      });
      expect(emptyNonce).toEqual({ ok: false, reason: "missing challenge response" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an unknown or expired nonce", () => {
    const home = createTempHome();
    try {
      const devices = createPairedDeviceStore({ jagentdeskHome: home });
      const challenges = createNonceChallengeManager({});
      const key = generateDeviceKeyPair();
      registerKeypair(devices, key);

      const result = verifySignedHello({
        ...signedAttempt({ key, nonce: "never-issued" }),
        challenges,
        devices,
      });

      expect(result).toEqual({ ok: false, reason: "unknown or expired nonce" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects a signed hello from an unpaired device", () => {
    const home = createTempHome();
    try {
      const devices = createPairedDeviceStore({ jagentdeskHome: home });
      const challenges = createNonceChallengeManager({});
      const pairedKey = generateDeviceKeyPair();
      const rogueKey = generateDeviceKeyPair();
      registerKeypair(devices, pairedKey);
      const nonce = challenges.issue();

      const result = verifySignedHello({
        ...signedAttempt({ key: rogueKey, nonce }),
        challenges,
        devices,
      });

      expect(result).toEqual({ ok: false, reason: "device is not paired" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("rejects an invalid signature", () => {
    const home = createTempHome();
    try {
      const devices = createPairedDeviceStore({ jagentdeskHome: home });
      const challenges = createNonceChallengeManager({});
      const key = generateDeviceKeyPair();
      registerKeypair(devices, key);
      const nonce = challenges.issue();

      const result = verifySignedHello({
        ...signedAttempt({
          key,
          nonce,
          signWith: generateDeviceKeyPair(),
        }),
        challenges,
        devices,
      });

      expect(result).toEqual({ ok: false, reason: "signature verification failed" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("nonce is burned on first presentation even when the signature is invalid", () => {
    const home = createTempHome();
    try {
      const devices = createPairedDeviceStore({ jagentdeskHome: home });
      const challenges = createNonceChallengeManager({});
      const key = generateDeviceKeyPair();
      registerKeypair(devices, key);
      const nonce = challenges.issue();
      const attempt = signedAttempt({ key, nonce, signWith: generateDeviceKeyPair() });

      const first = verifySignedHello({ ...attempt, challenges, devices });
      expect(first).toEqual({ ok: false, reason: "signature verification failed" });

      const replay = verifySignedHello({
        ...signedAttempt({ key, nonce, signature: signNonce(key, nonce) }),
        challenges,
        devices,
      });
      expect(replay).toEqual({ ok: false, reason: "unknown or expired nonce" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
