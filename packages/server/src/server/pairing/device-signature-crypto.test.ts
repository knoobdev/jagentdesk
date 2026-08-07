import { describe, expect, test } from "vitest";

import {
  exportDevicePublicKey,
  exportDeviceSecretKey,
  generateDeviceKeyPair,
  importDevicePublicKey,
  importDeviceSecretKey,
  samePublicKeyB64,
  signNonce,
  verifyNonceSignature,
} from "./device-signature-crypto.js";

describe("device signature crypto", () => {
  test("generated keypair has 32-byte raw keys and base64 roundtrips", () => {
    const key = generateDeviceKeyPair();
    expect(key.publicKey.byteLength).toBe(32);
    expect(key.secretKey.byteLength).toBe(32);

    const publicB64 = exportDevicePublicKey(key.publicKey);
    const secretB64 = exportDeviceSecretKey(key.secretKey);
    expect(Buffer.from(publicB64, "base64").byteLength).toBe(32);
    expect(Buffer.from(secretB64, "base64").byteLength).toBe(32);

    expect(importDevicePublicKey(publicB64)).toEqual(key.publicKey);
    expect(importDeviceSecretKey(secretB64)).toEqual(key.secretKey);
  });

  test("import rejects keys of the wrong length", () => {
    expect(() => importDevicePublicKey(Buffer.alloc(31).toString("base64"))).toThrow();
    expect(() => importDevicePublicKey(Buffer.alloc(33).toString("base64"))).toThrow();
    expect(() => importDeviceSecretKey(Buffer.alloc(31).toString("base64"))).toThrow();
    expect(() => importDeviceSecretKey(Buffer.alloc(33).toString("base64"))).toThrow();
  });

  test("sign then verify roundtrip succeeds", () => {
    const key = generateDeviceKeyPair();
    const nonce = "some-challenge-nonce";
    const signature = signNonce(key, nonce);
    expect(Buffer.from(signature, "base64").byteLength).toBe(64);
    expect(verifyNonceSignature(exportDevicePublicKey(key.publicKey), nonce, signature)).toBe(true);
  });

  test("tampered nonce fails verification", () => {
    const key = generateDeviceKeyPair();
    const signature = signNonce(key, "original-nonce");
    expect(
      verifyNonceSignature(exportDevicePublicKey(key.publicKey), "tampered-nonce", signature),
    ).toBe(false);
  });

  test("tampered signature fails verification", () => {
    const key = generateDeviceKeyPair();
    const signature = signNonce(key, "original-nonce");
    const tampered = Buffer.from(signature, "base64");
    tampered[0] = tampered[0] ^ 0xff;
    expect(
      verifyNonceSignature(
        exportDevicePublicKey(key.publicKey),
        "original-nonce",
        tampered.toString("base64"),
      ),
    ).toBe(false);
  });

  test("signature by a different key fails verification", () => {
    const signer = generateDeviceKeyPair();
    const other = generateDeviceKeyPair();
    const signature = signNonce(signer, "shared-nonce");
    expect(
      verifyNonceSignature(exportDevicePublicKey(other.publicKey), "shared-nonce", signature),
    ).toBe(false);
  });

  test("malformed base64 never throws and fails verification", () => {
    const key = generateDeviceKeyPair();
    const nonce = "nonce";
    const signature = signNonce(key, nonce);
    expect(verifyNonceSignature("!!!not-base64!!!", nonce, signature)).toBe(false);
    expect(
      verifyNonceSignature(exportDevicePublicKey(key.publicKey), nonce, "!!!not-base64!!!"),
    ).toBe(false);
    expect(
      verifyNonceSignature(
        exportDevicePublicKey(key.publicKey),
        nonce,
        Buffer.alloc(64).toString("base64"),
      ),
    ).toBe(false);
  });

  test("samePublicKeyB64 compares constant-time over equal, unequal, and length-mismatched keys", () => {
    const key = generateDeviceKeyPair();
    const publicB64 = exportDevicePublicKey(key.publicKey);

    expect(samePublicKeyB64(publicB64, publicB64)).toBe(true);

    const otherB64 = exportDevicePublicKey(generateDeviceKeyPair().publicKey);
    expect(samePublicKeyB64(publicB64, otherB64)).toBe(false);

    expect(samePublicKeyB64(publicB64, Buffer.alloc(31).toString("base64"))).toBe(false);
    expect(samePublicKeyB64(Buffer.alloc(33).toString("base64"), publicB64)).toBe(false);
    expect(samePublicKeyB64(publicB64, Buffer.alloc(32).toString("base64"))).toBe(false);
  });
});
