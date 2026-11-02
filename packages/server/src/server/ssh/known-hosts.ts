import { createHash } from "node:crypto";
import type { SshKnownHost } from "@jagentdesk/protocol/ssh/rpc-schemas";

// Spec 25.2/25.3 host-key trust (ADR-0027 §3). Entries are keyed by host+port+keyType.
// - A stored entry with the presented key → `match` (lastSeenAtMs refreshes).
// - Nothing stored for host:port → `unknown` (TOFU prompt).
// - Anything stored for host:port that is not the presented key → `mismatch`
//   (blocked with both fingerprints). That includes a *different key type*: a server
//   that suddenly offers another algorithm is treated as a changed key, not a new host,
//   so a spoofing server cannot dodge the check by picking an algorithm we never saw.
// Pure over an entry list so the policy is unit-testable without a socket.
//
// Fingerprints are `SHA256:<base64>` over the raw public-key blob — byte-identical
// to `ssh-keygen -lf`, whose base64 has no `=` padding.

export function hostKeyFingerprint(publicKeyBlob: Buffer): string {
  const digest = createHash("sha256").update(publicKeyBlob).digest("base64");
  return `SHA256:${digest.replace(/=+$/, "")}`;
}

export function knownHostId(host: string, port: number, keyType: string): string {
  return `${host.toLowerCase()}:${port}:${keyType}`;
}

export interface PresentedHostKey {
  host: string;
  port: number;
  keyType: string;
  /** base64 of the wire public-key blob */
  publicKey: string;
}

export type HostKeyEvaluation =
  | { kind: "match"; entry: SshKnownHost }
  | { kind: "unknown"; entry: SshKnownHost }
  | {
      kind: "mismatch";
      entry: SshKnownHost;
      storedFingerprint: string;
      receivedFingerprint: string;
    };

export function buildKnownHostEntry(presented: PresentedHostKey, nowMs: number): SshKnownHost {
  return {
    host: presented.host,
    port: presented.port,
    keyType: presented.keyType,
    publicKey: presented.publicKey,
    fingerprintSha256: hostKeyFingerprint(Buffer.from(presented.publicKey, "base64")),
    addedAtMs: nowMs,
  };
}

export function sameHostPort(entry: SshKnownHost, host: string, port: number): boolean {
  return entry.host.toLowerCase() === host.toLowerCase() && entry.port === port;
}

export function evaluateHostKey(
  entries: readonly SshKnownHost[],
  presented: PresentedHostKey,
  nowMs = Date.now(),
): HostKeyEvaluation {
  const received = buildKnownHostEntry(presented, nowMs);
  const forHost = entries.filter((entry) => sameHostPort(entry, presented.host, presented.port));
  if (forHost.length === 0) return { kind: "unknown", entry: received };
  const sameType = forHost.find((entry) => entry.keyType === presented.keyType);
  if (sameType && sameType.fingerprintSha256 === received.fingerprintSha256) {
    return { kind: "match", entry: { ...sameType, lastSeenAtMs: nowMs } };
  }
  const stored = sameType ?? forHost[0];
  return {
    kind: "mismatch",
    entry: stored,
    storedFingerprint: stored.fingerprintSha256,
    receivedFingerprint: received.fingerprintSha256,
  };
}

/** Algorithm name from a wire public-key blob: uint32 length + ASCII name. */
export function publicKeyAlgo(blob: Buffer): string {
  if (blob.length < 4) throw new Error("malformed public key blob");
  const length = blob.readUInt32BE(0);
  if (length <= 0 || blob.length < 4 + length) throw new Error("malformed public key blob");
  return blob.subarray(4, 4 + length).toString("ascii");
}
