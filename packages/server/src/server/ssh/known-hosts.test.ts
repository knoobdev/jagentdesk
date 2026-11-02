import { describe, expect, it } from "vitest";
import { utils } from "ssh2";
import type { ParsedKey } from "ssh2";
import {
  buildKnownHostEntry,
  evaluateHostKey,
  hostKeyFingerprint,
  publicKeyAlgo,
} from "./known-hosts.js";

function newPublicBlob(type: "ed25519" | "ecdsa"): Buffer {
  const pair = utils.generateKeyPairSync(
    type as "ed25519",
    type === "ecdsa" ? ({ bits: 256 } as never) : {},
  );
  return (utils.parseKey(pair.public) as ParsedKey).getPublicSSH();
}

describe("known hosts policy (spec 25.3 step 3)", () => {
  const keyA = newPublicBlob("ed25519");
  const keyB = newPublicBlob("ed25519");
  const keyEcdsa = newPublicBlob("ecdsa");
  const at = (blob: Buffer) => ({
    host: "<host>",
    port: 22,
    keyType: publicKeyAlgo(blob),
    publicKey: blob.toString("base64"),
  });
  const stored = buildKnownHostEntry(at(keyA), 1_000);

  it("fingerprints like ssh-keygen -lf (SHA256:, unpadded base64)", () => {
    expect(hostKeyFingerprint(keyA)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("unknown when nothing is stored for host:port", () => {
    expect(evaluateHostKey([], at(keyA), 2_000)).toEqual({
      kind: "unknown",
      entry: { ...stored, addedAtMs: 2_000 },
    });
  });

  it("match refreshes lastSeenAtMs; host names compare case-insensitively", () => {
    expect(evaluateHostKey([stored], { ...at(keyA), host: "<HOST>" }, 3_000)).toEqual({
      kind: "match",
      entry: { ...stored, lastSeenAtMs: 3_000 },
    });
  });

  it("a changed key of the same type is a mismatch carrying both fingerprints", () => {
    expect(evaluateHostKey([stored], at(keyB), 4_000)).toEqual({
      kind: "mismatch",
      entry: stored,
      storedFingerprint: hostKeyFingerprint(keyA),
      receivedFingerprint: hostKeyFingerprint(keyB),
    });
  });

  it("a different key type for a known host is a mismatch too", () => {
    const result = evaluateHostKey([stored], at(keyEcdsa), 5_000);
    expect(result.kind).toBe("mismatch");
  });

  it("a different port is a different host", () => {
    expect(evaluateHostKey([stored], { ...at(keyB), port: 2222 }).kind).toBe("unknown");
  });
});
