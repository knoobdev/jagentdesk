import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { z } from "zod";
import {
  relayChallengeMessage,
  RELAY_OWNERSHIP_SIGNATURE_CONTEXT,
} from "@jagentdesk/relay/ownership";
import type pino from "pino";

import {
  generateKeyPair,
  exportPublicKey,
  exportSecretKey,
  importPublicKey,
  importSecretKey,
  type KeyPair,
} from "./daemon-keypair-crypto.js";
import { ensurePrivateFile, writePrivateFileAtomicSync } from "./private-files.js";

const KeyPairSchema = z.object({
  v: z.literal(2),
  publicKeyB64: z.string().min(1),
  secretKeyB64: z.string().min(1),
  // Separate Ed25519 relay identity key (spec 35.2): proves serverId ownership to the
  // Worker. Generated lazily on first relay enable, so pre-relay homes stay unchanged.
  relayPublicKeyB64: z.string().min(1).optional(),
  relaySecretKeyB64: z.string().min(1).optional(),
});

type StoredKeyPair = z.infer<typeof KeyPairSchema>;

const KEYPAIR_FILENAME = "daemon-keypair.json";

/** Signed for the relay ownership challenge (spec 35.2): `jagentdesk-relay-v1:<serverId>:<nonce>`. */
export const RELAY_OWNERSHIP_SIGNATURE_PREFIX = RELAY_OWNERSHIP_SIGNATURE_CONTEXT;

export interface RelayOwnershipSigner {
  /** Raw 32-byte Ed25519 public key, base64url. */
  publicKeyB64url: string;
  /** Ed25519 signature over the UTF-8 ownership string, base64url. */
  signOwnership(serverId: string, nonceB64url: string): string;
}

export interface DaemonKeyPairBundle {
  keyPair: KeyPair;
  publicKeyB64: string;
  /** Present only after the relay identity was generated (first relay enable). */
  relayPublicKeyB64url: string | null;
  /** Reads/modifies `daemon-keypair.json`; generates and persists the key on first call. */
  ensureRelayIdentity(): RelayOwnershipSigner;
}

function ed25519JwkField(
  keyObject: { export: (options: { format: "jwk" }) => object },
  field: string,
): string {
  const jwk = keyObject.export({ format: "jwk" }) as Record<string, unknown>;
  const value = jwk[field];
  if (typeof value !== "string") {
    throw new Error(`Ed25519 key export missing ${field} field`);
  }
  return value;
}

function createRelaySigner(
  relayPublicKeyB64: string,
  relaySecretKeyB64: string,
): RelayOwnershipSigner {
  const seed = Buffer.from(relaySecretKeyB64, "base64");
  if (seed.byteLength !== 32) {
    throw new Error("Invalid relay identity key length (expected 32)");
  }
  const privateKey = createPrivateKey({
    format: "jwk",
    key: {
      kty: "OKP",
      crv: "Ed25519",
      x: Buffer.from(relayPublicKeyB64, "base64").toString("base64url"),
      d: seed.toString("base64url"),
    },
  });
  const publicKey = createPublicKey(privateKey);
  return {
    publicKeyB64url: ed25519JwkField(publicKey, "x"),
    signOwnership(serverId, nonce) {
      const message = Buffer.from(relayChallengeMessage(serverId, nonce), "utf8");
      return sign(null, message, privateKey).toString("base64url");
    },
  };
}

/** Recovery must use the old key without generating or replacing any identity. */
export function loadExistingRelayIdentity(jagentdeskHome: string): RelayOwnershipSigner {
  const stored = KeyPairSchema.parse(
    JSON.parse(readFileSync(path.join(jagentdeskHome, KEYPAIR_FILENAME), "utf8")),
  );
  if (!stored.relayPublicKeyB64 || !stored.relaySecretKeyB64) {
    throw new Error(
      "The current pinned relay key is required. Restore the old daemon-keypair.json or use a new serverId.",
    );
  }
  return createRelaySigner(stored.relayPublicKeyB64, stored.relaySecretKeyB64);
}

export async function loadOrCreateDaemonKeyPair(
  jagentdeskHome: string,
  logger?: pino.Logger,
): Promise<DaemonKeyPairBundle> {
  const log = logger?.child({ module: "daemon-keypair" });
  const filePath = path.join(jagentdeskHome, KEYPAIR_FILENAME);

  let stored: StoredKeyPair | null = null;
  if (existsSync(filePath)) {
    try {
      ensurePrivateFile(filePath);
      const raw = readFileSync(filePath, "utf8");
      stored = KeyPairSchema.parse(JSON.parse(raw));
    } catch (error) {
      log?.warn({ err: error, filePath }, "Failed to load daemon keypair, regenerating");
      stored = null;
    }
  }

  let keyPair: KeyPair;
  let publicKeyB64: string;
  if (stored) {
    keyPair = {
      publicKey: importPublicKey(stored.publicKeyB64),
      secretKey: importSecretKey(stored.secretKeyB64),
    };
    publicKeyB64 = exportPublicKey(keyPair.publicKey);
    log?.info({ filePath }, "Loaded daemon keypair");
  } else {
    keyPair = generateKeyPair();
    publicKeyB64 = exportPublicKey(keyPair.publicKey);
    const generated: StoredKeyPair = {
      v: 2,
      publicKeyB64,
      secretKeyB64: exportSecretKey(keyPair.secretKey),
    };
    writePrivateFileAtomicSync(filePath, JSON.stringify(generated, null, 2) + "\n");
    log?.info({ filePath }, "Saved daemon keypair");
    stored = generated;
  }

  let relayPublicKeyB64url: string | null = null;
  let current = stored;

  const ensureRelayIdentity = (): RelayOwnershipSigner => {
    if (current.relayPublicKeyB64 && current.relaySecretKeyB64) {
      const signer = createRelaySigner(current.relayPublicKeyB64, current.relaySecretKeyB64);
      relayPublicKeyB64url = signer.publicKeyB64url;
      return signer;
    }
    const generated = generateKeyPairSync("ed25519");
    const relaySecretKeyB64 = Buffer.from(
      ed25519JwkField(generated.privateKey, "d"),
      "base64url",
    ).toString("base64");
    const relayPublicKeyB64 = Buffer.from(
      ed25519JwkField(generated.publicKey, "x"),
      "base64url",
    ).toString("base64");
    current = { ...current, relayPublicKeyB64, relaySecretKeyB64 };
    writePrivateFileAtomicSync(filePath, JSON.stringify(current, null, 2) + "\n");
    log?.info({ filePath }, "Generated relay identity key");
    const signer = createRelaySigner(relayPublicKeyB64, relaySecretKeyB64);
    relayPublicKeyB64url = signer.publicKeyB64url;
    return signer;
  };

  if (current.relayPublicKeyB64 && current.relaySecretKeyB64) {
    relayPublicKeyB64url = createRelaySigner(
      current.relayPublicKeyB64,
      current.relaySecretKeyB64,
    ).publicKeyB64url;
  }

  return {
    keyPair,
    publicKeyB64,
    get relayPublicKeyB64url() {
      return relayPublicKeyB64url;
    },
    ensureRelayIdentity,
  };
}
