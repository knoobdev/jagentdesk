import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { loadOrCreateDaemonKeyPair, RELAY_OWNERSHIP_SIGNATURE_PREFIX } from "./daemon-keypair.js";
import { PRIVATE_FILE_MODE } from "./private-files.js";

const MODE_MASK = 0o777;
const PERMISSIVE_FILE_MODE = 0o644;

function createTempHome(): string {
  return mkdtempSync(path.join(tmpdir(), "jagentdesk-keypair-"));
}

function modeOf(filePath: string): number {
  return statSync(filePath).mode & MODE_MASK;
}

describe.skipIf(process.platform === "win32")("daemon keypair file permissions", () => {
  test("creates daemon-keypair.json with private permissions", async () => {
    const home = createTempHome();
    try {
      await loadOrCreateDaemonKeyPair(home);

      expect(modeOf(path.join(home, "daemon-keypair.json"))).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("repairs existing daemon-keypair.json permissions when loading", async () => {
    const home = createTempHome();
    const keypairPath = path.join(home, "daemon-keypair.json");
    try {
      const created = await loadOrCreateDaemonKeyPair(home);
      chmodSync(keypairPath, PERMISSIVE_FILE_MODE);

      const loaded = await loadOrCreateDaemonKeyPair(home);

      expect(loaded.publicKeyB64).toBe(created.publicKeyB64);
      expect(modeOf(keypairPath)).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("relay identity key (spec 35.2)", () => {
  test("is not generated until the relay is first enabled", async () => {
    const home = createTempHome();
    try {
      const created = await loadOrCreateDaemonKeyPair(home);
      expect(created.relayPublicKeyB64url).toBeNull();
      expect(
        JSON.parse(readFileSync(path.join(home, "daemon-keypair.json"), "utf8")).relaySecretKeyB64,
      ).toBeUndefined();

      const signer = created.ensureRelayIdentity();
      expect(signer.publicKeyB64url).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(created.relayPublicKeyB64url).toBe(signer.publicKeyB64url);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("survives restarts and keeps signing the ownership string stably", async () => {
    const home = createTempHome();
    try {
      const first = await loadOrCreateDaemonKeyPair(home);
      const firstSigner = first.ensureRelayIdentity();
      const signature = firstSigner.signOwnership("srv_1", "nonce-1");

      const second = await loadOrCreateDaemonKeyPair(home);
      expect(second.relayPublicKeyB64url).toBe(firstSigner.publicKeyB64url);
      const secondSigner = second.ensureRelayIdentity();
      expect(secondSigner.signOwnership("srv_1", "nonce-1")).toBe(signature);

      // The signature verifies as Ed25519 over `jagentdesk-relay-v1:<serverId>:<nonce>`.
      const publicKey = createPublicKey({
        format: "jwk",
        key: { kty: "OKP", crv: "Ed25519", x: firstSigner.publicKeyB64url },
      });
      expect(
        verify(
          null,
          Buffer.from(`${RELAY_OWNERSHIP_SIGNATURE_PREFIX}:srv_1:nonce-1`, "utf8"),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(true);
      expect(
        verify(
          null,
          Buffer.from(`${RELAY_OWNERSHIP_SIGNATURE_PREFIX}:srv_2:nonce-1`, "utf8"),
          publicKey,
          Buffer.from(signature, "base64url"),
        ),
      ).toBe(false);

      expect(modeOf(path.join(home, "daemon-keypair.json"))).toBe(PRIVATE_FILE_MODE);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("the Noise daemon key is unchanged by relay identity generation", async () => {
    const home = createTempHome();
    try {
      const before = await loadOrCreateDaemonKeyPair(home);
      before.ensureRelayIdentity();
      const after = await loadOrCreateDaemonKeyPair(home);
      expect(after.publicKeyB64).toBe(before.publicKeyB64);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
